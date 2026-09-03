import { db } from '@/lib/db';
import { readMarketingProfile } from '@/server/company/profile.service';

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
  /** Where the description came from, for transparency in the UI later. */
  sources: string[];
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

  const roleTitles = new Set<string>();
  const industries = new Set<string>();
  const companyStages = new Set<string>();
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
  if (
    roleTitles.size === 0 &&
    industries.size === 0 &&
    companyStages.size === 0 &&
    !marketing?.audience &&
    !marketing?.goals
  ) {
    return null;
  }

  return {
    roleTitles: [...roleTitles].slice(0, 8),
    industries: [...industries].slice(0, 8),
    companyStages: [...companyStages].slice(0, 5),
    ...(marketing?.audience ? { stated: marketing.audience } : {}),
    ...(marketing?.goals ? { goals: marketing.goals } : {}),
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

  const lines = ['WHO YOU ARE WRITING FOR:'];

  // A sentence the user wrote themselves goes in verbatim and goes in FIRST.
  // Paraphrasing it into role/industry tags would throw away the specifics
  // ("still running everything in spreadsheets") that make it useful.
  if (audience.stated) {
    lines.push(`Your reader, in the company's own words: ${audience.stated}`);
  }

  if (!audience.stated || audience.roleTitles.length || audience.industries.length) {
    const who = audience.roleTitles.length
      ? audience.roleTitles.slice(0, 4).join(', ')
      : 'business decision-makers';
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

  lines.push(
    'Write TO that person. Every claim should connect to something they are',
    'measured on — revenue, cost, risk, time, or team capacity. If a sentence',
    'would not change how they spend their week, cut it.',
  );

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
 * Rules that keep output business-focused rather than generic or technical.
 *
 * These are stated as prohibitions with concrete examples because that is what
 * actually moves a model. "Be specific" is advice a model already agrees with
 * and ignores; "never open with 'In today's fast-paced world'" is a rule it can
 * follow.
 */
export const BUSINESS_FOCUS_RULES = [
  'HOW TO WRITE THIS:',
  '',
  '· Lead with the business consequence, not the technology. "Support tickets',
  '  drop 40%" beats "we implemented a vector database".',
  '· One concrete, checkable detail beats three adjectives. Prefer a number, a',
  '  timeframe, a named situation, or a real trade-off.',
  '· Explain the SO WHAT. If you describe a capability, say what it changes for',
  '  the reader — what they can now do, stop doing, or stop worrying about.',
  '· Write like a knowledgeable person talking, not a brochure. Short sentences.',
  '  Plain words. No hype adjectives (revolutionary, cutting-edge, seamless,',
  '  game-changing, robust, leverage, unlock, elevate, supercharge).',
  '· Never open with a throat-clearing generality. Banned openings: "In today\'s',
  '  fast-paced world", "In an era of", "Businesses everywhere are", "It is no',
  '  secret that", "We are excited to announce".',
  '· No rhetorical question as a hook unless the answer is genuinely surprising.',
  '· Technical detail is allowed ONLY where it explains a business outcome the',
  '  reader cares about. Never as evidence of sophistication.',
  '· If you cannot say something specific from the company knowledge provided,',
  '  say something narrower rather than something vague. A smaller true claim',
  '  beats a broad empty one.',
].join('\n');
