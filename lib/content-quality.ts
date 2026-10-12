import { unsupportedNumbers } from '@/lib/ai-opportunity-detection';
import { ROBOTIC_PHRASES, type CopyLimits } from '@/lib/content-playbook';
import { bodySchemaFor, type ContentTypeKey } from '@/lib/validations/content';

/**
 * Content quality and compliance: checks every generated (or edited) draft
 * against the rules, rather than trusting the model to have followed them.
 *
 * Until now the brand's rules lived only in the prompt — banned phrases, "no
 * invented claims", the voice's "never mention" list — and nothing looked at
 * what came back. This reads the copy and reports, deterministically:
 *
 *   BLOCK  must be fixed before the draft can be approved
 *          · alcohol compliance (minors, excess, health or social-success
 *            claims, drink-driving)
 *          · a topic the brand said never to mention
 *          · copy over the destination's hard length limit
 *          · claims the material does not support (guarantees, rankings,
 *            awards, invented figures)
 *   WARN   worth a look, does not stop approval
 *          · robotic / filler phrases, repetition, over the ideal length,
 *            hashtag count, no call to action
 *
 * plus safe automatic fixes (hashtag clean-up; a responsible-drinking line for
 * alcohol brands). Pure and client-safe.
 */

export type IssueSeverity = 'block' | 'warn';

export interface QualityIssue {
  code:
    | 'alcohol-minors'
    | 'alcohol-excess'
    | 'alcohol-health'
    | 'alcohol-social'
    | 'alcohol-driving'
    | 'avoid-topic'
    | 'too-long'
    | 'unsupported-claim'
    | 'unsupported-number'
    | 'robotic-phrase'
    | 'repetition'
    | 'long'
    | 'hashtags'
    | 'no-cta'
    /** A variation changed a fact from the original (lib/content-variations.ts). */
    | 'facts-changed';
  severity: IssueSeverity;
  message: string;
}

export interface QualityReport {
  issues: QualityIssue[];
  /** Automatic fixes applied to the body. */
  fixes: string[];
  /** Whether alcohol rules applied. */
  alcohol: boolean;
  /** No blocking issue remains. */
  approvable: boolean;
}

// ---------------------------------------------------------------------------
// Alcohol
// ---------------------------------------------------------------------------

const ALCOHOL_WORDS = [
  'alcohol',
  'alcoholic',
  'spirits',
  'liquor',
  'whiskey',
  'whisky',
  'bourbon',
  'scotch',
  'vodka',
  'gin',
  'rum',
  'tequila',
  'mezcal',
  'brandy',
  'cognac',
  'wine',
  'winery',
  'vineyard',
  'champagne',
  'prosecco',
  'beer',
  'brewery',
  'brewing company',
  'craft beer',
  'ale',
  'lager',
  'cider',
  'sake',
  'distillery',
  'distilling',
  'cocktail',
  'cocktails',
  'liqueur',
  'hard seltzer',
];

/** Is this an alcohol brand? Read from what the business says it does. */
export function isAlcoholBusiness(
  texts: (string | null | undefined)[],
): boolean {
  const hay = ` ${texts
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')} `;
  return ALCOHOL_WORDS.some((w) => hay.includes(` ${w} `));
}

/** The standard line added when an alcohol post has none. */
export const RESPONSIBLE_LINE = 'Please enjoy responsibly.';
const RESPONSIBLE_RE =
  /\b(enjoy|drink|sip|savou?r|celebrate) (it )?responsibly\b|\bresponsibl[ey] drinking\b|\b(18|19|21)\s?\+|\blegal drinking age\b|\bLDA\b/i;

