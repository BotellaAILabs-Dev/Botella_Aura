import { db } from '@/lib/db';
import {
  readBusinessProfile,
  readMarketingProfile,
} from '@/server/company/profile.service';
import type {
  BusinessProfile,
  MarketingProfile,
  MarketMode,
} from '@/lib/validations/profile';

/**
 * Who the content is for.
 *
 * The generator used to be told the company's voice, its knowledge and the
 * topic — but never the READER. With no audience, a model defaults to writing
 * about the subject rather than to a person, which is exactly what "generic and
 * technical" means in practice: accurate, well-formed, and addressed to nobody.
 *
 * None of this is new data. The workspace already states who it sells to, in
 * OutreachConfig (industries, role titles, company stages) and in its discovery
 * profiles. Those exist for prospecting; reusing them here is what stops the
 * content module from asking the same question a second time.
 *
 * When a workspace has said nothing about its buyers, this returns null and the
 * generator falls back to a general business reader — stated as such, rather
 * than inventing a persona nobody described.
 */
export interface AudienceProfile {
  /** Job titles the content is written for. */
  roleTitles: string[];
  /** Industries those people work in. */
  industries: string[];
  /** Company size/stage, e.g. "seed", "50-200". */
  companyStages: string[];
  /**
   * The workspace's own sentence about who it sells to, from the audience
   * settings page. Takes priority over everything inferred: a human describing
   * their buyer in prose ("ops leads still running everything in spreadsheets")
   * carries context no tag list can.
   */
  stated?: string;
  /** What the business is trying to achieve, so content can aim at it. */
  goals?: string;
  /**
   * Whether the reader is buying for a business or for themselves. Decides
   * which writing rules apply and how the reader is framed below.
   */
  mode?: MarketMode;
  /** Where the description came from, for transparency in the UI later. */
  sources: string[];
}


/**
 * What the company actually does, for the top of the system prompt.
 *
 * The generator opened with the company NAME and, at best, an industry label.
 * A model given "You are the content writer for Verdant. They operate in:
 * Hospitality." has been told nothing it can write a true sentence from, so it
 * fills the gap — inventing products, customers and claims. That is the
 * mechanism behind off-target drafts, and no amount of voice or tone tuning
 * fixes it, because the missing thing is facts rather than style.
 *
 * Returns '' when the workspace has not said what it does, so existing
 * workspaces created before onboarding asked keep exactly their old prompt.
 */
export async function getBusinessProfile(
  companyId: string,
): Promise<BusinessProfile | null> {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { preferences: true },
  });
  return company ? readBusinessProfile(company) : null;
}

export function businessToPrompt(
  business: BusinessProfile | null,
  industry?: string | null,
): string {
  if (!business?.description) {
    return industry ? `They operate in: ${industry}.` : '';
  }
  const lines = ['WHAT THIS COMPANY DOES:', business.description];
  if (business.offerings) {
    lines.push(`What they sell: ${business.offerings}`);
  }
  if (industry) lines.push(`Industry: ${industry}`);
  lines.push(
    'Write only what follows from this and the company knowledge below.',
    'Do not invent products, customers, partnerships or results.',
  );
  return lines.join('\n');
}

export async function getAudienceProfile(
  companyId: string,
): Promise<AudienceProfile | null> {
  const [company, outreach, profiles] = await Promise.all([
    db.company.findUnique({ where: { id: companyId }, select: { preferences: true } }),
    db.outreachConfig.findUnique({ where: { companyId } }),
    db.discoveryProfile.findMany({
      where: { companyId, isActive: true },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { criteria: true },
    }),
  ]);

  // What the workspace SAID about its buyers, which beats anything inferred
  // from prospecting filters. Those exist to find companies; this exists to
  // describe a reader.
  const marketing = company ? readMarketingProfile(company) : null;
  return composeAudienceProfile({ marketing, outreach, profiles });
}

/**
 * Tags where "Head of Ops" and "head of ops " are one entry, keeping the first
 * spelling seen. Outreach and discovery are typed in separately, so the same
 * title routinely arrives twice in different case and would otherwise be
 * listed twice to the model.
 */
class TagSet implements Iterable<string> {
  private readonly byKey = new Map<string, string>();
  add(tag: string): void {
    const value = tag.trim();
    const key = value.toLowerCase();
    if (value && !this.byKey.has(key)) this.byKey.set(key, value);
  }
  get size(): number {
    return this.byKey.size;
  }
  [Symbol.iterator](): Iterator<string> {
    return this.byKey.values();
  }
}

/** The targeting fields composeAudienceProfile reads from OutreachConfig. */
export interface AudienceTargeting {
  roleTitles: string[];
  industries: string[];
  companyStages: string[];
}

/**
 * The merge behind getAudienceProfile, without the reads.
 *
 * Pure so the Business Context (server/business-context) can build the same
 * audience from rows it has already loaded, instead of a second copy of these
 * rules drifting away from this one.
 */
