import type { Company } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { isClaudeConfigured } from '@/server/ai/claude';
import { generateDraft } from '@/server/content/generator';
import { generateGraphics } from '@/server/media/generation.service';
import { attachAsset } from '@/server/media/asset.service';
import {
  generateImagePrompt,
  coerceStyle,
} from '@/server/media/image-prompt.service';
import { isAnyProviderConfigured } from '@/server/media/providers';
import { getEffectivePlan } from '@/server/billing/entitlements';
import { assetsThisMonth } from '@/server/media/asset.service';
import { startOfIsoWeekUTC } from '@/server/competitors/report.service';
import { resolvePlatform } from '@/lib/platforms';
import { generateBriefing } from '@/server/briefing/briefing.service';
import type { BriefingActivity } from '@/lib/validations/briefing';
import type { ContentTypeKey } from '@/lib/validations/content';
import type { PlanItem } from '@/lib/validations/planner';
import type { DigestPayload } from '@/server/trends/types';

/**
 * Autopilot — the part that makes Aura an employee rather than a toolbox.
 *
 * Once a week, for each workspace, this writes the posts the plan called for
 * and generates a graphic for each, so that opening the app on Monday shows
 * finished work rather than an invitation to start some.
 *
 * It spends real money, which shapes every decision in this file:
 *
 *   · It is OPT-OUT per workspace (Company.preferences.autopilot). Autonomous
 *     spending with no off switch is not a feature.
 *   · It never exceeds the plan's monthly image allowance, and DEGRADES rather
 *     than failing — out of images means posts still get written, without
 *     graphics, and the briefing says so.
 *   · It is idempotent per week. A second run in the same week produces
 *     nothing new, so a retried cron cannot double-bill.
 *   · Everything it produces lands in DRAFT. The approval gate is untouched;
 *     an autonomous agent that could publish would be a different, much more
 *     dangerous product.
 */

/** How many posts to write per workspace per week, absent a plan. */
const DEFAULT_WEEKLY_POSTS = 3;
/** Hard ceiling regardless of plan, so a bad config cannot run away. */
const MAX_WEEKLY_POSTS = 5;

export interface AutopilotSettings {
  enabled: boolean;
  /** Posts to write per week. */
  postsPerWeek: number;
  /** Whether to also generate a graphic for each post. */
  generateGraphics: boolean;
}

/**
 * Autopilot settings for a workspace.
 *
 * Stored in `Company.preferences`, the extensible JSON bag this schema already
 * keeps for exactly this purpose — so enabling a per-workspace switch needs no
 * migration. Defaults are ON, because a workspace that has asked for an
 * autonomous agent should get one without further configuration.
 */
export function readAutopilotSettings(company: Pick<Company, 'preferences'>): AutopilotSettings {
  const prefs = (company.preferences ?? {}) as Record<string, unknown>;
  const raw = (prefs.autopilot ?? {}) as Record<string, unknown>;

  const postsPerWeek =
    typeof raw.postsPerWeek === 'number' && Number.isFinite(raw.postsPerWeek)
      ? Math.max(0, Math.min(MAX_WEEKLY_POSTS, Math.floor(raw.postsPerWeek)))
      : DEFAULT_WEEKLY_POSTS;

  return {
    enabled: raw.enabled !== false,
    postsPerWeek,
    generateGraphics: raw.generateGraphics !== false,
  };
}

export interface AutopilotResult {
  companyId: string;
  ran: boolean;
  reason?: string;
  activity: BriefingActivity;
}

/**
 * Run the weekly cycle for one workspace: write the week's posts, illustrate
 * them, then assemble the briefing.
 *
 * Never throws for a single-workspace problem — the cron runs this across every
 * company, and one bad workspace must not stop the rest.
 */
