import { z } from 'zod';

import type { QualityIssue } from '@/lib/content-quality';
import type { CheckedClaim } from '@/lib/fact-check';
import { SOCIAL_PLATFORMS, type SocialPlatformKey } from '@/lib/platforms';
import { CONTENT_TYPES, type ContentTypeKey } from '@/lib/validations/content';

/**
 * Content compliance & policy checks: configurable rules for the content and
 * channel being made, checked before approval. Pure and client-safe.
 *
 * Where the rules live:
 *   - the workspace's policy (Company.preferences.compliancePolicy, edited in
 *     Settings → Compliance): prohibited phrases, required disclaimers,
 *     manual-review triggers, CTA rules, which rule packs are on;
 *   - built-in rule packs (general advertising, alcohol, health, financial)
 *     and channel restrictions, defined here as data — not in prompts;
 *   - the existing deterministic checks (lib/content-quality.ts) and the fact
 *     check (lib/fact-check.ts), folded in under the same categories.
 *
 * The same policy is turned into instructions for the writer
 * (policyToPrompt), so content is written to it as well as checked against it.
 */

export const POLICY_VERSION = 1;

export const COMPLIANCE_CATEGORIES = [
  'prohibited_claim',
  'disclaimer',
  'channel',
  'business',
  'cta',
  'factual',
  'manual_review',
] as const;
export type ComplianceCategory = (typeof COMPLIANCE_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<ComplianceCategory, string> = {
  prohibited_claim: 'Prohibited claims',
  disclaimer: 'Required disclaimers',
  channel: 'Channel restrictions',
  business: 'Business rules',
  cta: 'Call to action',
  factual: 'Factual & product claims',
  manual_review: 'Manual review',
};

/** fail — must be fixed before it can be submitted or approved · review — a person must look · warn — advice only. */
export type ComplianceOutcome = 'fail' | 'review' | 'warn';
export type RuleSource = 'built_in' | 'workspace' | 'rules' | 'fact_check';

// ---------------------------------------------------------------------------
// The workspace policy
// ---------------------------------------------------------------------------

const phrase = z.string().trim().min(2).max(80);
const id = z.string().trim().min(1).max(40);

export const DISCLAIMER_WHEN = ['always', 'promotion', 'terms'] as const;

export const compliancePolicySchema = z.object({
  version: z.literal(POLICY_VERSION).default(POLICY_VERSION),
  /** Built-in rule packs. Alcohol follows the business by default. */
  packs: z
    .object({
      general: z.boolean().default(true),
      alcohol: z.enum(['auto', 'on', 'off']).default('auto'),
      health: z.boolean().default(false),
      financial: z.boolean().default(false),
    })
    .default({}),
  /** Words or phrases this business never uses. */
  prohibited: z
    .array(
      z.object({
        id,
        phrase,
        severity: z.enum(['block', 'review']).default('block'),
        reason: z.string().trim().max(200).default(''),
      }),
    )
    .max(50)
    .default([]),
  /** Text that must appear when it applies. */
  disclaimers: z
    .array(
      z.object({
        id,
        text: z.string().trim().min(3).max(300),
        /** always · on a promotion (discount, sale, giveaway…) · when one of `terms` appears. */
        when: z.enum(DISCLAIMER_WHEN).default('always'),
        terms: z.array(phrase).max(20).default([]),
        /** Formats it applies to; empty = all. */
        formats: z.array(z.enum(CONTENT_TYPES)).default([]),
        severity: z.enum(['block', 'review']).default('block'),
      }),
    )
    .max(20)
    .default([]),
  /** What always needs a person's review before approval. */
  manualReview: z
    .object({
      formats: z.array(z.enum(CONTENT_TYPES)).default([]),
      channels: z.array(z.enum(SOCIAL_PLATFORMS)).default([]),
      terms: z.array(phrase).max(30).default([]),
      competitorMentions: z.boolean().default(true),
      prices: z.boolean().default(false),
      giveaways: z.boolean().default(true),
    })
    .default({}),
  cta: z
    .object({
      /** CTA wording the business does not use ("DM us" when nobody reads DMs). */
      bannedPhrases: z.array(phrase).max(20).default([]),
      /** Domains links may point to, besides the business's own website. */
      allowedLinkDomains: z
        .array(z.string().trim().min(3).max(100))
        .max(20)
        .default([]),
      /** Formats that must always carry a call to action. */
      requiredFor: z.array(z.enum(CONTENT_TYPES)).default([]),
    })
    .default({}),
});
export type CompliancePolicy = z.infer<typeof compliancePolicySchema>;
export type CompliancePolicyInput = z.input<typeof compliancePolicySchema>;

const PROMO_DISCLAIMER_ID = 'promo-terms';
const RESPONSIBLE_ID = 'responsible-drinking';

/** The policy a workspace starts with: sensible defaults, all editable. */
export function defaultPolicy(alcohol: boolean): CompliancePolicy {
  return compliancePolicySchema.parse({
    disclaimers: [
      {
        id: PROMO_DISCLAIMER_ID,
        text: 'Terms apply.',
        when: 'promotion',
        severity: 'block',
      },
      ...(alcohol
        ? [
            {
              id: RESPONSIBLE_ID,
              text: 'Please enjoy responsibly.',
              when: 'always',
              severity: 'block',
            },
          ]
        : []),
    ],
  });
}

/** The stored policy, or the defaults when none (or an unreadable one) is stored. */
export function readPolicy(
  stored: unknown,
  alcohol: boolean,
): CompliancePolicy {
  if (stored && typeof stored === 'object') {
    const parsed = compliancePolicySchema.safeParse(stored);
    if (parsed.success) return parsed.data;
  }
  return defaultPolicy(alcohol);
}

/** Which built-in packs apply. */
export function activePacks(
  policy: CompliancePolicy,
  alcohol: boolean,
): PackKey[] {
  const p = policy.packs;
  const out: PackKey[] = [];
  if (p.general) out.push('general');
  if (p.alcohol === 'on' || (p.alcohol === 'auto' && alcohol))
    out.push('alcohol');
  if (p.health) out.push('health');
  if (p.financial) out.push('financial');
  return out;
}

/** A stable fingerprint of the rules in force — a review is out of date when it changes. */
export function policyHash(policy: CompliancePolicy, alcohol: boolean): string {
  const str = JSON.stringify({ policy, packs: activePacks(policy, alcohol) });
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Built-in rule packs and channel restrictions — data, not prompts
// ---------------------------------------------------------------------------

export type PackKey = 'general' | 'alcohol' | 'health' | 'financial';

interface PatternRule {
  id: string;
  re: RegExp;
  outcome: ComplianceOutcome;
  category: ComplianceCategory;
  message: string;
  fix: string;
  /** Only for these formats / channels (all when absent). */
  formats?: ContentTypeKey[];
  platforms?: SocialPlatformKey[];
  /** Only on a promotion / giveaway. */
  onlyIf?: 'promotion' | 'giveaway';
}

export const PACKS: Record<
  PackKey,
  { label: string; description: string; rules: PatternRule[] }
> = {
  general: {
    label: 'General advertising',
    description:
      'Misleading promises: risk-free, miracle, get-rich, guarantees.',
    rules: [
      {
        id: 'general.risk-free',
        re: /\b(risk[- ]free|no[- ]risk|zero[- ]risk)\b/i,
        outcome: 'fail',
        category: 'prohibited_claim',
        message:
          'Promises it is risk-free — a misleading claim in advertising.',
        fix: 'Remove the promise, or state the actual terms (e.g. a returns policy).',
      },
      {
        id: 'general.miracle',
        re: /\b(miracle|magic(al)? (cure|results?)|get rich|make money fast|instant results?)\b/i,
        outcome: 'fail',
        category: 'prohibited_claim',
        message: 'Uses an exaggerated, misleading promise.',
        fix: 'Describe the real, specific benefit instead.',
      },
      {
        id: 'general.guarantee',
        re: /\bguarantee[ds]?\b/i,
        outcome: 'review',
        category: 'prohibited_claim',
        message: 'Makes a guarantee — it needs documented terms behind it.',
        fix: 'Check the guarantee exists and its terms are available, or remove it.',
      },
    ],
  },
  alcohol: {
    label: 'Alcohol marketing',
    description:
      'Adults only, no excess, no health or social-success claims (checked on every draft), plus free-drink offers and alcohol ads.',
    rules: [
      {
        id: 'alcohol.free-drinks',
        re: /\bfree (beer|beers|wine|drinks?|shots?|bottles?|pints?|cocktails?|booze|alcohol)\b/i,
        outcome: 'review',
        category: 'prohibited_claim',
        message: 'Offers free alcohol — restricted in many places.',
        fix: 'Check local licensing rules allow it before approving.',
      },
      {
        id: 'alcohol.giveaway',
        re: /./,
        onlyIf: 'giveaway',
        outcome: 'review',
        category: 'manual_review',
        message:
          'An alcohol giveaway — entrants must be of legal drinking age and local rules vary.',
        fix: 'Check eligibility rules (age, location) are stated and allowed.',
      },
      {
        id: 'alcohol.ad-audience',
        re: /./,
        formats: ['AD'],
        outcome: 'review',
        category: 'channel',
        message:
          'An alcohol ad — its audience must be restricted to legal drinking age in the ad manager.',
        fix: 'Set the age targeting before the ad runs; confirm when approving.',
      },
    ],
  },
  health: {
    label: 'Health & wellness',
    description:
      'No claims to cure, treat or prevent illness; endorsements need proof.',
    rules: [
      {
        id: 'health.treats',
        re: /\b(cures?|treats?|prevents?|heals?|reverses?)\b[^.!?]{0,30}\b(cancer|disease|diabetes|anxiety|depression|covid|illness|infection|arthritis|insomnia|obesity)\b/i,
        outcome: 'fail',
        category: 'prohibited_claim',
        message: 'Claims to cure, treat or prevent an illness.',
        fix: 'Remove the medical claim.',
      },
      {
        id: 'health.endorsement',
        re: /\b(clinically (proven|tested)|doctor[- ]recommended|fda[- ]approved|dermatologist[- ]approved)\b/i,
        outcome: 'review',
        category: 'prohibited_claim',
        message:
          'Cites a clinical or medical endorsement — it needs evidence on file.',
        fix: 'Check the study or approval exists, or remove it.',
      },
    ],
  },
  financial: {
    label: 'Financial services',
    description:
      'No guaranteed returns; performance claims carry a risk warning.',
    rules: [
      {
        id: 'financial.guaranteed-returns',
        re: /\bguaranteed (returns?|profits?|income|growth|yield)\b/i,
        outcome: 'fail',
        category: 'prohibited_claim',
        message: 'Promises guaranteed returns.',
        fix: 'Remove it — returns cannot be guaranteed.',
      },
      {
        id: 'financial.risk-warning',
        re: /\b(returns?|yields?|apy|apr|interest rates?|invest(ing|ment)?)\b/i,
        outcome: 'fail',
        category: 'disclaimer',
        message: 'Talks about returns or investing without a risk warning.',
        fix: 'Add: "Past performance does not guarantee future results. Capital at risk."',
      },
    ],
  },
};

/** The financial risk warning counts as present when any of these appear. */
const RISK_WARNING =
  /(past performance|capital (is )?at risk|value of (your )?investments? can (go down|fall))/i;

/** Platform rules that hold for every workspace. */
export const CHANNEL_RULES: PatternRule[] = [
  {
    id: 'channel.meta-giveaway-release',
    re: /./,
    onlyIf: 'giveaway',
    platforms: ['INSTAGRAM', 'FACEBOOK'],
    outcome: 'fail',
    category: 'channel',
    message:
      'Instagram and Facebook require a giveaway to say it is not sponsored, endorsed or administered by them.',
    fix: 'Add: "This promotion is not sponsored, endorsed or administered by, or associated with, Instagram/Facebook."',
  },
  {
    id: 'channel.engagement-bait',
    re: /\b(comment ['"“]?\w+['"”]? (below|if|to)|tag (a|your|3|three|two) friends?|like (this|if)|share (this|if)|vote (with|by) (a )?(like|comment|reaction))\b/i,
    platforms: ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN'],
    outcome: 'review',
    category: 'channel',
    message:
      'Engagement bait (“comment YES”, “tag a friend”) — the networks demote it.',
    fix: 'Ask a genuine question instead.',
  },
  {
    id: 'channel.instagram-links',
    re: /(https?:\/\/|www\.)\S+/i,
    platforms: ['INSTAGRAM'],
    outcome: 'warn',
    category: 'channel',
    message: 'Links in Instagram captions are not clickable.',
    fix: 'Say “link in bio” and put the link there.',
  },
  {
    id: 'channel.ad-personal-attributes',
    re: /\b(are you|do you (have|suffer from)|you'?re|other) (overweight|fat|depressed|diabetic|bankrupt|in debt|single|divorced|gay|lesbian|christian|muslim|jewish|hindu|disabled|struggling with \w+)\b/i,
    formats: ['AD'],
    outcome: 'fail',
    category: 'channel',
    message:
      'Ad policy: an ad may not assert or imply a person’s personal attributes.',
    fix: 'Talk about the product, not the reader’s health, finances, beliefs or identity.',
  },
  {
    id: 'channel.email-subject-shouting',
    re: /(!{3,}|\b[A-Z]{5,}\b(?:\s+\b[A-Z]{3,}\b){2,})/,
    formats: ['EMAIL'],
    outcome: 'warn',
    category: 'channel',
    message: 'Shouting (ALL CAPS, “!!!”) — spam filters penalise it.',
    fix: 'Use sentence case and one exclamation mark at most.',
  },
];

const PROMOTION =
  /(\b\d{1,2}\s?% off\b|\bper ?cent off\b|\b(sale|discount(ed)?|promo(tion)? code|coupon|voucher|bogo|buy one,? get|half price|clearance|limited[- ]time offer|special offer|free (shipping|delivery|gift|trial|sample|tasting))\b|\bgiveaway\b|\bcontest\b|\bsweepstakes?\b|\bcompetition\b|\bwin (a|an|one|free|tickets?)\b)/i;
const GIVEAWAY =
  /\b(giveaway|give away|contest|sweepstakes?|competition|raffle|win (a|an|one|free|tickets?)|to enter\b)/i;
const PRICE =
  /([$€£₹]\s?\d|\b\d+(\.\d{2})?\s?(usd|eur|gbp|inr|dollars|euros|pounds|rupees)\b)/i;
const LINK = /\bhttps?:\/\/([^\s/)]+)|\bwww\.([^\s/)]+)/gi;

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export interface ComplianceFinding {
  /** The rule that found it — stable, so a finding can be traced to its rule. */
  ruleId: string;
  category: ComplianceCategory;
  outcome: ComplianceOutcome;
  message: string;
  quote: string | null;
  fix: string | null;
  source: RuleSource;
}

export interface ComplianceReport {
  version: typeof POLICY_VERSION;
  /** fail — must be fixed · review — a person must look · pass. */
  status: 'pass' | 'review' | 'fail';
  findings: ComplianceFinding[];
  /** How many rules ran, per category — what "checked" means. */
  checked: Record<ComplianceCategory, number>;
  packs: PackKey[];
  policyHash: string;
}

export interface ComplianceInput {
  type: ContentTypeKey;
  platform: SocialPlatformKey | null;
  /** The piece as a reader sees it (all copy), its CTA, and an email subject. */
  text: string;
  cta: string;
  subject?: string | null;
  policy: CompliancePolicy;
  alcohol: boolean;
  /** The business's website — its own links are always allowed. */
  website: string | null;
  competitors: string[];
  /** The deterministic checks on the body (lib/content-quality.ts). */
  rules: QualityIssue[];
  /** The fact check's claims (lib/fact-check.ts). */
  claims: Pick<CheckedClaim, 'text' | 'status' | 'mustFix' | 'reason'>[] | null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A phrase as a whole-word, case-insensitive pattern ("DM us" ≠ "admus"). */
const phraseRe = (p: string) =>
  new RegExp(
    `(^|[^\\p{L}\\p{N}])${escape(p.trim())}(?=$|[^\\p{L}\\p{N}])`,
    'iu',
  );
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[“”"'’‘.,!?;:()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const sentenceWith = (text: string, re: RegExp): string | null => {
  const m = text.match(re);
  if (!m || m.index === undefined) return null;
  const start = Math.max(
    text.lastIndexOf('.', m.index) + 1,
    text.lastIndexOf('\n', m.index) + 1,
  );
  const ends = ['.', '!', '?', '\n']
    .map((c) => text.indexOf(c, m.index! + m[0].length))
    .filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) + 1 : text.length;
  return text.slice(start, end).trim().slice(0, 200) || null;
};
const hostOf = (u: string | null) => {
  if (!u) return null;
  try {
    return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname
      .replace(/^www\./, '')
      .toLowerCase();
  } catch {
    return null;
  }
};

/** Quality-rule codes as compliance categories; style-only codes are not compliance. */
const QUALITY_CATEGORY: Partial<
  Record<QualityIssue['code'], ComplianceCategory>
> = {
  'alcohol-minors': 'prohibited_claim',
  'alcohol-excess': 'prohibited_claim',
  'alcohol-health': 'prohibited_claim',
  'alcohol-social': 'prohibited_claim',
  'alcohol-driving': 'prohibited_claim',
  'avoid-topic': 'business',
  'too-long': 'channel',
  long: 'channel',
  hashtags: 'channel',
  'no-cta': 'cta',
  'unsupported-claim': 'factual',
  'unsupported-number': 'factual',
  'facts-changed': 'factual',
};

export function checkCompliance(input: ComplianceInput): ComplianceReport {
  const { policy, type, platform } = input;
  const text = [input.subject ?? '', input.text, input.cta]
    .filter(Boolean)
    .join('\n');
  const findings: ComplianceFinding[] = [];
  const checked = Object.fromEntries(
    COMPLIANCE_CATEGORIES.map((c) => [c, 0]),
  ) as Record<ComplianceCategory, number>;
  const add = (f: ComplianceFinding) => {
    if (!findings.some((x) => x.ruleId === f.ruleId)) findings.push(f);
  };
  const promotion = PROMOTION.test(text);
  const giveaway = GIVEAWAY.test(text);
  const packs = activePacks(policy, input.alcohol);

  const applies = (r: PatternRule) =>
    (!r.formats || r.formats.includes(type)) &&
    (!r.platforms || (platform !== null && r.platforms.includes(platform))) &&
    (r.onlyIf !== 'promotion' || promotion) &&
    (r.onlyIf !== 'giveaway' || giveaway);

  const runPattern = (r: PatternRule, source: RuleSource) => {
    if (!applies(r)) return;
    checked[r.category] += 1;
    // A rule gated on a format or occasion fires on the occasion itself.
    const where = r.re.source === '.' ? null : r.re;
    if (
      where &&
      !where.test(
        r.id === 'channel.email-subject-shouting'
          ? (input.subject ?? '')
          : text,
      )
    )
      return;
    if (
      r.id === 'channel.meta-giveaway-release' &&
      /not (be )?(sponsored|endorsed|administered|associated)/i.test(text)
    )
      return;
    if (r.id === 'financial.risk-warning' && RISK_WARNING.test(text)) return;
    add({
      ruleId: r.id,
      category: r.category,
      outcome: r.outcome,
      message: r.message,
      quote: where ? sentenceWith(text, where) : null,
      fix: r.fix,
      source,
    });
  };

  // 1. Built-in packs and channel restrictions.
  for (const p of packs)
    for (const r of PACKS[p].rules) runPattern(r, 'built_in');
  for (const r of CHANNEL_RULES) runPattern(r, 'built_in');

  // 2. The workspace's prohibited phrases.
  for (const r of policy.prohibited) {
    checked.prohibited_claim += 1;
    const re = phraseRe(r.phrase);
    if (!re.test(text)) continue;
    add({
      ruleId: `workspace.prohibited.${r.id}`,
      category: 'prohibited_claim',
      outcome: r.severity === 'block' ? 'fail' : 'review',
      message: `Uses “${r.phrase}”${r.reason ? ` — ${r.reason}` : ', which this business does not use'}.`,
      quote: sentenceWith(text, re),
      fix: `Remove or reword “${r.phrase}”.`,
      source: 'workspace',
    });
  }

  // 3. Required disclaimers.
  const flat = norm(text);
  for (const d of policy.disclaimers) {
    if (d.formats.length && !d.formats.includes(type)) continue;
    const triggered =
      d.when === 'always' ||
      (d.when === 'promotion' && promotion) ||
      (d.when === 'terms' && d.terms.some((t) => phraseRe(t).test(text)));
    if (!triggered) continue;
    checked.disclaimer += 1;
    const present =
      flat.includes(norm(d.text)) ||
      (d.id === PROMO_DISCLAIMER_ID &&
        /(terms (and conditions |& conditions )?apply|t ?& ?cs? apply|see terms|conditions apply)/i.test(
          text,
        )) ||
      (d.id === RESPONSIBLE_ID && /(enjoy|drink) responsibly/i.test(text));
    if (present) continue;
    add({
      ruleId: `workspace.disclaimer.${d.id}`,
      category: 'disclaimer',
      outcome: d.severity === 'block' ? 'fail' : 'review',
      message: `Missing the required disclaimer “${d.text}”${d.when === 'promotion' ? ' (this is a promotion)' : d.when === 'terms' ? ' (it mentions a term that needs it)' : ''}.`,
      quote: null,
      fix: `Add “${d.text}”.`,
      source: 'workspace',
    });
  }

  // 4. Call to action rules.
  const ctaText = input.cta || '';
  if (policy.cta.requiredFor.includes(type)) {
    checked.cta += 1;
    if (!ctaText.trim()) {
      add({
        ruleId: 'workspace.cta.required',
        category: 'cta',
        outcome: 'fail',
        message: 'This format must carry a call to action (workspace rule).',
        quote: null,
        fix: 'Add a clear next step.',
        source: 'workspace',
      });
    }
  }
  for (const b of policy.cta.bannedPhrases) {
    checked.cta += 1;
    const re = phraseRe(b);
    if (re.test(text)) {
      add({
        ruleId: `workspace.cta.banned.${norm(b).replace(/\s+/g, '-')}`,
        category: 'cta',
        outcome: 'fail',
        message: `Uses the call to action “${b}”, which this business does not use.`,
        quote: sentenceWith(text, re),
        fix: 'Point people somewhere the business actually answers.',
        source: 'workspace',
      });
    }
  }
  const allowed = new Set(
    [
      hostOf(input.website),
      ...policy.cta.allowedLinkDomains.map(hostOf),
    ].filter(Boolean) as string[],
  );
  checked.cta += 1;
  for (const m of text.matchAll(LINK)) {
    const host = (m[1] ?? m[2] ?? '')
      .replace(/^www\./, '')
      .replace(/[.,;:!?]+$/, '')
      .toLowerCase();
    if (!host || [...allowed].some((a) => host === a || host.endsWith(`.${a}`)))
      continue;
    add({
      ruleId: `workspace.cta.link.${host}`,
      category: 'cta',
      outcome: 'review',
      message: `Links to ${host}, which is not one of this business’s domains.`,
      quote: m[0],
      fix: allowed.size
        ? `Check the link is intended, or add the domain in Settings → Compliance.`
        : 'Add your website in Settings so your own links are recognised.',
      source: 'workspace',
    });
  }

  // 5. Manual-review triggers.
  const mr = policy.manualReview;
  checked.manual_review += 1;
  if (mr.formats.includes(type)) {
    add({
      ruleId: `workspace.review.format.${type}`,
      category: 'manual_review',
      outcome: 'review',
      message: 'This format always needs a person’s review (workspace rule).',
      quote: null,
      fix: null,
      source: 'workspace',
    });
  }
  if (platform && mr.channels.includes(platform)) {
    add({
      ruleId: `workspace.review.channel.${platform}`,
      category: 'manual_review',
      outcome: 'review',
      message: `Everything for ${platform.charAt(0)}${platform.slice(1).toLowerCase()} needs a person’s review (workspace rule).`,
      quote: null,
      fix: null,
      source: 'workspace',
    });
  }
  for (const t of mr.terms) {
    checked.manual_review += 1;
    const re = phraseRe(t);
    if (re.test(text)) {
      add({
        ruleId: `workspace.review.term.${norm(t).replace(/\s+/g, '-')}`,
        category: 'manual_review',
        outcome: 'review',
        message: `Mentions “${t}”, which needs a person’s review (workspace rule).`,
        quote: sentenceWith(text, re),
        fix: null,
        source: 'workspace',
      });
    }
  }
  if (mr.competitorMentions) {
    checked.manual_review += 1;
    const named = input.competitors.find(
      (c) => c.trim().length > 1 && phraseRe(c).test(text),
    );
    if (named) {
      add({
        ruleId: 'workspace.review.competitor',
        category: 'manual_review',
        outcome: 'review',
        message: `Names a competitor (${named}) — comparative claims need a person’s check.`,
        quote: sentenceWith(text, phraseRe(named)),
        fix: 'Check any comparison is fair and accurate.',
        source: 'workspace',
      });
    }
  }
  if (mr.prices) {
    checked.manual_review += 1;
    if (PRICE.test(text)) {
      add({
        ruleId: 'workspace.review.price',
        category: 'manual_review',
        outcome: 'review',
        message:
          'States a price — prices need a person’s check (workspace rule).',
        quote: sentenceWith(text, PRICE),
        fix: 'Confirm the price is current.',
        source: 'workspace',
      });
    }
  }
  if (mr.giveaways) {
    checked.manual_review += 1;
    if (giveaway) {
      add({
        ruleId: 'workspace.review.giveaway',
        category: 'manual_review',
        outcome: 'review',
        message:
          'A giveaway or contest — entry rules and eligibility need a person’s check.',
        quote: sentenceWith(text, GIVEAWAY),
        fix: 'Check the rules, eligibility and closing date are stated.',
        source: 'workspace',
      });
    }
  }

  // 6. The deterministic checks, under the same categories.
  for (const i of input.rules) {
    const category = QUALITY_CATEGORY[i.code];
    if (!category) continue;
    // The fact check decides factual claims when it ran.
    if (category === 'factual' && input.claims && i.code !== 'facts-changed')
      continue;
    add({
      ruleId: `rules.${i.code}`,
      category,
      outcome: i.severity === 'block' ? 'fail' : 'warn',
      message: i.message,
      quote: null,
      fix: null,
      source: 'rules',
    });
  }
  // What those checks covered: the five alcohol-code rules, the brand's
  // never-mention topics, and the format's length and hashtag limits.
  if (input.alcohol) checked.prohibited_claim += 5;
  checked.business += 1;
  checked.channel += 1;

  // 7. Factual and product claims.
  if (input.claims) {
    checked.factual += input.claims.length;
    for (const c of input.claims) {
      if (c.status === 'supported') continue;
      add({
        ruleId: `fact.${norm(c.text).slice(0, 60).replace(/\s+/g, '-')}`,
        category: 'factual',
        outcome: c.mustFix ? 'fail' : 'review',
        message: c.reason,
        quote: c.text,
        fix: c.mustFix
          ? 'Correct it to match the business details or evidence, or remove it.'
          : 'Check it is true.',
        source: 'fact_check',
      });
    }
  }

  const order: Record<ComplianceOutcome, number> = {
    fail: 0,
    review: 1,
    warn: 2,
  };
  findings.sort((a, b) => order[a.outcome] - order[b.outcome]);
  return {
    version: POLICY_VERSION,
    status: findings.some((f) => f.outcome === 'fail')
      ? 'fail'
      : findings.some((f) => f.outcome === 'review')
        ? 'review'
        : 'pass',
    findings,
    checked,
    packs,
    policyHash: policyHash(policy, input.alcohol),
  };
}

// ---------------------------------------------------------------------------
// The writer is told the same rules
// ---------------------------------------------------------------------------

export function policyToPrompt(
  policy: CompliancePolicy,
  alcohol: boolean,
  type?: ContentTypeKey,
): string {
  const lines: string[] = [];
  const packs = activePacks(policy, alcohol);
  if (packs.includes('general')) {
    lines.push(
      '- No “risk-free”, “miracle”, “get rich” or “instant results” promises; no guarantee unless the business documents one.',
    );
  }
  if (packs.includes('health'))
    lines.push(
      '- Never claim to cure, treat or prevent an illness; no “clinically proven” unless documented.',
    );
  if (packs.includes('financial')) {
    lines.push(
      '- Never promise returns. Anything about returns or investing ends with: "Past performance does not guarantee future results. Capital at risk."',
    );
  }
  if (policy.prohibited.length) {
    lines.push(
      `- Never use these words or phrases: ${policy.prohibited.map((p) => `“${p.phrase}”`).join(', ')}.`,
    );
  }
  for (const d of policy.disclaimers) {
    if (type && d.formats.length && !d.formats.includes(type)) continue;
    const when =
      d.when === 'always'
        ? 'Always include'
        : d.when === 'promotion'
          ? 'On any promotion, discount, sale or giveaway, include'
          : `When mentioning ${d.terms.map((t) => `“${t}”`).join(' or ')}, include`;
    lines.push(`- ${when} this exact line: "${d.text}"`);
  }
  if (policy.cta.bannedPhrases.length) {
    lines.push(
      `- Never use these calls to action: ${policy.cta.bannedPhrases.map((p) => `“${p}”`).join(', ')}.`,
    );
  }
  if (policy.cta.allowedLinkDomains.length) {
    lines.push(
      `- Only link to the business's own website or: ${policy.cta.allowedLinkDomains.join(', ')}.`,
    );
  }
  lines.push(
    '- A giveaway on Instagram or Facebook must say it is not sponsored, endorsed or administered by, or associated with, the network.',
  );
  lines.push('- No engagement bait (“comment YES”, “tag a friend”).');
  return lines.length
    ? `COMPLIANCE RULES FOR THIS BUSINESS (checked before approval):\n${lines.join('\n')}`
    : '';
}