export function composeAudienceProfile({
  marketing,
  outreach,
  profiles,
}: {
  marketing: MarketingProfile | null;
  outreach: AudienceTargeting | null;
  profiles: { criteria: unknown }[];
}): AudienceProfile | null {
  const roleTitles = new TagSet();
  const industries = new TagSet();
  const companyStages = new TagSet();
  const sources: string[] = [];

  if (outreach) {
    outreach.roleTitles.forEach((r) => roleTitles.add(r));
    outreach.industries.forEach((i) => industries.add(i));
    outreach.companyStages.forEach((s) => companyStages.add(s));
    if (outreach.roleTitles.length || outreach.industries.length) {
      sources.push('outreach targeting');
    }
  }

  // Discovery criteria are free-form JSON, so every field is checked rather
  // than trusted — a profile written by an older build must not break content.
  for (const profile of profiles) {
    const criteria = (profile.criteria ?? {}) as Record<string, unknown>;
    for (const key of ['roleTitles', 'industries', 'keywords'] as const) {
      const value = criteria[key];
      if (!Array.isArray(value)) continue;
      for (const entry of value) {
        if (typeof entry !== 'string' || !entry.trim()) continue;
        if (key === 'roleTitles') roleTitles.add(entry);
        else industries.add(entry);
      }
    }
  }
  if (profiles.length > 0 && (roleTitles.size > 0 || industries.size > 0)) {
    sources.push('lead discovery profiles');
  }

  if (marketing?.audience || marketing?.goals) {
    sources.push('audience settings');
  }

  // Nothing anywhere — the generator says so plainly rather than inventing a
  // persona nobody described.
  //
  // The market mode counts as something. A workspace that has only said "we
  // sell to consumers" has told us the most important thing about its reader,
  // and returning null here would throw that away and fall back to writing for
  // a business buyer — the exact mistake this field exists to prevent.
  if (
    roleTitles.size === 0 &&
    industries.size === 0 &&
    companyStages.size === 0 &&
    !marketing?.audience &&
    !marketing?.goals &&
    !marketing?.marketMode
  ) {
    return null;
  }

  return {
    roleTitles: [...roleTitles].slice(0, 8),
    industries: [...industries].slice(0, 8),
    companyStages: [...companyStages].slice(0, 5),
    ...(marketing?.audience ? { stated: marketing.audience } : {}),
    ...(marketing?.goals ? { goals: marketing.goals } : {}),
    ...(marketing?.marketMode ? { mode: marketing.marketMode } : {}),
    sources,
  };
}

/**
 * The audience block injected into every generation prompt.
 *
 * Written as an instruction about the READER rather than a list of attributes,
 * because "your reader is a Head of Marketing at a Series A SaaS company" moves
 * output far more than "audience: marketing, SaaS, series-a".
 */
export function audienceToPrompt(audience: AudienceProfile | null): string {
  if (!audience) {
    return [
      'WHO YOU ARE WRITING FOR:',
      'This workspace has not described its buyers yet, so write for a busy',
      'business decision-maker: someone who cares about outcomes and cost, not',
      'implementation detail. Avoid jargon they would have to look up.',
    ].join('\n');
  }

  const consumer = audience.mode === 'B2C';
  const lines = ['WHO YOU ARE WRITING FOR:'];

  // A sentence the user wrote themselves goes in verbatim and goes in FIRST.
  // Paraphrasing it into role/industry tags would throw away the specifics
  // ("still running everything in spreadsheets") that make it useful.
  if (audience.stated) {
    lines.push(`Your reader, in the company's own words: ${audience.stated}`);
  }

  if (!audience.stated || audience.roleTitles.length || audience.industries.length) {
    // The generic fallback differs by mode. Calling a bourbon drinker a
    // "business decision-maker" is not a small inaccuracy — it is the single
    // instruction the model leans on hardest when nothing else is specified.
    const fallback = consumer
      ? 'someone choosing this for themselves'
      : 'business decision-makers';
    const who = audience.roleTitles.length
      ? audience.roleTitles.slice(0, 4).join(', ')
      : fallback;
    const where = audience.industries.length
      ? ` working in ${audience.industries.slice(0, 4).join(', ')}`
      : '';
    const stage = audience.companyStages.length
      ? ` at ${audience.companyStages.slice(0, 3).join(' / ')} companies`
      : '';
    lines.push(
      audience.stated
        ? `They are typically ${who}${where}${stage}.`
        : `Your reader is ${who}${where}${stage}.`,
    );
  }

  if (consumer) {
    // A consumer is not accountable to anyone for this purchase. Asking the
    // model to justify every sentence against a metric — which is what the
    // B2B instruction below does — strips out the sensory, story-led writing
    // that is the entire reason someone buys a bottle rather than a licence.
    lines.push(
      'Write TO that person, the way you would talk to someone standing in',
      'front of you. They are spending their own money on something they want,',
      'not signing off a budget. Nothing here has to be justified to a boss.',
      'What earns their attention is a real detail, a story, or something worth',
      'looking at — not a business case.',
    );
  } else {
    lines.push(
      'Write TO that person. Every claim should connect to something they are',
      'measured on — revenue, cost, risk, time, or team capacity. If a sentence',
      'would not change how they spend their week, cut it.',
    );
  }

  // The goal is what the writing is FOR. Stated as the job the post has to do,
  // not as a target to mention — a post that recites "we want 15 demos" is
  // exactly the wrong reading of this field.
  if (audience.goals) {
    lines.push(
      '',
      'WHAT THIS CONTENT IS FOR:',
      `The business is working towards: ${audience.goals}`,
      'Let that steer what you write about and what you ask the reader to do.',
      'Never state the goal in the post itself — it is our objective, not their',
      'concern.',
    );
  }

  return lines.join('\n');
}

