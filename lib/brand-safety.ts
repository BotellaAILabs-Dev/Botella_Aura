/**
 * BRAND SAFETY — whether a piece of source material is something this brand
 * can market off, and whether the copy written from it kept the source's
 * register.
 *
 * Why this exists: Market Trends found a news story about people dying, and
 * Content Studio wrote a LinkedIn post promoting whiskey as "bringing people
 * together". Nothing in the pipeline was wrong on its own terms — the writer
 * was handed a `Suggested angle` and followed it. What was missing was anyone
 * asking whether the story should become promotional content at all.
 *
 * So there are two checks here, and they are deliberately separate:
 *
 *   1. classifySource() — reads the SOURCE (a trend summary, a fetched page,
 *      a brief) and decides a posture. Deterministic, so a tragedy is caught
 *      even when the model is down, over quota, or agreeable.
 *   2. toneMismatch() — reads the COPY against that posture and catches
 *      celebratory or sales language on a source that cannot carry it. Only
 *      ever applied when the source is not clear, because "celebrate",
 *      "don't miss" and "raise a glass" are perfectly good marketing on
 *      ordinary material.
 *
 * Both are pure and client-safe: the studio shows the same verdict the server
 * enforces, so a blocked piece is never a surprise.
 *
 * Deliberately NOT an AI judgment call. A model asked "is this sensitive?"
 * agrees with whatever framing it is given, and this is the check that has to
 * hold when the model is the thing that got it wrong.
 */

export const SENSITIVE_TOPICS = [
  'death',
  'violence',
  'conflict',
  'self_harm',
  'missing',
  'disaster',
  'injury',
  'illness',
  'hardship',
  'legal',
  'discrimination',
] as const;
export type SensitiveTopic = (typeof SENSITIVE_TOPICS)[number];

/**
 * clear — ordinary material, market off it freely.
 * caution — real human cost in it; it can be written about, but not sold off.
 * unsuitable — someone died, was hurt deliberately, or is in crisis. This is
 *   never promotional material, in any framing.
 */
export type SafetyPosture = 'clear' | 'caution' | 'unsuitable';

export interface SafetyHit {
  topic: SensitiveTopic;
  /** The words that matched, for the explanation shown to the person. */
  matched: string;
}

export interface SourceSafety {
  posture: SafetyPosture;
  hits: SafetyHit[];
  /** One sentence for the UI and the audit record; null when clear. */
  reason: string | null;
}

export const TOPIC_LABEL: Record<SensitiveTopic, string> = {
  death: 'deaths or fatalities',
  violence: 'violence or an attack',
  conflict: 'war or armed conflict',
  self_harm: 'suicide, overdose or self-harm',
  missing: 'a missing person or a search',
  disaster: 'a disaster or emergency',
  injury: 'people injured or hospitalised',
  illness: 'serious illness',
  hardship: 'job losses or financial hardship',
  legal: 'criminal or legal proceedings',
  discrimination: 'discrimination, hate or harassment',
};

/** Topics that make a source unsuitable for promotion outright. */
const GRAVE: readonly SensitiveTopic[] = [
  'death',
  'violence',
  'conflict',
  'self_harm',
  'missing',
];

/**
 * Marketing idioms that borrow the vocabulary of harm.
 *
 * These are stripped BEFORE matching, because every one of them is a phrase a
 * perfectly ordinary B2B post uses, and a brand-safety check that cries wolf
 * on "killer feature" gets switched off within a week. Order matters: longer
 * phrases first, so "price war" is gone before `\bwar\b` is looked for.
 */
