import type { Company } from '@prisma/client';

import {
  getBusinessContext,
  toAudienceProfile,
} from '@/server/business-context/business-context.service';
import {
  audienceToPrompt,
  businessToPrompt,
  contentRulesFor,
  type AudienceProfile,
} from '@/server/content/audience';
import { brandVoiceToPrompt } from '@/server/content/brand-voice.service';
import { chunksToContext, type RetrievedChunk } from '@/server/knowledge/retrieve';
import type { BusinessProfile } from '@/lib/validations/profile';
import type { BrandVoiceProfile } from '@/lib/validations/content';

/**
 * Everything the workspace has told us about itself, in one place.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Brand knowledge was assembled independently at every AI call site, and each
 * one picked a different subset. An audit of the ten workflows that call a
 * model found brand voice wired into eight of them — and the business
 * description and audience wired into two.
 *
 * So a user who carefully described their company and their buyer during
 * onboarding got content and recommendations that used it, and campaign plans,
 * outreach drafts, engagement replies, marketing plans and image prompts that
 * did not. Those workflows fell back to asking for the same information again
 * in their own forms, or to writing for a generic business reader — which is
 * exactly the duplication this module exists to remove.
 *
 * The fix is composition, not new logic: every piece below already existed and
 * was already correct. What was missing was a single object that carries all of
 * it and a single function that renders it, so a new workflow gets the whole
 * picture by default instead of whichever fragment its author remembered.
 *
 * WHAT GOES IN A PROMPT, AND IN WHAT ORDER
 * ----------------------------------------
 * The order below is deliberate and matches what the content generator already
 * established as working: what the company IS, then who it is writing TO, then
 * how it SOUNDS, then the facts it may draw on. Identity before audience before
 * voice, because a model asked to adopt a tone before it knows the subject will
 * write stylishly about nothing.
 */
export interface BrandContext {
  company: Pick<Company, 'id' | 'name' | 'industry' | 'website'>;
  /** What the business does and sells, in its own words. */
  business: BusinessProfile | null;
  /** Who it markets to, and whether they buy for a business or themselves. */
  audience: AudienceProfile | null;
  /** The AI-written, human-editable voice profile. */
  voice: BrandVoiceProfile | null;
  /** Grounding passages from uploaded materials — only when a query is given. */
  knowledge: RetrievedChunk[];
}

export interface BrandContextOptions {
  /**
   * What to retrieve grounding material about.
   *
   * Omitted means "no knowledge lookup" — right for a workflow that reasons
   * about the workspace as a whole (a marketing plan, a campaign shape) rather
   * than writing a specific piece. Passing a query costs a vector-ish lookup,
   * so it is opt-in rather than automatic.
   */
  query?: string;
  /** How many knowledge passages to pull. Ignored without a query. */
  knowledgeLimit?: number;
}

/**
 * The brand-facing slice of the Business Context.
 *
 * Kept for the call sites written against this shape. It is now a projection of
 * getBusinessContext (server/business-context), so both read the same sources
 * through the same resolution rules; new workflows should call
 * getBusinessContext and businessContextToPrompt directly.
 */
export async function getBrandContext(
  companyId: string,
  options: BrandContextOptions = {},
): Promise<BrandContext | null> {
  const ctx = await getBusinessContext(companyId, {
    // Only the sections this shape exposes, so its cost does not grow with
    // the full context.
    sections: ['targeting'],
    query: options.query,
    knowledgeLimit: options.knowledgeLimit,
  });
  if (!ctx) return null;

  return {
    company: {
      id: ctx.identity.companyId,
      name: ctx.identity.name,
      industry: ctx.identity.industry,
      website: ctx.identity.website,
    },
    business: ctx.identity.description || ctx.identity.offerings
      ? {
          description: ctx.identity.description ?? undefined,
          offerings: ctx.identity.offerings ?? undefined,
        }
      : null,
    audience: toAudienceProfile(ctx),
    voice: ctx.voice.profile,
    knowledge: ctx.knowledge.passages,
  };
}

export interface BrandPromptOptions {
  /**
   * Include the market-specific writing rules (B2C vs B2B).
   *
   * On by default for anything that produces copy a customer will read. A
   * workflow that only plans — deciding what to write about rather than writing
   * it — can turn this off to keep its prompt focused.
   */
  includeWritingRules?: boolean;
  /** Include the brand voice block. Off for workflows that do not produce prose. */
  includeVoice?: boolean;
  /** Include retrieved knowledge passages. No effect when none were retrieved. */
  includeKnowledge?: boolean;
}

/**
 * Render the context as the shared preamble for any AI workflow.
 *
 * Every block degrades to nothing when the workspace has not supplied it, so a
 * brand-new workspace produces the same short prompt these call sites had
 * before this module existed. Nothing here can make an unconfigured workspace
 * worse; it can only add what the user already told us.
 */
export function brandContextToPrompt(
  context: BrandContext | null,
  options: BrandPromptOptions = {},
): string {
  if (!context) return '';

  const {
    includeWritingRules = true,
    includeVoice = true,
    includeKnowledge = true,
  } = options;

  const blocks: string[] = [];

  // 1. What the company is.
  const identity = businessToPrompt(context.business, context.company.industry);
  if (identity) blocks.push(identity);

  // 2. Who it is talking to. Always included: the fallback text itself carries
  //    useful instruction ("write for a busy business decision-maker") and is
  //    better than leaving the reader undefined.
  blocks.push(audienceToPrompt(context.audience));

  // 3. How it sounds.
  if (includeVoice && context.voice) {
    blocks.push(brandVoiceToPrompt(context.voice));
  }

  // 4. The rules that follow from who is being sold to.
  if (includeWritingRules) {
    blocks.push(contentRulesFor(context.audience?.mode));
  }

  // 5. The facts it is allowed to draw on.
  if (includeKnowledge && context.knowledge.length > 0) {
    blocks.push(
      [
        'COMPANY KNOWLEDGE — the only facts you may state as this company:',
        chunksToContext(context.knowledge),
        'Do not invent product names, customers, numbers or claims beyond this.',
      ].join('\n'),
    );
  }

  return blocks.filter(Boolean).join('\n\n');
}

/**
 * True once the workspace has said enough for the context to be worth anything.
 *
 * Lets a caller tell an honest empty state ("describe your business and Aura
 * will use it here") apart from a genuine failure.
 */
export function hasBrandContext(context: BrandContext | null): boolean {
  if (!context) return false;
  return Boolean(
    context.business?.description ||
      context.audience?.stated ||
      context.audience?.mode ||
      context.voice ||
      context.knowledge.length > 0,
  );
}
