import type { BusinessContextSnapshot } from '@/lib/business-context-snapshot';
import type { ContentBrief } from '@/lib/content-brief';
import {
  relevantMemory,
  type HandoffInput,
} from '@/lib/recommendation-context-handoff';

/**
 * GENERATION CONTEXT — the package the generation model receives.
 *
 * Aura writes from what is true about THIS business, for THIS piece — not
 * from a generic prompt, and not from everything Aura happens to know. The
 * package is assembled per draft from:
 *
 *   business context    the current Business Context Snapshot (content view:
 *                       trusted, current facts; assumptions kept apart)
 *   recommendation      the Content Brief (lib/content-brief.ts) when the piece
 *                       is written for one: key message, reason, evidence,
 *                       outcome, CTA — and the opportunity behind it
 *   goal · audience     the brief's, else the snapshot's
 *   brand voice         the snapshot's
 *   channel             the format's and network's playbook
 *   memory              learned patterns that bear on this piece only
 *   knowledge           the business's own material that matches the topic
 *   reference           a page the person linked in the brief
 *   previous content    earlier posts on the same topic, so it neither
 *                       repeats nor contradicts them — only when related
 *
 * and then:
 *
 *   RELEVANT     irrelevant parts are removed, and say why: knowledge with
 *                no match, memory about other topics, campaigns this piece is
 *                not for, competitor and performance data, unrelated posts
 *   SAFE         personal and secret data is redacted before the model sees
 *                it — email addresses and phone numbers in documents and
 *                pages, keys and tokens, passwords, card numbers, internal ids
 *   BOUNDED      every section has a cap, and the package a token budget:
 *                required sections are trimmed, optional ones dropped in
 *                priority order, and what was dropped is recorded
 *   TRACEABLE    the package records the recommendation, opportunity, brief
 *                version, snapshot fingerprint and revision, and the ids of
 *                every knowledge passage and previous post it used
 *
 * Pure and client-safe; assembled on the server by
 * server/content/generation-context.service.ts.
 */

export const GENERATION_CONTEXT_VERSION = 1 as const;

/** The package's share of the prompt, in tokens (task wording and output shape are extra). */
export const CONTEXT_TOKEN_BUDGET = 3200;

/** A rough token count: ~4 characters per token for English prose. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const CONTEXT_SECTIONS = [
  'brief',
  'business',
  'channel',
  'recommendation',
  'opportunity',
  'goal',
  'audience',
  'voice',
  'memory',
  'reference',
  'knowledge',
  'previousContent',
  'recentTopics',
  'assumptions',
] as const;
export type ContextSectionKey = (typeof CONTEXT_SECTIONS)[number];

/**
 * Order of importance (lower first), whether a section is required, and its
 * cap. Required sections are never dropped — only trimmed to their cap.
 */
export const SECTION_SPECS: Record<
  ContextSectionKey,
  { title: string; priority: number; required: boolean; maxTokens: number }