/** Rules for alcohol marketing, after common industry codes (e.g. DISCUS, Portman Group, ASCI). */
const ALCOHOL_RULES: {
  code: QualityIssue['code'];
  re: RegExp;
  message: string;
}[] = [
  {
    code: 'alcohol-minors',
    re: /\b(kids?|children|child|teens?|teenagers?|students?|back[- ]to[- ]school|young people|under ?(18|21)|underage|minors?|cartoons?)\b/i,
    message: 'Alcohol copy must not mention or appeal to minors.',
  },
  {
    code: 'alcohol-excess',
    re: /\b(chug|binge|get (wasted|drunk|hammered|smashed)|wasted|hammered|smashed|blackout|bottomless|unlimited drinks|drink all night|down it|shots?,? shots|can'?t stop drinking|drink (more|faster))\b/i,
    message: 'Alcohol copy must not encourage excessive or rapid drinking.',
  },
  {
    code: 'alcohol-health',
    re: /\b(healthy|health benefits?|good for you|cures?|medicinal|therapeutic|relieves? stress|stress relief|boosts? (your )?(mood|energy|immunity)|detox|guilt[- ]free)\b/i,
    message: 'Alcohol copy must not make health, therapeutic or mood claims.',
  },
  {
    code: 'alcohol-social',
    re: /\b(makes? you (more )?(popular|attractive|sexy|confident|successful)|sexier|irresistible|life of the party|liquid courage|confidence boost)\b/i,
    message:
      'Alcohol copy must not link drinking to social, sexual or professional success.',
  },
  {
    code: 'alcohol-driving',
    re: /\b(drink(ing)? and driv(e|ing)|behind the wheel|one for the road|before (you|they) drive)\b/i,
    message: 'Alcohol copy must never connect drinking with driving.',
  },
];

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const CLAIM_RE =
  /\b(best in (the )?(world|country|town|business)|world'?s best|#1|number one|no\.? ?1|award[- ]winning|guaranteed?|100% (natural|organic|satisfaction|guaranteed)|clinically (proven|tested)|scientifically proven|risk[- ]free|never fails|unbeatable|the only [a-z]+ (that|who|to))\b/i;

// ---------------------------------------------------------------------------
// Reading a body
// ---------------------------------------------------------------------------

export interface CopyParts {
  /** All visible copy, in reading order. */
  text: string;
  hashtags: string[];
  cta: string;
  /** The longest single unit that a hard limit applies to (a tweet, a caption). */
  longestUnit: number;
  /** Total visible length. */
  totalChars: number;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const arr = (v: unknown) => (Array.isArray(v) ? v : []);

/** The visible copy of a body, by type. */
export function copyParts(type: ContentTypeKey, body: unknown): CopyParts {
  const b = (body ?? {}) as Record<string, unknown>;
  let units: string[] = [];
  switch (type) {
    case 'LINKEDIN_POST':
      units = [
        [str(b.hook), ...arr(b.paragraphs).map(str), str(b.cta)].join('\n\n'),
      ];
      break;
    case 'IMAGE_POST':
      units = [[str(b.caption), str(b.cta)].join('\n\n')];
      break;
    case 'CAROUSEL':
      units = [
        str(b.title),
        ...arr(b.slides).map((s) => {
          const x = (s ?? {}) as Record<string, unknown>;
          return `${str(x.headline)} ${str(x.body)}`;
        }),
        str(b.cta),
      ];
      break;
    case 'TWEET_THREAD':
      units = arr(b.tweets).map(str);
      break;
    case 'BLOG':
      units = [
        str(b.headline),
        str(b.subtitle),
        ...arr(b.sections).map((s) => {
          const x = (s ?? {}) as Record<string, unknown>;
          return `${str(x.heading)}\n${str(x.body)}`;
        }),
      ];
      break;
    case 'EMAIL':
      units = [
        str(b.subjectLine),
        str(b.previewText),
        [
          str(b.greeting),
          ...arr(b.paragraphs).map(str),
          str(b.cta),
          str(b.signOff),
        ].join('\n\n'),
      ];
      break;
    case 'AD':
      units = [
        str(b.primaryText),
        str(b.headline),
        str(b.description),
        str(b.cta),
      ];
      break;
    case 'CAMPAIGN_COPY':
      units = [
        str(b.tagline),
        str(b.keyMessage),
        str(b.shortCopy),
        str(b.longCopy),
        ...arr(b.proofPoints).map(str),
        str(b.cta),
      ];
      break;
    case 'PROMO':
      units = [
        str(b.headline),
        [str(b.offer), str(b.body), str(b.urgency), str(b.terms), str(b.cta)]
          .filter(Boolean)
          .join('\n\n'),
      ];
      break;
  }
  const hashtags = arr(b.hashtags ?? b.tags)
    .map(str)
    .filter(Boolean);
  const text = units.filter(Boolean).join('\n\n');
  const tagsLen = hashtags.reduce((n, h) => n + h.length + 2, 0);
  return {
    text,
    hashtags,
    cta: str(b.cta),
    // For a single-unit post, hashtags count against the limit too.
    longestUnit:
      Math.max(0, ...units.map((u) => u.length)) +
      (type === 'IMAGE_POST' || type === 'LINKEDIN_POST' ? tagsLen : 0),
    totalChars: text.length + tagsLen,
  };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export interface QualityContext {
  limits: CopyLimits;
  /** Everything the copy may draw facts from: business facts, brief, knowledge. */
  sources: string;
  /** Topics the brand never mentions. */
  avoid: string[];
  alcohol: boolean;
  /**
   * The format or the brief requires a call to action
   * (lib/content-formats.ts): a missing one blocks approval, so the writer is
   * asked to add it, instead of being a warning that can ship.
   */
  ctaRequired?: boolean;
  now?: Date;
}

const STOP = new Set([
  'about',
  'their',
  'there',
  'which',
  'would',
  'could',
  'should',
  'these',
  'those',
  'where',
  'while',
  'every',
  'other',
  'being',
  'after',
  'before',
  'because',
  'through',
]);

export function checkQuality(
  type: ContentTypeKey,
  body: unknown,
  ctx: QualityContext,
): Omit<QualityReport, 'fixes'> {
  const parts = copyParts(type, body);
  const text = parts.text;
  const all = `${text}\n${parts.hashtags.join(' ')}`;
  const lower = text.toLowerCase();
  const issues: QualityIssue[] = [];
  const push = (i: QualityIssue) => {
    if (!issues.some((x) => x.code === i.code && x.message === i.message))
      issues.push(i);
  };

  // Alcohol compliance.
  if (ctx.alcohol) {
    for (const r of ALCOHOL_RULES) {
      const m = all.match(r.re);
      if (m)
        push({
          code: r.code,
          severity: 'block',
          message: `${r.message} (“${m[0]}”)`,
        });
    }
  }

  // The brand's never-mention list.
  for (const topic of ctx.avoid) {
    const t = topic.trim().toLowerCase();
    if (t.length >= 3 && lower.includes(t)) {
      push({
        code: 'avoid-topic',
        severity: 'block',
        message: `Mentions “${topic}”, which the brand never talks about.`,
      });
    }
  }

  // Length.
  if (parts.longestUnit > ctx.limits.hardMaxChars) {
    push({
      code: 'too-long',
      severity: 'block',
      message: `Too long for where it runs: ${parts.longestUnit} characters (limit ${ctx.limits.hardMaxChars}).`,
    });
  } else if (parts.totalChars > ctx.limits.softMaxChars) {
    push({
      code: 'long',
      severity: 'warn',
      message: `Longer than works best here: ${parts.totalChars} characters (aim under ${ctx.limits.softMaxChars}).`,
    });
  }

  // Claims the material does not support.
  const claim = text.match(CLAIM_RE);
  if (claim && !ctx.sources.toLowerCase().includes(claim[0].toLowerCase())) {
    push({
      code: 'unsupported-claim',
      severity: 'block',
      message: `Makes a claim the business’s material does not support (“${claim[0]}”).`,
    });
  }
  const invented = unsupportedNumbers(text, ctx.sources, ctx.now ?? new Date());
  if (invented.length) {
    push({
      code: 'unsupported-number',
      severity: 'block',
      message: `States ${invented.slice(0, 3).join(', ')}, which nothing in the business’s material supports.`,
    });
  }

  // Robotic phrasing.
  const robotic = ROBOTIC_PHRASES.filter((p) => lower.includes(p));
  if (robotic.length) {
    push({
      code: 'robotic-phrase',
      severity: 'warn',
      message: `Sounds machine-written: ${robotic
        .slice(0, 3)
        .map((p) => `“${p}”`)
        .join(', ')}.`,
    });
  }

  // Repetition: sentence openings and overused words.
  const openings = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim().toLowerCase().split(/\s+/).slice(0, 2).join(' '))
    .filter((s) => s.length > 3);
  const repeatedOpening = [...new Set(openings)].find(
    (o) => openings.filter((x) => x === o).length >= 3,
  );
  if (repeatedOpening) {
    push({
      code: 'repetition',
      severity: 'warn',
      message: `Several sentences start the same way (“${repeatedOpening}…”).`,
    });
  }
  const counts = new Map<string, number>();
  for (const w of lower.match(/\b[a-z]{5,}\b/g) ?? []) {
    if (!STOP.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const limit = parts.totalChars < 1500 ? 4 : 8;
  const overused = [...counts].filter(([, n]) => n > limit).map(([w]) => w);
  if (overused.length) {
    push({
      code: 'repetition',
      severity: 'warn',
      message: `Repeats “${overused[0]}” ${counts.get(overused[0]!)} times.`,
    });
  }

  // Hashtags and CTA.
  if (parts.hashtags.length > ctx.limits.hashtagMax) {
    push({
      code: 'hashtags',
      severity: 'warn',
      message: `${parts.hashtags.length} hashtags (aim for ${ctx.limits.hashtagMax} or fewer here).`,
    });
  }
  if (
    ctx.limits.ctaExpected &&
    'cta' in ((body ?? {}) as object) &&
    !parts.cta.trim()
  ) {
    push({
      code: 'no-cta',
      severity: ctx.ctaRequired ? 'block' : 'warn',
      message: ctx.ctaRequired
        ? 'No call to action, and this format needs one — say what the reader should do next.'
        : 'No call to action — say what the reader should do next.',
    });
  }

  return {
    issues,
    alcohol: ctx.alcohol,
    approvable: !issues.some((i) => i.severity === 'block'),
  };
}

// ---------------------------------------------------------------------------
// Safe automatic fixes
// ---------------------------------------------------------------------------

/**
 * Fixes that never change what the copy says: tidy hashtags (no "#", no
 * duplicates, within the limit) and, for alcohol brands, add a responsible-
 * drinking line when the copy has none. Returns the fixed body (validated)
 * and what was done.
 */
export function applySafeFixes(
  type: ContentTypeKey,
  body: unknown,
  ctx: Pick<QualityContext, 'limits' | 'alcohol'>,
): { body: unknown; fixes: string[] } {
  const b = { ...((body ?? {}) as Record<string, unknown>) };
  const fixes: string[] = [];

  const key =
    'hashtags' in b
      ? 'hashtags'
      : 'tags' in b && type === 'BLOG'
        ? 'tags'
        : null;
  if (key && Array.isArray(b[key])) {
    const before = b[key] as string[];
    const seen = new Set<string>();
    const cleaned = before
      .map((h) => String(h).replace(/^#+/, '').trim())
      .filter(
        (h) =>
          h && !seen.has(h.toLowerCase()) && (seen.add(h.toLowerCase()), true),
      );
    const max = type === 'BLOG' ? 10 : ctx.limits.hashtagMax;
    const kept = cleaned.slice(0, max);
    if (kept.length !== before.length || kept.some((h, i) => h !== before[i])) {
      b[key] = kept;
      fixes.push(
        kept.length < cleaned.length
          ? `Trimmed hashtags to ${kept.length}.`
          : 'Tidied hashtags.',
      );
    }
  }

  if (ctx.alcohol && type !== 'BLOG') {
    const text = copyParts(type, b).text;
    if (!RESPONSIBLE_RE.test(text)) {
      const field =
        type === 'IMAGE_POST'
          ? 'caption'
          : type === 'AD'
            ? 'primaryText'
            : type === 'EMAIL' || type === 'LINKEDIN_POST'
              ? 'paragraphs'
              : type === 'TWEET_THREAD'
                ? 'tweets'
                : type === 'CAROUSEL'
                  ? 'cta'
                  : null;
      if (field === 'paragraphs' || field === 'tweets') {
        const list = [...(b[field] as string[])];
        const last = list.length - 1;
        const next = `${list[last]} ${RESPONSIBLE_LINE}`;
        if (field === 'paragraphs' || next.length <= 280) {
          list[last] = next;
          b[field] = list;
          fixes.push('Added a responsible-drinking line.');
        }
      } else if (field) {
        b[field] =
          `${String(b[field] ?? '').trim()} ${RESPONSIBLE_LINE}`.trim();
        fixes.push('Added a responsible-drinking line.');
      }
    }
  }

  const parsed = bodySchemaFor(type).safeParse(b);
  return parsed.success ? { body: parsed.data, fixes } : { body, fixes: [] };
}

/** The issues as feedback a writer (or model) can act on. */
export function issuesAsFeedback(issues: QualityIssue[]): string {
  return issues.map((i) => `- ${i.message}`).join('\n');
}