/**
 * Rules that keep output specific rather than generic.
 *
 * These are stated as prohibitions with concrete examples because that is what
 * actually moves a model. "Be specific" is advice a model already agrees with
 * and ignores; "never open with 'In today's fast-paced world'" is a rule it can
 * follow.
 *
 * Split by market mode, because the single biggest fork in how marketing is
 * written is whether the reader is spending a budget or their own money. These
 * rules used to be one B2B-only block applied to everything, which meant a
 * consumer brand was told to justify every sentence against revenue and cost —
 * the surest way to make a bourbon post read like a procurement memo.
 */
const SHARED_RULES = [
  '· One concrete, checkable detail beats three adjectives. Prefer a number, a',
  '  timeframe, a named situation, or a real trade-off.',
  '· Write like a knowledgeable person talking, not a brochure. Short sentences.',
  '  Plain words.',
  '· Never open with a throat-clearing generality. Banned openings: "In today\'s',
  '  fast-paced world", "In an era of", "Businesses everywhere are", "It is no',
  '  secret that", "We are excited to announce".',
  '· No rhetorical question as a hook unless the answer is genuinely surprising.',
  '· If you cannot say something specific from the company knowledge provided,',
  '  say something narrower rather than something vague. A smaller true claim',
  '  beats a broad empty one.',
];

const B2B_RULES = [
  '· Lead with the business consequence, not the technology. "Support tickets',
  '  drop 40%" beats "we implemented a vector database".',
  '· Explain the SO WHAT. If you describe a capability, say what it changes for',
  '  the reader — what they can now do, stop doing, or stop worrying about.',
  '· Technical detail is allowed ONLY where it explains a business outcome the',
  '  reader cares about. Never as evidence of sophistication.',
  '· No hype adjectives: revolutionary, cutting-edge, seamless, game-changing,',
  '  robust, leverage, unlock, elevate, supercharge.',
];

const B2C_RULES = [
  '· Lead with the experience, not the spec sheet. What does it taste, look,',
  '  sound or feel like? Give the reader something they can picture.',
  '· Craft detail is welcome — it is often exactly why an enthusiast follows a',
  '  brand — but always tie it to what it DOES. Not "aged four years in char',
  '  #3 oak" alone, but what those four years put in the glass.',
  '· Write to one person, never about an audience. Never use the words',
  '  "consumers", "users", "customers" or "the target audience" in the copy.',
  '· No corporate voice. Never "our solution", "our offering", "we leverage",',
  '  "we are pleased to". You are a person talking about something you made.',
  '· No hype adjectives, and no category clichés: revolutionary, game-changing,',
  '  elevate, unlock, premium, artisanal, hand-crafted, smooth, bold flavour,',
  '  "a journey", "an experience like no other".',
  '· End with ONE clear thing to do, phrased as a human would ask it. Never',
  '  "Click the link in bio to learn more today!".',
  '· Never invent tasting notes, awards, or provenance. If the company material',
  '  does not say it, do not claim it — this is a regulated category and an',
  '  invented age statement or award is a real problem, not a stylistic one.',
];

/**
 * The writing rules for one market mode.
 *
 * Defaults to B2B when the workspace has not chosen, which is exactly the
 * behaviour every existing workspace already had before modes existed.
 */
export function contentRulesFor(mode: MarketMode | null | undefined): string {
  const specific = mode === 'B2C' ? B2C_RULES : B2B_RULES;
  return ['HOW TO WRITE THIS:', '', ...specific, ...SHARED_RULES].join('\n');
}

/**
 * Back-compat alias for the B2B rules.
 *
 * @deprecated Prefer contentRulesFor(mode) — a caller using this constant is
 * applying business-buyer rules to a consumer brand.
 */
export const BUSINESS_FOCUS_RULES = contentRulesFor('B2B');
