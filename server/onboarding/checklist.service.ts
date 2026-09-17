import { db } from '@/lib/db';
import {
  ONBOARDING_STEPS,
  type OnboardingStepDef,
  type OnboardingStepId,
} from '@/lib/onboarding';
import {
  hasBrandAssets,
  hasBusinessProfile,
  hasMarketingProfile,
} from '@/lib/validations/profile';
import {
  readBrandAssets,
  readBusinessProfile,
  readMarketingProfile,
} from '@/server/company/profile.service';

/**
 * Which setup steps a workspace has actually completed.
 *
 * Completion is DERIVED, never stored. There is no `onboardingStep` column to
 * drift out of sync with reality: a step is done when the thing it asks for is
 * in the database, so deleting your last knowledge source correctly reopens
 * that step, and a user who did half the setup on their laptop sees exactly
 * that on their phone.
 *
 * The whole checklist is eight cheap counts in a single round trip. It renders
 * on the dashboard home page, so it must not cost more than the page it sits
 * on.
 */
export interface OnboardingStepState extends OnboardingStepDef {
  done: boolean;
  /**
   * The one step the user should do next: the first incomplete one. Exactly one
   * step in the list carries this, which is what lets the UI show a single
   * obvious action rather than seven competing buttons.
   */
  current: boolean;
  /** Set when a step is done and there is something concrete to show for it. */
  detail?: string;
}

export interface OnboardingState {
  steps: OnboardingStepState[];
  completed: number;
  total: number;
  /** True once every step is done — the checklist stops being shown. */
  finished: boolean;
  nextStep: OnboardingStepState | null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export async function getOnboardingState(companyId: string): Promise<OnboardingState> {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { industry: true, website: true, brandVoiceNotes: true, preferences: true },
  });

  const [materials, connections, linkedIn, plans, briefings] = await Promise.all([
    db.knowledgeSource.count({ where: { companyId } }),
    // Any working connector counts as a channel. ERROR/EXPIRED rows do not:
    // a connection that stopped working is exactly when the user needs to be
    // told to reconnect, not congratulated.
    db.connection.count({ where: { companyId, status: 'CONNECTED' } }),
    db.linkedInConnection.count({ where: { companyId } }),
    db.marketingPlan.count({ where: { companyId } }),
    db.workspaceBriefing.count({ where: { companyId } }),
  ]);

  const brand = company ? readBrandAssets(company) : null;
  const marketing = company ? readMarketingProfile(company) : null;
  const business = company ? readBusinessProfile(company) : null;
  const channelCount = connections + linkedIn;

  // A step's `done` and its `detail` are decided together so they can never
  // disagree — a row reading "Done · 3 documents" when the count is zero would
  // be worse than no detail at all.
  const results: Record<OnboardingStepId, { done: boolean; detail?: string }> = {
    business: {
      /**
       * Done when the workspace has said what it DOES, not when it has picked
       * an industry label.
       *
       * This step used to key off `industry`, which onboarding presented as
       * optional — so a user who finished the wizard landed on a dashboard
       * whose first item told them to go and add the business information they
       * had just been told they could skip. The wizard now requires a
       * description and writes it here, so finishing onboarding genuinely
       * completes this step.
       */
      done: hasBusinessProfile(business),
      detail: business?.description
        ? company?.industry?.trim() || 'Described'
        : undefined,
    },
    materials: {
      done: materials > 0,
      detail: materials > 0 ? plural(materials, 'source') : undefined,
    },
    brand: {
      done: hasBrandAssets(brand),
      detail: brand?.logoAssetId
        ? brand.primaryColor
          ? 'Logo and colours'
          : 'Logo added'
        : brand?.primaryColor
          ? 'Colours added'
          : undefined,
    },
    audience: {
      done: hasMarketingProfile(marketing),
      detail: marketing?.audience
        ? marketing.goals
          ? 'Audience and goals'
          : 'Audience described'
        : marketing?.goals
          ? 'Goals set'
          : undefined,
    },
    channels: {
      done: channelCount > 0,
      detail: channelCount > 0 ? plural(channelCount, 'channel') : undefined,
    },
    plan: {
      done: plans > 0,
      detail: plans > 0 ? plural(plans, 'plan') : undefined,
    },
    review: {
      done: briefings > 0,
      detail: briefings > 0 ? 'Aura has reported in' : undefined,
    },
  };

  let seenIncomplete = false;
  const steps: OnboardingStepState[] = ONBOARDING_STEPS.map((def) => {
    const result = results[def.id];
    const current = !result.done && !seenIncomplete;
    if (!result.done) seenIncomplete = true;
    return {
      ...def,
      done: result.done,
      current,
      ...(result.detail ? { detail: result.detail } : {}),
    };
  });

  const completed = steps.filter((s) => s.done).length;
  return {
    steps,
    completed,
    total: steps.length,
    finished: completed === steps.length,
    nextStep: steps.find((s) => s.current) ?? null,
  };
}
