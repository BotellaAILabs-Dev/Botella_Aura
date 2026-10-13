import type { ContentDraft, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { copyParts } from '@/lib/content-quality';
import { ctaRequired, FORMAT_SPECS } from '@/lib/content-formats';
import { playbookFor } from '@/lib/content-playbook';
import { redactSensitive } from '@/lib/generation-context';
import type { ContentBrief } from '@/lib/content-brief';
import {
  bodyHash,
  buildReviewerPrompt,
  combineReview,
  isReviewCurrent,
  REVIEWER_SYSTEM,
  reviewerOutputSchema,
  type ContentReview,
  type ReviewerInput,
  type ReviewerOutput,
  type ReviewTrigger,
} from '@/lib/content-review';
import { bodySchemaFor, type ContentTypeKey } from '@/lib/validations/content';
import {
  aiFailureMessage,
  ClaudeNotConfiguredError,
  completeStructured,
  getModel,
} from '@/server/ai/claude';
import {
  assessDraft,
  chunkText,
  loadWritingContext,
  writingPlatform,
} from '@/server/content/quality.service';
import { factCheckDraft } from '@/server/content/fact-check.service';
import { withReviewTrace } from '@/server/trace/trace.service';
import { getPolicyContext } from '@/server/content/compliance.service';
import { checkCompliance } from '@/lib/compliance-policy';
import type { SocialPlatformKey } from '@/lib/platforms';

/**
 * The AI Reviewer, run for a draft (lib/content-review.ts): the deterministic
 * rules, the fact check and an independent model review, combined into one
 * structured result stored on the draft (aiMetadata.review, with the last few
 * in aiMetadata.reviewHistory).
 *
 * The reviewer reads the draft and writes only aiMetadata — the body, title
 * and status are never touched, so a review cannot silently change content.
 */

/** How long the independent review may take before the piece goes to a person instead. */
export const REVIEW_TIMEOUT_MS = 25_000;
const HISTORY_LIMIT = 5;

/** Placeholder text a finished piece must not contain. */
const PLACEHOLDER =
  /\[(?:insert|add|your|link|name|date|price)[^\]]*\]|\{\{[^}]+\}\}|lorem ipsum|\bTBD\b|\bTODO\b|XX+%?/i;

type Meta = Record<string, unknown>;
type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> | null }
  : T;

/** The stored review, if any. */
export function storedReview(
  draft: Pick<ContentDraft, 'aiMetadata'>,
): ContentReview | null {
  const r = ((draft.aiMetadata ?? {}) as Meta).review;
  return r && typeof r === 'object' ? (r as ContentReview) : null;
}

/**
 * The stored review, when it still describes the draft's body and was made
 * under the rules now in force (`policyHash`, when given).
 */
export function currentReview(
  draft: Pick<ContentDraft, 'aiMetadata' | 'body'>,
  policyHash?: string,
): ContentReview | null {
  const r = storedReview(draft);
  return isReviewCurrent(r, draft.body, policyHash) ? r : null;
}

/** Parts the format requires that are missing, empty or placeholders. */
export function missingParts(type: ContentTypeKey, body: unknown): string[] {
  const missing = new Set<string>();
  const parsed = bodySchemaFor(type).safeParse(body);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      missing.add(
        i.path.filter((p) => typeof p === 'string').join('.') || 'content',
      );
    }
  }
  const text = copyParts(type, body).text;
  if (!text.trim()) missing.add('content');
  const ph = text.match(PLACEHOLDER);
  if (ph) missing.add(`real text in place of the placeholder “${ph[0]}”`);
  return [...missing];
}