> = {
  brief: {
    title: 'WHAT TO WRITE (the person’s brief)',
    priority: 0,
    required: true,
    maxTokens: 600,
  },
  business: {
    title: 'THE BUSINESS',
    priority: 1,
    required: true,
    maxTokens: 450,
  },
  channel: {
    title: 'HOW THIS FORMAT WORKS',
    priority: 2,
    required: true,
    maxTokens: 400,
  },
  recommendation: {
    title: 'WRITTEN FOR AURA’S RECOMMENDATION',
    priority: 3,
    required: false,
    maxTokens: 450,
  },
  opportunity: {
    title: 'THE OPPORTUNITY BEHIND IT',
    priority: 4,
    required: false,
    maxTokens: 150,
  },
  goal: {
    title: 'MARKETING GOAL',
    priority: 5,
    required: false,
    maxTokens: 150,
  },
  audience: { title: 'AUDIENCE', priority: 6, required: false, maxTokens: 150 },
  voice: { title: 'BRAND VOICE', priority: 7, required: false, maxTokens: 250 },
  memory: {
    title: 'WHAT HAS WORKED FOR THIS BUSINESS',
    priority: 8,
    required: false,
    maxTokens: 150,
  },
  reference: {
    title: 'REFERENCE PAGE (linked in the brief)',
    priority: 9,
    required: false,
    maxTokens: 700,
  },
  knowledge: {
    title: 'THE BUSINESS’S OWN MATERIAL (matching this topic)',
    priority: 10,
    required: false,
    maxTokens: 900,
  },
  previousContent: {
    title: 'EARLIER POSTS ON THIS TOPIC (do not repeat; stay consistent)',
    priority: 11,
    required: false,
    maxTokens: 250,
  },
  recentTopics: {
    title: 'RECENTLY PUBLISHED TOPICS (do not repeat)',
    priority: 12,
    required: false,
    maxTokens: 100,
  },
  assumptions: {
    title: 'NOT CONFIRMED — use only as background, never state as fact',
    priority: 13,
    required: false,
    maxTokens: 120,
  },
};

// ---------------------------------------------------------------------------
// Sensitive data
// ---------------------------------------------------------------------------

export type RedactionKind = 'email' | 'phone' | 'secret' | 'card' | 'id';

const SECRET_PATTERNS: RegExp[] = [
  // `name = value` first, so a key inside it is removed once, as a whole.
  /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["']?(?!\[)[^\s"',;]*[^\s"',;.]/gi,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];
const URL_SECRET =
  /([?&](?:token|key|sig|signature|access_token|apikey|api_key|password|auth)=)[^&\s#]+/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const PHONE = /(?<![\w/])\+?\d[\d ().-]{7,}\d(?![\w/])/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const INTERNAL_ID = /\bc[a-z0-9]{24}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Remove what the model must not see.
 *
 *   `personal: true`  (documents, fetched pages, earlier posts) also redacts
 *                     email addresses not on the business's own domain, and
 *                     phone numbers — personal data the business uploaded
 *                     for other reasons is not material for a public post.
 *   always            keys, tokens, passwords, connection strings, card
 *                     numbers and internal record ids — even in the
 *                     person's own brief.
 */
export function redactSensitive(
  text: string,
  options: { personal: boolean; allowedDomains?: string[] },
): { text: string; found: Partial<Record<RedactionKind, number>> } {
  const found: Partial<Record<RedactionKind, number>> = {};
  const count = (k: RedactionKind) => {
    found[k] = (found[k] ?? 0) + 1;
  };
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      count('secret');
      return '[secret removed]';
    });
  }
  out = out.replace(URL_SECRET, (_m, key: string) => {
    count('secret');
    return `${key}[removed]`;
  });
  out = out.replace(CARD, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || !luhn(digits)) return m;
    count('card');
    return '[card number removed]';
  });
  out = out.replace(INTERNAL_ID, () => {
    count('id');
    return '[id]';
  });
  if (options.personal) {
    const allowed = (options.allowedDomains ?? []).map((d) => d.toLowerCase());
    out = out.replace(EMAIL, (m, domain: string) => {
      const d = domain.toLowerCase();
      if (allowed.some((a) => d === a || d.endsWith(`.${a}`))) return m;
      count('email');
      return '[email removed]';
    });
    out = out.replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, '');
      // Years, prices, ranges and dates are not phone numbers.
      if (digits.length < 9 || digits.length > 15) return m;
      if (/^\d{4}[-–]\d{4}$/.test(m.trim())) return m;
      count('phone');
      return '[phone removed]';
    });
  }
  return { text: out, found };
}

/** The domain of a website, for the email allow-list ("https://www.x.com" → "x.com"). */
export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(
      url.startsWith('http') ? url : `https://${url}`,
    ).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Relevance
// ---------------------------------------------------------------------------

