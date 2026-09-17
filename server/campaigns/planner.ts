import type { Company } from '@prisma/client';
import {
  completeStructured,
  isClaudeConfigured,
  DEFAULT_MODEL,
} from '@/server/ai/claude';
import { logger } from '@/lib/logger';
import {
  getBrandVoiceProfile,
  brandVoiceToPrompt,
} from '@/server/content/brand-voice.service';
import { getActiveMemories, memoriesToPrompt } from '@/server/memory/memory.service';
import {
  getBrandContext,
  brandContextToPrompt,
} from '@/server/brand/brand-context.service';
import {
  campaignPlanSchema,
  type CampaignPlan,
  type CreateCampaignInput,
} from '@/lib/validations/campaign';
import { CONTENT_TYPES } from '@/lib/validations/content';

/**
 * Campaign planning engine (Sprint 6, Module 1). ONE substantial Claude call
 * produces a validated day-by-day plan grounded in brand voice + marketing
 * memory + the campaign goal. The planner NEVER generates content or sends
 * anything — it only produces the plan, which becomes CampaignTask rows that
 * later trigger the existing Sprint 3-5 pipelines. Deterministic fallback when
 * Claude isn't configured.
 */
export async function generateCampaignPlan(args: {
  company: Company;
  userId: string;
  input: CreateCampaignInput;
}): Promise<{ plan: CampaignPlan; model: string }> {
  const { company, userId, input } = args;

  if (!isClaudeConfigured()) {
    return { plan: deterministicPlan(input), model: 'none' };
  }

  try {
    const [voice, memories, brand] = await Promise.all([
      getBrandVoiceProfile(company),
      getActiveMemories(company.id),
      /**
       * The workspace profile the user already filled in.
       *
       * A campaign plan decides what to write about, so it needs to know what
       * the company sells and who buys it just as much as the content step
       * does — and it had neither. Planning without that produces a month of
       * topics aimed at a reader nobody described.
       *
       * No knowledge query: this call shapes a schedule rather than writing a
       * specific piece, so grounding passages would be cost without benefit.
       */
      getBrandContext(company.id),
    ]);
    const memoryBlock = memoriesToPrompt(memories);
    // Voice comes from the block below; writing rules do not apply to a plan.
    const brandBlock = brandContextToPrompt(brand, {
      includeVoice: false,
      includeWritingRules: false,
    });

    const system = [
      `You are the head of marketing for ${company.name}, planning a ${input.durationDays}-day campaign.`,
      brandBlock,
      voice ? brandVoiceToPrompt(voice) : '',
      memoryBlock,
      'Design a realistic day-by-day plan. Do NOT post every day — space content ' +
        'sensibly (2-4 posts/week is healthy). Only use enabled modules. For each ' +
        'active day set a contentType + a specific topic/angle tied to the goal, ' +
        'and/or outreach/discovery flags, plus a one-line rationale. Respond with ' +
        'ONLY JSON matching the schema: { overview, days: [{ day, contentType, ' +
        `topic, outreach, discovery, rationale }] }. contentType must be one of ${CONTENT_TYPES.join('/')} or null.`,
    ]
      .filter(Boolean)
      .join('\n');

    const prompt = [
      `GOAL: ${input.goal}`,
      `DURATION: ${input.durationDays} days`,
      `ENABLED MODULES: ${JSON.stringify(input.modules)}`,
      /**
       * The campaign form's own audience field, falling back to the workspace
       * profile — so a user who described their buyer once during onboarding
       * does not have to type it again for every campaign. An explicit value
       * still wins: a campaign may deliberately target a narrower group.
       */
      input.targetAudience
        ? `AUDIENCE FOR THIS CAMPAIGN: ${input.targetAudience}`
        : brand?.audience?.stated
          ? `AUDIENCE: ${brand.audience.stated}`
          : '',
      input.themes.length ? `THEMES TO EMPHASIZE: ${input.themes.join(', ')}` : '',
      `Produce a day-by-day plan for days 1..${input.durationDays}.`,
    ]
      .filter(Boolean)
      .join('\n');

    const plan = await completeStructured({
      schema: campaignPlanSchema,
      system,
      prompt,
      maxTokens: 4000,
      effort: 'high',
    });

    // Enforce module gating even if the model over-reached.
    const gated = gatePlan(plan, input);
    return { plan: gated, model: DEFAULT_MODEL };
  } catch (err) {
    logger.warn('campaign planner: AI plan failed, using deterministic', {
      companyId: company.id,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { plan: deterministicPlan(input), model: 'none' };
  }
}

/** Strip module actions the user didn't enable, and bound days to the window. */
function gatePlan(plan: CampaignPlan, input: CreateCampaignInput): CampaignPlan {
  const days = plan.days
    .filter((d) => d.day >= 1 && d.day <= input.durationDays)
    .map((d) => ({
      ...d,
      contentType: input.modules.content ? d.contentType : null,
      outreach: input.modules.outreach ? d.outreach : false,
      discovery: input.modules.discovery ? d.discovery : false,
    }));
  return { overview: plan.overview, days };
}

/** Deterministic cadence used when Claude is unavailable. */
export function deterministicPlan(input: CreateCampaignInput): CampaignPlan {
  const days: CampaignPlan['days'] = [];
  const themes = input.themes.length ? input.themes : ['your key message'];
  const contentDays = new Set([1, 3, 5]); // Mon/Wed/Fri-ish each week (mod 7)

  for (let day = 1; day <= input.durationDays; day++) {
    const dow = ((day - 1) % 7) + 1;
    const theme = themes[(day - 1) % themes.length]!;
    const entry: CampaignPlan['days'][number] = {
      day,
      contentType: null,
      outreach: false,
      discovery: false,
    };
    if (input.modules.content && contentDays.has(dow)) {
      entry.contentType = day % 6 === 0 ? 'CAROUSEL' : 'LINKEDIN_POST';
      entry.topic = `${theme} — angle ${Math.ceil(day / 7)}`;
      entry.rationale = `Advance the goal: ${input.goal.slice(0, 60)}`;
    }
    if (input.modules.outreach && dow === 2) {
      entry.outreach = true;
      entry.rationale = (entry.rationale ? entry.rationale + '; ' : '') + 'weekly outreach batch';
    }
    if (input.modules.discovery && dow === 4 && day <= 21) {
      entry.discovery = true;
    }
    days.push(entry);
  }
  return {
    overview: `A ${input.durationDays}-day plan toward: ${input.goal}. Content ${
      input.modules.content ? 'on a steady weekly cadence' : 'off'
    }${input.modules.outreach ? ', weekly outreach batches' : ''}${
      input.modules.discovery ? ', and periodic lead discovery' : ''
    }.`,
    days,
  };
}