async function reviewerInputFor(draft: ContentDraft): Promise<{
  input: ReviewerInput;
  ctaChecked: boolean;
  platform: SocialPlatformKey | null;
  competitors: string[];
}> {
  const type = draft.type as ContentTypeKey;
  const meta = (draft.aiMetadata ?? {}) as Meta;
  // A stored brief may be partial (an older draft, or evidence only), so
  // every field is read as optional.
  const brief = (meta.brief ?? null) as DeepPartial<ContentBrief> | null;
  const source = (meta.source ?? {}) as { brief?: string | null };
  const w = await loadWritingContext(draft.companyId, {
    campaignId: draft.campaignId,
  });
  const platform = writingPlatform(type, draft.platform);
  const playbook = playbookFor(type, platform);
  const parts = copyParts(type, draft.body);
  const ctx = w.context;
  const voice = ctx?.voice.profile ?? null;
  const knowledge = redactSensitive(
    await chunkText(draft.companyId, meta.knowledgeChunkIds),
    { personal: true },
  ).text;
  const ctaExpected = brief?.cta?.expected ?? null;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const evidence = (Array.isArray(brief?.evidence) ? brief.evidence : [])
    .filter((e) => e?.label)
    .map((e) => `${e!.label}${e!.detail ? ` — ${e!.detail}` : ''}`);

  const input: ReviewerInput = {
    format: FORMAT_SPECS[type].label,
    channel:
      brief?.channel?.name ??
      (platform ? platform.charAt(0) + platform.slice(1).toLowerCase() : null),
    text: parts.text,
    cta: parts.cta,
    hashtags: parts.hashtags,
    limits: {
      maxChars: playbook.limits.hardMaxChars,
      idealMaxChars: playbook.limits.softMaxChars,
    },
    business: {
      name: w.company.name,
      industry: ctx?.identity.industry ?? w.company.industry ?? null,
      description: ctx?.identity.description ?? null,
      offerings: ctx?.identity.offerings ?? null,
    },
    audience:
      brief?.targetAudience?.value ??
      ctx?.audience.stated ??
      w.campaign?.targetAudience ??
      null,
    goal:
      brief?.marketingGoal?.value ??
      w.campaign?.goal ??
      ctx?.objectives.goals ??
      null,
    brandVoice: brief?.brandVoice
      ? {
          summary: brief.brandVoice.summary ?? null,
          tone: strings(brief.brandVoice.tone),
          phrases: strings(brief.brandVoice.phrases),
          avoid: strings(brief.brandVoice.avoid),
        }
      : voice
        ? {
            summary: voice.summary || null,
            tone: voice.toneDescriptors,
            phrases: voice.commonPhrases,
            avoid: voice.topicsToAvoid,
          }
        : null,
    recommendation:
      brief?.recommendation?.title || evidence.length
        ? {
            title: brief?.recommendation?.title ?? 'Aura’s suggestion',
            action: brief?.recommendedAction?.action ?? null,
            keyMessage: brief?.keyMessage?.value ?? null,
            reason: brief?.reason?.why ?? null,
            expectedOutcome: brief?.expectedOutcome?.outcome ?? null,
            ctaExpected,
            ctaGuidance: brief?.cta?.guidance ?? null,
            ctaDestination: brief?.cta?.destination?.value ?? null,
            evidence,
          }
        : null,
    request: source.brief ?? null,
    facts: knowledge.slice(0, 3000),
    alcohol: w.alcohol,
  };
  return {
    input,
    ctaChecked: ctaRequired(type, ctaExpected),
    platform,
    // The writing context does not load the market section; the names are
    // all the compliance check needs.
    competitors: (
      await db.competitorProfile.findMany({
        where: { companyId: draft.companyId },
        select: { name: true },
      })
    ).map((c) => c.name),
  };
}

async function runReviewer(input: ReviewerInput): Promise<{
  ai: ReviewerOutput | null;
  model: string | null;
  unavailable: string | null;
}> {
  try {
    const ai = await completeStructured({
      schema: reviewerOutputSchema,
      system: REVIEWER_SYSTEM,
      prompt: buildReviewerPrompt(input),
      maxTokens: 2500,
      effort: 'low',
      tier: 'standard',
      timeoutMs: REVIEW_TIMEOUT_MS,
      maxAttempts: 1,
    });
    return { ai, model: getModel('standard'), unavailable: null };
  } catch (err) {
    logger.warn('review: the independent reviewer did not run', {
      error: err instanceof Error ? err.message.slice(0, 300) : String(err),
    });
    const unavailable =
      err instanceof ClaudeNotConfiguredError
        ? 'no AI reviewer is configured'
        : (err as { status?: number })?.status === 429
          ? 'the AI provider is at its limit'
          : aiFailureMessage(err)
            ? 'the AI provider did not answer'
            : 'its answer could not be read';
    return { ai: null, model: null, unavailable };
  }
}