const IDIOMS: RegExp[] = [
  /\bkiller\s+(?:feature|app|deal|instinct|product|idea|line)\b/gi,
  /\b(?:killed|killing|kill)\s+it\b/gi,
  /\bkilling\s+time\b/gi,
  /\bdead\s+(?:simple|easy|right|centre|center|obvious|certain|serious|wrong|set)\b/gi,
  /\bdead\s+of\s+(?:night|winter)\b/gi,
  /\bdying\s+to\b/gi,
  /\bto\s+die\s+for\b/gi,
  /\b(?:price|bidding|turf|talent|format|streaming|trade)\s+war\b/gi,
  /\bwar\s+(?:room|chest|for\s+talent|of\s+words)\b/gi,
  /\bflooded\s+with\b/gi,
  /\ba\s+flood\s+of\b/gi,
  /\battack\s+(?:the|this|that|a|an)\s+(?:problem|challenge|market|issue|backlog)\b/gi,
  /\bpanic\s+(?:buying|selling)\b/gi,
  /\bcrash\s+course\b/gi,
  /\bbrain\s+drain\b/gi,
  /\bpain\s+point/gi,
  /\bfire\s+(?:drill|up|away)\b/gi,
  /\bon\s+fire\b/gi,
  /\bsmash\w*\s+(?:it|records?|targets?)\b/gi,
  /\bcrush\w*\s+(?:it|the\s+competition|targets?)\b/gi,
  /\bblow\w*\s+up\b/gi,
  /\bbleeding\s+edge\b/gi,
  /\bsurviv\w+\s+guide\b/gi,
  /\bmissing\s+(?:piece|link|out|ingredient)\b/gi,
  /\bdisaster\s+recovery\b/gi,
  /\b(?:data|security)\s+breach\b/gi,
  /\bfraud\s+(?:detection|prevention)\b/gi,
  /\brecall\s+(?:that|the\s+time|how)\b/gi,
  /\bcancer\s+(?:research|awareness|charity|screening|moonshot)\b/gi,
  /\baddict\w*\s+to\s+(?:our|the|this)\b/gi,
];

/** Topic patterns. Matched against text with the idioms already removed. */
const PATTERNS: { topic: SensitiveTopic; re: RegExp }[] = [
  {
    topic: 'death',
    re: /\b(?:died|dies|dead|death|deaths|deceased|fatal|fatally|fatalit\w+|killed|kills|murder\w*|homicide|manslaughter|obituar\w+|funeral|mourn\w+|bereave\w+|condolence\w*|passed\s+away|lost\s+(?:his|her|their)\s+(?:life|lives)|loss\s+of\s+life|death\s+toll|body\s+(?:was\s+)?found|bodies\s+(?:were\s+)?(?:found|recovered))\b/i,
  },
  {
    topic: 'violence',
    re: /\b(?:shooting|shootings|gunman|gunmen|shot\s+(?:dead|and\s+killed)|stabb\w+|assaulted|assailant|attacker|attackers|terror(?:ism|ist|ists)|bombing|bombings|explosion|detonat\w+|riot|riots|rioting|kidnap\w+|abduct\w+|traffick\w+|hostage\w*|massacre\w*|lynch\w+|domestic\s+(?:violence|abuse)|child\s+abuse|sexual\s+(?:assault|abuse))\b/i,
  },
  {
    topic: 'conflict',
    re: /\b(?:war|warfare|wartime|invasion|invaded|airstrike\w*|air\s+strikes?|shelling|genocide|ethnic\s+cleansing|refugee\s+crisis|ceasefire|military\s+offensive|armed\s+conflict|insurgen\w+|war\s+crimes?)\b/i,
  },
  {
    topic: 'self_harm',
    re: /\b(?:suicid\w+|self[-\s]harm\w*|overdos\w+|took\s+(?:his|her|their)\s+own\s+life|eating\s+disorder\w*)\b/i,
  },
  {
    topic: 'missing',
    re: /\b(?:missing\s+persons?|went\s+missing|reported\s+missing|search\s+and\s+rescue|feared\s+(?:dead|drowned|lost))\b/i,
  },
  {
    topic: 'disaster',
    re: /\b(?:earthquake\w*|tsunami\w*|hurricane\w*|cyclone\w*|typhoon\w*|tornado\w*|wildfire\w*|landslide\w*|mudslide\w*|avalanche\w*|flood|floods|flooding|flooded|famine|drought|evacuat\w+|state\s+of\s+emergency|natural\s+disaster|catastroph\w+|plane\s+crash|train\s+(?:crash|derail\w*)|derail\w+|building\s+collapse|collapsed\s+building|bridge\s+collapse|outbreak|epidemic|pandemic|oil\s+spill|toxic\s+(?:spill|leak))\b/i,
  },
  {
    topic: 'injury',
    re: /\b(?:injur\w+|wounded|hospitalis\w+|hospitaliz\w+|critical\s+condition|life[-\s]threatening|intensive\s+care|life\s+support|maimed|casualt\w+|burn\s+(?:victims?|unit)|paralys\w+|paralyz\w+)\b/i,
  },
  {
    topic: 'illness',
    re: /\b(?:cancer|tumour\w*|tumor\w*|terminal(?:ly)?\s+ill\w*|terminal\s+(?:illness|diagnosis)|hospice|palliative|chemotherapy|life[-\s]limiting|mental\s+health\s+crisis|addiction\s+crisis|opioid\s+(?:crisis|epidemic))\b/i,
  },
  {
    topic: 'hardship',
    re: /\b(?:layoffs?|laid\s+off|job\s+(?:cuts|losses)|redundanc\w+|mass\s+(?:firings?|dismissals?)|bankrupt\w*|insolven\w+|liquidation|administration\s+filing|foreclosur\w+|evict\w+|homeless\w*|destitut\w+|poverty|food\s+bank\w*|cost[-\s]of[-\s]living\s+crisis)\b/i,
  },
  {
    topic: 'legal',
    re: /\b(?:lawsuit\w*|sued|litigation|indict\w+|convict(?:ed|ion)|sentenc(?:ed|ing)\s+to|arrest(?:ed|s)?|charged\s+with|criminal\s+charges|class\s+action|product\s+recall|safety\s+recall|recalled\s+(?:over|after|due)|investigation\s+into|guilty\s+(?:plea|verdict)|fined\s+(?:\$|£|€)?\d)\b/i,
  },
  {
    topic: 'discrimination',
    re: /\b(?:racis\w+|sexis\w+|homophob\w+|transphob\w+|antisemit\w+|islamophob\w+|xenophob\w+|hate\s+(?:crime|speech)|harassment|discriminat\w+|slurs?)\b/i,
  },
];