export async function runAutopilot(args: {
  companyId: string;
  userId?: string | null;
  /** Skip the "already ran this week" check. Used by a manual "run now". */
  force?: boolean;
}): Promise<AutopilotResult> {
  const { companyId, userId, force = false } = args;
  const startedAt = new Date();
  const activity: BriefingActivity = {
    draftsWritten: 0,
    graphicsGenerated: 0,
    skipped: [],
    errors: [],
    startedAt: startedAt.toISOString(),
    finishedAt: '',
  };

  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) {
    return { companyId, ran: false, reason: 'Company not found.', activity };
  }

  const settings = readAutopilotSettings(company);
  if (!settings.enabled) {
    // Still assemble the briefing — a workspace that has turned off autonomous
    // WRITING still wants the summary of what happened.
    await generateBriefing({ companyId, userId, activity });
    return { companyId, ran: false, reason: 'Autopilot is off for this workspace.', activity };
  }

  const weekStart = startOfIsoWeekUTC(new Date());
  if (!force) {
    const existing = await db.workspaceBriefing.findUnique({
      where: { companyId_weekStart: { companyId, weekStart } },
    });
    // Idempotent per week: a retried cron must not write a second set of posts.
    if (existing && existing.status !== 'FAILED') {
      await generateBriefing({ companyId, userId, activity });
      return {
        companyId,
        ran: false,
        reason: 'Already ran for this week.',
        activity,
      };
    }
  }

  await db.workspaceBriefing.upsert({
    where: { companyId_weekStart: { companyId, weekStart } },
    create: {
      companyId,
      weekStart,
      weekEnd: new Date(weekStart.getTime() + 7 * 86_400_000 - 1),
      status: 'WORKING',
    },
    update: { status: 'WORKING', error: null },
  });

  try {
    await writeWeeklyContent({ company, settings, activity, userId: userId ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('autopilot: run failed', { companyId, error: message });
    activity.errors.push(message.slice(0, 300));
  }

  activity.finishedAt = new Date().toISOString();
  await generateBriefing({ companyId, userId, activity, status: 'READY' });

  await recordAudit({
    action: 'AUTOPILOT_RUN',
    userId: userId ?? null,
    companyId,
    metadata: {
      drafts: activity.draftsWritten,
      graphics: activity.graphicsGenerated,
      skipped: activity.skipped.length,
      errors: activity.errors.length,
    },
  });

  return { companyId, ran: true, activity };
}

/**
 * Write (and illustrate) this week's posts.
 *
 * The brief for each post comes from the marketing plan when there is one, and
 * from the latest trend digest when there is not — both are real signals the
 * workspace already produced. When there is neither, the agent writes nothing
 * and says so, rather than inventing topics out of thin air.
 */
async function writeWeeklyContent(args: {
  company: Company;
  settings: AutopilotSettings;
  activity: BriefingActivity;
  userId: string | null;
}): Promise<void> {
  const { company, settings, activity, userId } = args;

  if (settings.postsPerWeek === 0) {
    activity.skipped.push('Writing is set to 0 posts per week for this workspace.');
    return;
  }
  if (!isClaudeConfigured()) {
    activity.skipped.push(
      'No AI provider configured (ANTHROPIC_API_KEY or GEMINI_API_KEY), so no posts were written.',
    );
    return;
  }

  const briefs = await collectBriefs(company.id, settings.postsPerWeek);
  if (briefs.length === 0) {
    activity.skipped.push(
      'No marketing plan or trend digest to work from, so there was nothing to write about. Generate a plan, or enable trend sources.',
    );
    return;
  }

  // Resolve the image budget ONCE, before writing anything: it decides whether
  // graphics are attempted at all, and the briefing needs to explain it.
  const imageBudget = settings.generateGraphics
    ? await resolveImageBudget(company.id, briefs.length)
    : { allowed: 0, reason: 'Graphics are turned off for this workspace.' };

  if (imageBudget.allowed === 0 && imageBudget.reason) {
    activity.skipped.push(imageBudget.reason);
  }

  let graphicsRemaining = imageBudget.allowed;

  for (const brief of briefs) {
    try {
      const draft = await generateDraft({
        companyId: company.id,
        userId,
        type: brief.contentType,
        source: { kind: 'BRIEF', brief: brief.brief },
      });
      activity.draftsWritten++;

      if (graphicsRemaining > 0) {
        const made = await illustrate({
          draftId: draft.id,
          companyId: company.id,
          userId,
        });
        if (made) {
          activity.graphicsGenerated++;
          graphicsRemaining--;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('autopilot: post failed', { companyId: company.id, error: message });
      activity.errors.push(`Could not write "${brief.title}": ${message}`.slice(0, 300));
    }
  }
}

interface WeeklyBrief {
  title: string;
  brief: string;
  contentType: ContentTypeKey;
}

/**
 * What to write about this week, drawn from what the workspace already has.
 *
 * Plan items first (they were designed against stated objectives), then trend
 * items (timely, and already scored and summarised by the digest pipeline).
 */
async function collectBriefs(
  companyId: string,
  limit: number,
): Promise<WeeklyBrief[]> {
  const briefs: WeeklyBrief[] = [];
  const weekStart = startOfIsoWeekUTC(new Date());
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);

  const plan = await db.marketingPlan.findFirst({
    where: { companyId },
    orderBy: { month: 'desc' },
  });
  const planItems = readPlanItems(plan?.payload);
  for (const item of planItems) {
    const date = new Date(`${item.date}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date < weekStart || date >= weekEnd) continue;
    briefs.push({
      title: item.title,
      contentType: item.contentType,
      brief: [
        item.brief,
        item.hook ? `Open with this angle: ${item.hook}` : '',
        item.cta ? `Close with: ${item.cta}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
    if (briefs.length >= limit) return briefs;
  }

  // Fall back to the latest trend digest — real, scored, already summarised.
  const digest = await db.trendDigest.findFirst({
    where: { companyId },
    orderBy: { date: 'desc' },
  });
  const items = (digest?.payload as unknown as DigestPayload | undefined)?.items ?? [];
  for (const item of items.slice(0, limit - briefs.length)) {
    briefs.push({
      title: item.title,
      contentType: 'LINKEDIN_POST',
      brief: `Write about this trend: "${item.title}".\n${item.aiSummary ?? ''}\nSuggested angle: ${item.suggestedAngle ?? ''}`,
    });
  }

  return briefs;
}

function readPlanItems(payload: unknown): PlanItem[] {
  if (!payload || typeof payload !== 'object') return [];
  const items = (payload as { items?: unknown }).items;
  return Array.isArray(items) ? (items as PlanItem[]) : [];
}

/**
 * How many graphics this run may generate.
 *
 * The plan's monthly allowance is a hard budget, and autopilot must never be
 * the reason a workspace hits it — a person clicking Generate should not find
 * their allowance already spent by the overnight run. So it takes what is left,
 * capped at what this run actually needs.
 */
async function resolveImageBudget(
  companyId: string,
  wanted: number,
): Promise<{ allowed: number; reason?: string }> {
  if (!isAnyProviderConfigured()) {
    return {
      allowed: 0,
      reason:
        'No image provider configured, so posts were written without graphics. Add an API key to enable them.',
    };
  }

  const plan = await getEffectivePlan(companyId);
  if (!plan.active) {
    return {
      allowed: 0,
      reason: 'Subscription is not active, so no graphics were generated.',
    };
  }

  const used = await assetsThisMonth(companyId);
  const remaining = Math.max(0, plan.limits.maxImagesPerMonth - used);
  if (remaining === 0) {
    return {
      allowed: 0,
      reason: `This month's ${plan.limits.maxImagesPerMonth}-graphic allowance is used up, so posts were written without them.`,
    };
  }

  const allowed = Math.min(wanted, remaining);
  return allowed < wanted
    ? {
        allowed,
        reason: `Only ${remaining} graphic${remaining === 1 ? '' : 's'} left in this month's allowance, so ${allowed} of ${wanted} posts got one.`,
      }
    : { allowed };
}

/**
 * Write a prompt for a draft, generate one image, and attach it.
 *
 * Returns false rather than throwing when it does not work out: a post without
 * a picture is a fine outcome, and losing the post because the picture failed
 * is not.
 */
async function illustrate(args: {
  draftId: string;
  companyId: string;
  userId: string | null;
}): Promise<boolean> {
  const { draftId, companyId, userId } = args;
  try {
    const draft = await db.contentDraft.findFirst({
      where: { id: draftId, companyId },
    });
    if (!draft) return false;

    const platform = resolvePlatform(draft.type as ContentTypeKey, draft.platform);
    const prompt = await generateImagePrompt({
      draft,
      userId,
      platform,
      style: coerceStyle('professional'),
    });

    const result = await generateGraphics({
      draft,
      userId,
      prompt: prompt.prompt,
      ...(prompt.negativePrompt ? { negativePrompt: prompt.negativePrompt } : {}),
      originalPrompt: prompt.prompt,
      style: coerceStyle('professional'),
      // Exactly one. Variations are a human choice; an agent picking four would
      // quadruple the spend for a decision nobody asked it to make.
      variations: 1,
    });

    const asset = result.assets[0];
    if (!asset) return false;

    await attachAsset({
      companyId,
      userId,
      draftId,
      assetId: asset.id,
      replace: true,
    });
    return true;
  } catch (err) {
    logger.warn('autopilot: could not illustrate draft (post kept)', {
      draftId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