const STOP = new Set(
  // Filler, and words every brief uses ("publish a post on LinkedIn") —
  // they say nothing about what the piece is about.
  'a an and are as at be but by can do for from get give giving has have how in into is it its not no of on or our out own so that the their them then there this to up use was we what when where which who why will with you your about post posts content write piece one new more most just make publish share view say tell show linkedin instagram facebook twitter thread carousel blog email'.split(
    ' ',
  ),
);

/** The meaningful words of a text, lower-cased. */
export function topicWords(text: string): Set<string> {
  return new Set(
    (
      text
        .toLowerCase()
        .replace(/[’']/g, "'")
        .match(/[a-z][a-z'-]{2,}/g) ?? []
    )
      .map((w) => singular(w.replace(/'s$/, '')))
      .filter((w) => !STOP.has(w)),
  );
}

/** "prices" → "price", "harvests" → "harvest": whole words, plurals alike. */
function singular(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('es') && /(?:ch|sh|x|ss)es$/.test(w))
    return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss'))
    return w.slice(0, -1);
  return w;
}

/** How many meaningful words two texts share. */
export function overlap(a: Set<string>, text: string): number {
  let n = 0;
  for (const w of topicWords(text)) if (a.has(w)) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Assembling
// ---------------------------------------------------------------------------

export interface KnowledgePassage {
  id: string;
  title: string | null;
  content: string;
  /** Retrieval score; 0 means it did not match the topic at all. */
  score: number;
}

export interface PreviousPiece {
  id: string;
  title: string | null;
  /** A short excerpt of what it said. */
  excerpt: string;
  /** Where it ran or will run. */
  channel: string | null;
  at: string;
}

export interface AssembleInput {
  /** The person's brief (editable in Content Studio). */
  brief: string;
  /** The Content Brief, when written for a recommendation. */
  contentBrief: ContentBrief | null;
  snapshot: BusinessContextSnapshot;
  /** Whether the snapshot was current or rebuilt on this read. */
  snapshotStatus: 'current' | 'rebuilt';
  /** The format's and network's playbook. */
  playbook: { label: string; rules: string[] };
  format: { type: string; channel: string | null };
  /** The campaign this piece is for, if any — always included. */
  campaign: {
    id: string;
    name: string;
    goal: string | null;
    audience: string | null;
    themes: string[];
  } | null;
  knowledge: KnowledgePassage[];
  /** Text of a page the person linked, already fetched. */
  reference: { url: string; text: string }[];
  previous: PreviousPiece[];
  /**
   * The brand voice profile Aura applies to every draft, when there is one
   * (it may be Aura-built, which the snapshot does not count as a fact).
   */
  brandVoice?: {
    summary: string | null;
    tone: string[];
    avoid: string[];
    vocabulary: string[];
    phrases: string[];
    formatting: string | null;
  } | null;
  budgetTokens?: number;
  now?: Date;
}

export interface ContextSection {
  key: ContextSectionKey;
  title: string;
  text: string;
  tokens: number;
  /** Where it came from. */
  from: string;
  /** Trimmed to fit its cap or the budget. */
  trimmed: boolean;
}

export interface GenerationContext {
  version: typeof GENERATION_CONTEXT_VERSION;
  assembledAt: string;
  sections: ContextSection[];
  /** Left out, and why. */
  dropped: { key: ContextSectionKey | string; reason: string }[];
  /** What was redacted, per kind. */
  redactions: Partial<Record<RedactionKind, number>>;
  budget: { maxTokens: number; usedTokens: number };
  /** Everything needed to trace the package back. */
  trace: {
    recommendationId: string | null;
    opportunityId: string | null;
    contentBriefVersion: number | null;
    snapshot: {
      fingerprint: string;
      revision: string | null;
      generatedAt: string;
      status: 'current' | 'rebuilt';
    };
    campaignId: string | null;
    knowledgeChunkIds: string[];
    previousContentIds: string[];
    referenceUrls: string[];
  };
}

/** Cut to about `tokens`, at a line or sentence boundary when there is one. */
export function trimToTokens(text: string, tokens: number): string {
  const max = tokens * 4;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return `${(at > max * 0.6 ? cut.slice(0, at + 1) : cut).trimEnd()} …`;
}

const lines = (...xs: (string | false | null | undefined)[]) =>
  xs.filter((x): x is string => Boolean(x && x.trim())).join('\n');

export function assembleGenerationContext(
  input: AssembleInput,
): GenerationContext {
  const now = input.now ?? new Date();
  const budget = input.budgetTokens ?? CONTEXT_TOKEN_BUDGET;
  const s = input.snapshot;
  const cb = input.contentBrief;
  const allowedDomains = [domainOf(s.business?.website)].filter(
    (d): d is string => Boolean(d),
  );
  const redactions: Partial<Record<RedactionKind, number>> = {};
  const dropped: GenerationContext['dropped'] = [];
  const clean = (text: string, personal: boolean) => {
    const r = redactSensitive(text, { personal, allowedDomains });
    for (const [k, n] of Object.entries(r.found)) {
      redactions[k as RedactionKind] =
        (redactions[k as RedactionKind] ?? 0) + (n ?? 0);
    }
    return r.text;
  };

  // What the piece is about — for every relevance decision below.
  const about = topicWords(
    [
      input.brief,
      cb?.keyMessage?.value,
      cb?.recommendation.title,
      cb?.opportunity?.title,
    ]
      .filter(Boolean)
      .join(' '),
  );

  const raw: { key: ContextSectionKey; text: string; from: string }[] = [];
  const add = (key: ContextSectionKey, text: string, from: string) => {
    if (text.trim()) raw.push({ key, text, from });
  };

  // --- Brief (the person's, editable) — secrets out, their own words kept.
  add('brief', clean(input.brief, false), 'person');

  // --- Business: the snapshot's trusted, current facts.
  add(
    'business',
    lines(
      s.business &&
        `${s.business.name}${s.business.industry ? ` (${s.business.industry})` : ''}`,
      s.business?.description && `What it does: ${s.business.description}`,
      s.products?.offerings && `What it sells: ${s.products.offerings}`,
      ...(s.products?.highlights ?? [])
        .filter((h) => overlap(about, `${h.title ?? ''} ${h.excerpt}`) > 0)
        .slice(0, 2)
        .map(
          (h) => `- ${h.title ? `${h.title}: ` : ''}${clean(h.excerpt, true)}`,
        ),
      s.business?.website && `Website: ${s.business.website}`,
    ),
    'business_snapshot',
  );

  // --- Channel: the format's and network's playbook.
  add(
    'channel',
    lines(
      `${input.playbook.label}${input.format.channel ? ` on ${input.format.channel}` : ''}.`,
      ...input.playbook.rules.map((r) => `- ${r}`),
    ),
    'content_playbook',
  );

  // --- Recommendation and opportunity, from the Content Brief.
  if (cb) {
    const gaps = cb.missing
      .filter((m) =>
        [
          'marketingGoal',
          'targetAudience',
          'evidence',
          'relevantMemory',
        ].includes(m.field),
      )
      .map((m) => m.field);
    add(
      'recommendation',
      lines(
        `“${cb.recommendation.title}”`,
        cb.keyMessage && `Key message: ${cb.keyMessage.value}`,
        `Why now: ${cb.reason.why}`,
        `Expected outcome: ${cb.expectedOutcome.outcome}`,
        cb.evidence.length
          ? `Evidence (cite only this; invent nothing beyond it): ${cb.evidence.map((e) => e.label).join('; ')}`
          : 'Evidence: none recorded — make no claims about the market, competitors or results.',
        cb.cta.expected &&
          (cb.cta.destination
            ? `Call to action: send people to ${cb.cta.destination.value}.`
            : 'Call to action: name the next step, with no URL — none is known.'),
        cb.assetRequirements &&
          `Length: up to ${cb.assetRequirements.copy.idealMaxChars} characters (never over ${cb.assetRequirements.copy.maxChars}).`,
        gaps.length > 0 && `Not provided — do not invent: ${gaps.join(', ')}.`,
      ),
      'content_brief',
    );
    if (cb.opportunity) {
      add(
        'opportunity',
        lines(
          `${cb.opportunity.title} (${cb.opportunity.typeLabel}).`,
          cb.opportunity.summary && clean(cb.opportunity.summary, true),
        ),
        'opportunity',
      );
    }
  } else {
    dropped.push({
      key: 'recommendation',
      reason: 'Not written for a recommendation.',
    });
  }

  // --- Goal: the brief's, else the snapshot's — and only the campaign this
  // piece is for, or one whose themes match it.
  const own = input.campaign;
  const campaigns = [
    ...(own ? [own] : []),
    ...(s.goals?.campaigns ?? []).filter(
      (c) =>
        c.name !== own?.name && c.themes.some((t) => overlap(about, t) > 0),
    ),
  ];
  const otherCampaigns = (s.goals?.campaigns ?? []).filter(
    (c) => !campaigns.some((x) => x.name === c.name),
  ).length;
  if (otherCampaigns > 0) {
    dropped.push({
      key: 'goal',
      reason: `${otherCampaigns} running campaign${otherCampaigns === 1 ? '' : 's'} this piece is not for.`,
    });
  }
  add(
    'goal',
    lines(
      cb?.marketingGoal ? cb.marketingGoal.value : s.goals?.current,
      ...campaigns.map(
        (c) =>
          `${c === own ? 'This piece is for the campaign' : 'Related campaign'} “${c.name}”${c.goal ? ` — ${c.goal}` : ''}${c.audience ? ` (for ${c.audience})` : ''}${c.themes.length ? `; themes: ${c.themes.join(', ')}` : ''}`,
      ),
    ),
    cb?.marketingGoal
      ? `content_brief:${cb.marketingGoal.source}`
      : 'business_snapshot',
  );

  // --- Audience.
  const a = s.audience;
  add(
    'audience',
    cb?.targetAudience
      ? cb.targetAudience.value
      : lines(
          a?.marketMode === 'B2C'
            ? 'Sells to consumers.'
            : a?.marketMode === 'B2B'
              ? 'Sells to businesses.'
              : null,
          a?.description,
          a?.roles.length ? `Roles: ${a.roles.join(', ')}` : null,
          a?.industries.length
            ? `Industries: ${a.industries.join(', ')}`
            : null,
        ),
    cb?.targetAudience
      ? `content_brief:${cb.targetAudience.source}`
      : 'business_snapshot',
  );

  // --- Voice. The snapshot keeps an Aura-built voice profile out of its
  // trusted facts (it is inferred, not stated) — but the profile exists to be
  // applied to every draft, so it is used here, said for what it is. The
  // business's own words about its voice are always kept.
  const v = s.voice;
  const profile = input.brandVoice ?? null;
  const voiceFrom = v?.summary
    ? 'business_snapshot'
    : profile
      ? 'brand_voice_profile'
      : 'business_snapshot';
  const tone = v?.tone.length ? v.tone : (profile?.tone ?? []);
  const avoidList = v?.avoid.length ? v.avoid : (profile?.avoid ?? []);
  const vocabulary = v?.vocabulary.length
    ? v.vocabulary
    : (profile?.vocabulary ?? []);
  add(
    'voice',
    lines(
      v?.summary ??
        (profile?.summary
          ? `${profile.summary} (Aura’s profile of your voice, from your own content)`
          : null),
      tone.length ? `Tone: ${tone.join(', ')}` : null,
      avoidList.length ? `Never mention: ${avoidList.join(', ')}` : null,
      vocabulary.length ? `Their vocabulary: ${vocabulary.join(', ')}` : null,
      profile?.phrases.length
        ? `Phrases they use: ${profile.phrases.slice(0, 5).join('; ')}`
        : null,
      v?.emoji || v?.hashtags
        ? `Emoji: ${v.emoji ?? 'unspecified'}. Hashtags: ${v.hashtags ?? 'unspecified'}.`
        : profile?.formatting
          ? `Formatting: ${profile.formatting}`
          : null,
      v?.notes && `In their own words: ${clean(v.notes, false)}`,
    ),
    voiceFrom,
  );

  // --- Memory: only patterns that bear on this piece.
  const insights = s.learning?.insights ?? [];
  const memory = cb
    ? cb.relevantMemory.map((m) => `${m.insight} (${m.relevance})`)
    : relevantMemory(
        insights.map((i) => ({
          insight: i.insight,
          type: i.type,
          confidence: i.confidence,
          freshness: 'fresh' as const,
        })),
        // relevantMemory reads only these fields of a recommendation.
        {
          title: input.brief,
          action: '',
          channel: input.format.channel,
          contentType: input.format.type,
        } as unknown as HandoffInput['recommendation'],
      ).map((m) => `${m.insight} (${m.relevance})`);
  const unrelatedInsights = insights.length - memory.length;
  if (unrelatedInsights > 0) {
    dropped.push({
      key: 'memory',
      reason: `${unrelatedInsights} learned pattern${unrelatedInsights === 1 ? '' : 's'} about other topics or formats.`,
    });
  }
  add('memory', memory.map((m) => `- ${m}`).join('\n'), 'marketing_memory');

  // --- Reference page the person linked.
  add(
    'reference',
    input.reference
      .map((r) => `Source: ${r.url}\n${clean(r.text, true)}`)
      .join('\n\n'),
    'reference_page',
  );

  // --- Knowledge: only passages that match the topic.
  // Retrieval matches parts of words ("not" in "notes"), and one shared word
  // is often chance ("note" in a brief, "Office notes" in a file): a passage
  // must share at least two whole topic words with the piece.
  const matching = input.knowledge.filter(
    (k) => k.score > 0 && overlap(about, `${k.title ?? ''} ${k.content}`) >= 2,
  );
  if (matching.length < input.knowledge.length) {
    dropped.push({
      key: 'knowledge',
      reason: `${input.knowledge.length - matching.length} passage${input.knowledge.length - matching.length === 1 ? '' : 's'} that did not match this topic.`,
    });
  }
  add(
    'knowledge',
    matching
      .map(
        (k, i) =>
          `[${i + 1}] ${k.title ? `${k.title} — ` : ''}${clean(k.content.slice(0, 900), true)}`,
      )
      .join('\n\n'),
    'knowledge_base',
  );

  // --- Earlier posts on the same topic: only when genuinely related.
  const related = input.previous
    .map((p) => ({ p, n: overlap(about, `${p.title ?? ''} ${p.excerpt}`) }))
    .filter((x) => x.n >= 2)
    .sort((x, y) => y.n - x.n)
    .slice(0, 2)
    .map((x) => x.p);
  if (input.previous.length > related.length) {
    dropped.push({
      key: 'previousContent',
      reason: `${input.previous.length - related.length} earlier post${input.previous.length - related.length === 1 ? '' : 's'} on other topics.`,
    });
  }
  add(
    'previousContent',
    related
      .map(
        (p) =>
          `- ${p.at.slice(0, 10)}${p.channel ? ` · ${p.channel}` : ''}: ${p.title ? `${p.title} — ` : ''}${clean(p.excerpt, true)}`,
      )
      .join('\n'),
    'previous_content',
  );
  add(
    'recentTopics',
    (s.history?.recentTopics ?? [])
      .slice(0, 8)
      .map((t) => `- ${t}`)
      .join('\n'),
    'business_snapshot',
  );

  // --- Assumptions: present but unconfirmed — background only, and few.
  add(
    'assumptions',
    s.assumptions
      .slice(0, 4)
      .map((x) => `- ${x.label}: ${clean(x.value, true)} (${x.reason})`)
      .join('\n'),
    'business_snapshot',
  );

  // Never sent: competitors and performance numbers (the content view leaves
  // the market out; performance is not material for copy).
  if (s.history?.performance) {
    dropped.push({
      key: 'performance',
      reason: 'Performance numbers are not material for the copy.',
    });
  }

  // --- Fit the budget: required first (trimmed to cap), then by priority.
  const ordered = raw
    .map((r) => ({ ...r, spec: SECTION_SPECS[r.key] }))
    .sort((x, y) => x.spec.priority - y.spec.priority);
  const sections: ContextSection[] = [];
  let used = 0;
  for (const r of ordered.filter((x) => x.spec.required)) {
    const text = trimToTokens(r.text, r.spec.maxTokens);
    const tokens = estimateTokens(text);
    used += tokens;
    sections.push({
      key: r.key,
      title: r.spec.title,
      text,
      tokens,
      from: r.from,
      trimmed: text !== r.text,
    });
  }
  for (const r of ordered.filter((x) => !x.spec.required)) {
    const capped = trimToTokens(r.text, r.spec.maxTokens);
    const left = budget - used;
    if (left < 60) {
      dropped.push({ key: r.key, reason: 'Over the context budget.' });
      continue;
    }
    const text =
      estimateTokens(capped) > left ? trimToTokens(capped, left) : capped;
    const tokens = estimateTokens(text);
    used += tokens;
    sections.push({
      key: r.key,
      title: r.spec.title,
      text,
      tokens,
      from: r.from,
      trimmed: text !== r.text,
    });
  }
  sections.sort(
    (x, y) => SECTION_SPECS[x.key].priority - SECTION_SPECS[y.key].priority,
  );

  return {
    version: GENERATION_CONTEXT_VERSION,
    assembledAt: now.toISOString(),
    sections,
    dropped,
    redactions,
    budget: { maxTokens: budget, usedTokens: used },
    trace: {
      recommendationId: cb?.recommendation.id ?? null,
      opportunityId: cb?.opportunity?.id ?? null,
      contentBriefVersion: cb?.version ?? null,
      snapshot: {
        fingerprint: s.fingerprint,
        revision: s.revision,
        generatedAt: s.generatedAt,
        status: input.snapshotStatus,
      },
      campaignId: input.campaign?.id ?? null,
      knowledgeChunkIds: sections.some((x) => x.key === 'knowledge')
        ? matching.map((k) => k.id)
        : [],
      previousContentIds: sections.some((x) => x.key === 'previousContent')
        ? related.map((p) => p.id)
        : [],
      referenceUrls: sections.some((x) => x.key === 'reference')
        ? input.reference.map((r) => r.url)
        : [],
    },
  };
}

/** The package as the model reads it. */
export function generationContextToPrompt(c: GenerationContext): string {
  return [
    `CONTEXT FOR THIS PIECE (assembled ${c.assembledAt.slice(0, 10)} from the current business snapshot ${c.trace.snapshot.fingerprint.slice(0, 8)}). Everything here is confirmed and current unless a section says otherwise. Ground every fact in it; invent nothing.`,
    ...c.sections.map((s) => `\n## ${s.title}\n${s.text}`),
  ].join('\n');
}

/** What a draft keeps: the trace and the shape of the package — not its text. */
export function generationContextRecord(c: GenerationContext) {
  return {
    version: c.version,
    assembledAt: c.assembledAt,
    trace: c.trace,
    sections: c.sections.map((s) => ({
      key: s.key,
      from: s.from,
      tokens: s.tokens,
      trimmed: s.trimmed,
    })),
    dropped: c.dropped,
    redactions: c.redactions,
    budget: c.budget,
  };
}