/**
 * Celebratory and sales language.
 *
 * Only ever consulted when the source is not clear. On a tragedy, every one of
 * these is the whiskey post: the words themselves are fine, their presence on
 * this particular source is not.
 */
const PROMOTIONAL: RegExp[] = [
  /\b(?:celebrat\w+|cheers|toast(?:ing)?\s+to|raise\s+a\s+glass|clink|festive|party|parties|revel\w*)\b/i,
  /\b(?:perfect\s+(?:time|moment|excuse)|what\s+better\s+(?:time|way)|no\s+better\s+time|now'?s\s+the\s+time)\b/i,
  /\b(?:treat\s+your\s?self|indulge|unwind|savou?r|sip|pour\s+(?:yourself|one)|enjoy\s+a)\b/i,
  /\b(?:don'?t\s+miss|limited\s+time|while\s+stocks\s+last|grab\s+(?:yours|one)|shop\s+now|order\s+now|buy\s+now|book\s+now|sign\s+up\s+now|act\s+now)\b/i,
  /\b(?:sale|discount\w*|offer\s+ends|special\s+offer|deal\s+of\s+the|promo\s+code|% off)\b/i,
  /\b(?:thrilled|delighted|excited\s+to|exciting\s+news|can'?t\s+wait|great\s+news|good\s+times)\b/i,
  /\b(?:brings?\s+people\s+together|bringing\s+people\s+together|better\s+together|here'?s\s+to)\b/i,
  // Party popper, confetti, partying face, champagne, beer, clinking beers,
  // tumbler, clinking glasses, cocktail, wine, sparkles, raised hands.
  /[\u{1F389}\u{1F38A}\u{1F973}\u{1F37E}\u{1F37A}\u{1F37B}\u{1F943}\u{1F942}\u{1F378}\u{1F377}\u{2728}\u{1F64C}]/u,
];

/** Strip the idioms so they cannot trigger a topic. */
function deIdiom(text: string): string {
  let out = text;
  for (const re of IDIOMS) out = out.replace(re, ' ');
  return out;
}

/**
 * Read source material and decide whether it can be marketed off.
 *
 * `text` is everything the writer will be grounded in: the trend title and
 * summary, the fetched page, the person's own brief. Only the first 12k
 * characters are read — a sensitive story says so near the top, and an
 * unbounded scan on a long page is a cost with no payoff.
 */
export function classifySource(text: string | null | undefined): SourceSafety {
  const raw = (text ?? '').slice(0, 12_000);
  if (raw.trim().length < 20) return { posture: 'clear', hits: [], reason: null };

  const cleaned = deIdiom(raw);
  const hits: SafetyHit[] = [];
  for (const { topic, re } of PATTERNS) {
    const m = cleaned.match(re);
    if (m) hits.push({ topic, matched: m[0].toLowerCase().replace(/\s+/g, ' ') });
  }
  if (!hits.length) return { posture: 'clear', hits: [], reason: null };

  const grave = hits.filter((h) => GRAVE.includes(h.topic));
  const posture: SafetyPosture = grave.length ? 'unsuitable' : 'caution';
  const named = (grave.length ? grave : hits).slice(0, 3);

  return {
    posture,
    hits,
    reason:
      posture === 'unsuitable'
        ? `This source is about ${list(named.map((h) => TOPIC_LABEL[h.topic]))} (“${named[0]!.matched}”). It is not something to market off.`
        : `This source involves ${list(named.map((h) => TOPIC_LABEL[h.topic]))} (“${named[0]!.matched}”), so it needs careful, non-promotional handling.`,
  };
}

/** Promotional phrases present in a piece of copy. */
export function promotionalPhrases(copy: string): string[] {
  const found: string[] = [];
  for (const re of PROMOTIONAL) {
    const m = copy.match(re);
    if (m) found.push(m[0].trim());
  }
  return [...new Set(found.map((f) => f.toLowerCase()))].slice(0, 6);
}

/**
 * The copy sells off a source that cannot be sold off.
 *
 * Returns nothing when the source is clear: on ordinary material this check
 * must stay completely out of the way.
 */
export function toneMismatch(
  safety: SourceSafety,
  copy: string,
): { mismatch: boolean; phrases: string[] } {
  if (safety.posture === 'clear') return { mismatch: false, phrases: [] };
  const phrases = promotionalPhrases(copy);
  return { mismatch: phrases.length > 0, phrases };
}

/**
 * Formats whose whole purpose is to sell. There is no respectful way to write
 * a promotion off a fatality, so these are refused rather than warned about.
 */
export const PROMOTIONAL_FORMATS = ['PROMO', 'AD', 'CAMPAIGN_COPY'] as const;

export function isPromotionalFormat(type: string): boolean {
  return (PROMOTIONAL_FORMATS as readonly string[]).includes(type);
}

/**
 * Whether this source may be used for this format at all.
 *
 * The one hard stop in the module: a grave source plus a format that exists to
 * sell. Everything else is handled by instructing the writer and checking what
 * comes back, because a person may legitimately want to write respectfully
 * about a hard subject.
 */
export function refusalFor(
  safety: SourceSafety,
  type: string,
): string | null {
  if (safety.posture !== 'unsuitable') return null;
  if (!isPromotionalFormat(type)) return null;
  return (
    `${safety.reason} Aura will not write promotional copy from it. ` +
    'Pick another source, or write a post that speaks to it directly instead of a promotion.'
  );
}

/**
 * What the writer is told when the source is not clear.
 *
 * Phrased as the rule it is, not as advice. The earlier failure happened with
 * a model that was being helpful — "be careful" is not an instruction it can
 * act on, "do not mention the product" is.
 */
export function safetyInstructions(safety: SourceSafety): string {
  if (safety.posture === 'clear') return '';
  const topics = list([...new Set(safety.hits.map((h) => TOPIC_LABEL[h.topic]))]);

  const common = [
    `This source material concerns ${topics}. Real people were affected.`,
    '',
    'ABSOLUTE RULES FOR THIS PIECE:',
    '- Do not use it as a reason, hook or occasion to promote anything.',
    '- No celebratory, festive or sales language whatsoever: nothing about celebrating, toasting, raising a glass, treating yourself, unwinding, enjoying, good times, deals, offers or urgency.',
    '- No celebratory emoji.',
    '- Do not claim the product or brand helps, heals, comforts or brings people together in connection with these events.',
    '- Do not speculate about causes, blame anyone, or describe harm in detail.',
    '- Name what the source is actually about. Do not write around it with a vague "recent events" and then pivot to the brand.',
  ];

  if (safety.posture === 'unsuitable') {
    return [
      'SOURCE SAFETY — THIS SOURCE IS NOT MARKETING MATERIAL',
      ...common,
      '- Mention the business only if it has a genuine, concrete role (it is directly involved, affected, or materially helping). Otherwise do not mention it at all.',
      '- No call to action that asks for business. If a next step belongs here at all, it points to something useful to the reader, not to a purchase.',
      '',
      'If the only honest post from this source would be promotional, the right answer is a short, plain, respectful piece that sells nothing.',
    ].join('\n');
  }

  return [
    'SOURCE SAFETY — HANDLE THIS SOURCE CAREFULLY',
    ...common,
    '- The business may appear, but as useful context or genuine help — never as the upside of what happened.',
    '- Keep the tone measured and factual. Inform; do not sell.',
  ].join('\n');
}

/**
 * What the trend digest is told when it writes a suggested angle.
 *
 * The angle is where this went wrong first — a promotional hook written into
 * the digest becomes the brief the writer is held to, so the guard has to be
 * here as well as at generation.
 */
export function anglePolicyFor(safety: SourceSafety): string {
  if (safety.posture === 'clear') return '';
  if (safety.posture === 'unsuitable') {
    return (
      'This item concerns death, violence, conflict or someone in crisis. ' +
      'Do NOT suggest a marketing angle for it. Set `suitableForPromotion` to false and ' +
      'write, in `suggestedAngle`, one plain sentence on why it is not something to post ' +
      'commercially — no hook, no product tie-in, no "opportunity".'
    );
  }
  return (
    'This item involves real hardship. Any angle must be informative and respectful: ' +
    'no celebration, no offer, no urgency, and no suggestion that the brand benefits. ' +
    'If there is no respectful angle, set `suitableForPromotion` to false.'
  );
}

/**
 * The verdict stored on a draft when it was written, or null for a draft
 * written before this existed.
 *
 * Read defensively rather than cast: it comes back out of a JSON column, and
 * an older draft simply has no verdict — which must mean "no extra rules",
 * not a crash and not an invented posture. A stored 'clear' also returns
 * null, so callers have one thing to check instead of two.
 *
 * Lives here rather than beside the generator so the reviewer can read it
 * without importing the writer (the writer already imports the reviewer).
 */
export function storedSourceSafety(
  meta: Record<string, unknown>,
): SourceSafety | null {
  const s = meta.sourceSafety;
  if (!s || typeof s !== 'object') return null;
  const posture = (s as { posture?: unknown }).posture;
  if (posture !== 'caution' && posture !== 'unsuitable') return null;
  const hits = (s as { hits?: unknown }).hits;
  return {
    posture,
    hits: Array.isArray(hits)
      ? (hits.filter(
          (h): h is SafetyHit =>
            !!h &&
            typeof h === 'object' &&
            SENSITIVE_TOPICS.includes((h as SafetyHit).topic),
        ) as SafetyHit[])
      : [],
    reason:
      typeof (s as { reason?: unknown }).reason === 'string'
        ? (s as { reason: string }).reason
        : null,
  };
}

/** "a", "a and b", "a, b and c" */
function list(items: string[]): string {
  const xs = items.filter(Boolean);
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/**
 * The safety of a stored signal: the verdict recorded when it was collected,
 * or — for news and trend signals stored before verdicts were kept — worked
 * out from its title and summary. The business's own signals (its results,
 * profile, documents) are not news and are always clear.
 */
export function signalPosture(signal: {
  source: string;
  title: string;
  summary: string;
  metadata: unknown;
}): SafetyPosture {
  const meta = signal.metadata && typeof signal.metadata === 'object' ? (signal.metadata as Record<string, unknown>) : {};
  const stored = (meta.safety as { posture?: unknown } | undefined)?.posture;
  if (stored === 'clear' || stored === 'caution' || stored === 'unsuitable') return stored;
  if (signal.source !== 'TRENDS' && signal.source !== 'EXTERNAL') return 'clear';
  return classifySource(`${signal.title}\n${signal.summary}`).posture;
}