/**
 * Review a draft as it stands and store the result. Never changes the body.
 * `ai: false` skips the model (rules and fact check only — marked as needing
 * a person).
 */
export async function reviewDraft(
  draft: ContentDraft,
  options: { trigger: ReviewTrigger; ai?: boolean },
): Promise<{ draft: ContentDraft; review: ContentReview }> {
  const started = Date.now();
  const type = draft.type as ContentTypeKey;
  const hash = bodyHash(draft.body);
  const { input, ctaChecked, platform, competitors } =
    await reviewerInputFor(draft);

  const [quality, factCheck, model, policy] = await Promise.all([
    assessDraft(draft, draft.body, { ctaRequired: ctaChecked }),
    factCheckDraft(draft),
    options.ai === false
      ? Promise.resolve({
          ai: null,
          model: null,
          unavailable: 'it was skipped',
        })
      : runReviewer(input),
    getPolicyContext(draft.companyId),
  ]);

  // The compliance & policy checks (lib/compliance-policy.ts), under the
  // workspace's rules as they stand now.
  const subject = (draft.body as { subjectLine?: unknown } | null)?.subjectLine;
  const compliance = checkCompliance({
    type,
    platform: platform as SocialPlatformKey | null,
    text: [input.text, input.hashtags.join(' ')].join('\n'),
    cta: input.cta,
    subject: typeof subject === 'string' ? subject : null,
    policy: policy.policy,
    alcohol: policy.alcohol,
    website: policy.website,
    competitors,
    rules: quality.issues,
    claims: factCheck.claims,
  });

  const review = combineReview({
    rules: quality.issues,
    ctaChecked,
    factCheck,
    missing: missingParts(type, draft.body),
    ai: model.ai,
    aiModel: model.model,
    aiUnavailable: model.unavailable,
    text: [input.text, input.cta, input.hashtags.join(' ')].join('\n'),
    bodyHash: hash,
    trigger: options.trigger,
    compliance,
    durationMs: Date.now() - started,
  });

  // Store it on the latest copy of the metadata, never the body.
  const latest = await db.contentDraft.findUnique({ where: { id: draft.id } });
  if (!latest) return { draft, review };
  const meta = (latest.aiMetadata ?? {}) as Meta;
  const previous = storedReview(latest);
  const history = [
    ...(previous
      ? [
          {
            status: previous.status,
            score: previous.score,
            failed: previous.failed,
            reviewedAt: previous.reviewedAt,
            trigger: previous.trigger,
            bodyHash: previous.bodyHash,
          },
        ]
      : []),
    ...((Array.isArray(meta.reviewHistory)
      ? meta.reviewHistory
      : []) as unknown[]),
  ].slice(0, HISTORY_LIMIT);

  const updated = await db.contentDraft.update({
    where: { id: draft.id },
    data: {
      // The trace records which version this review was of (lib/trace.ts).
      aiMetadata: withReviewTrace(latest, { ...meta, review, reviewHistory: history }, review) as unknown as Prisma.InputJsonValue,
    },
  });
  return { draft: updated, review };
}

/** The current review, running one if there is none for this body. */
export async function ensureReview(
  draft: ContentDraft,
  trigger: ReviewTrigger,
): Promise<{ draft: ContentDraft; review: ContentReview }> {
  // Current means: this body, under the compliance rules in force now.
  const { hash } = await getPolicyContext(draft.companyId);
  const current = currentReview(draft, hash);
  if (current) return { draft, review: current };
  return reviewDraft(draft, { trigger });
}

/**
 * Review a draft that was just written, without ever failing the write: if
 * the review itself breaks, the draft stays as it is and is reviewed when it
 * is submitted.
 */
export async function reviewAfterWrite(
  draft: ContentDraft,
  trigger: ReviewTrigger,
): Promise<ContentDraft> {
  try {
    return (await reviewDraft(draft, { trigger })).draft;
  } catch (err) {
    logger.warn(
      'review: could not review a new draft; it will be reviewed on submit',
      {
        draftId: draft.id,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return draft;
  }
}
