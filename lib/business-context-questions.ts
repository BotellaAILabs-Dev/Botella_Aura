import { z } from 'zod';

import {
  contextField,
  type BusinessContext,
  type ContextFieldPath,
} from '@/lib/business-context';
import { EDITABLE_FIELDS, MARKET_MODE_LABEL } from '@/lib/business-context-ui';
import { CONTENT_CHANNELS } from '@/lib/validations/planner';

/**
 * Asking instead of assuming.
 *
 * When Aura is missing something it needs, or holds a value it cannot vouch
 * for, it should ask — "I don't have enough information about your primary
 * audience yet. Who are you mainly trying to reach?" — rather than write as if
 * it knew. This module turns gaps in the Business Context into questions a
 * person can answer in one step, and answers into context updates.
 *
 * Pure and client-safe: the service decides which questions to show (and
 * remembers what happened to them); the page renders them; both share this.
 */

// ---------------------------------------------------------------------------
// Detection rules
// ---------------------------------------------------------------------------

/**
 * missing    — no value at all.
 * stale      — a value past its freshness rule; "is this still right?"
 * unverified — an AI suggestion nobody has confirmed.
 * conflict   — two sources disagree; "which is right?"
 */
export const GAP_KINDS = [
  'missing',
  'stale',
  'unverified',
  'conflict',
] as const;
export type GapKind = (typeof GAP_KINDS)[number];

/**
 * critical  — Aura cannot do specific work without it; asked first, and can
 *             only be put off ("not now"), never dismissed.
 * important — noticeably better output with it.
 * optional  — asked only when a workflow that uses it is about to run.
 */
export type QuestionPriority = 'critical' | 'important' | 'optional';

export interface Gap {
  /** `<kind>:<field>` — stable across requests, so its history can be tracked. */
  key: string;
  kind: GapKind;
  field: ContextFieldPath;
  priority: QuestionPriority;
}

/** Fields Aura can actually ask about and store an answer for. */
const ASKABLE: Partial<Record<ContextFieldPath, string>> = {
  'identity.description': 'identity.description',
  'identity.offerings': 'identity.offerings',
  'identity.industry': 'identity.industry',
  'identity.website': 'identity.website',
  'audience.marketMode': 'audience.marketMode',
  'audience.stated': 'audience.stated',
  'objectives.goals': 'objectives.goals',
  'channels.preferred': 'channels.preferred',
  // The resolved voice is answered by the business's own notes.
  'voice.summary': 'voice.notes',
};

/**
 * Fields answered on the page that owns them, not in a text box: Aura asks,
 * then points there. The question closes by itself once the gap is filled.
 */
const LINKED: Partial<Record<ContextFieldPath, { href: string; cta: string }>> =
  {
    'knowledge.coverage': {
      href: '/dashboard/settings/knowledge-base',
      cta: 'Add materials',
    },
    'market.competitors': {
      href: '/dashboard/competitors',
      cta: 'Add competitors',
    },
    'identity.visual': {
      href: '/dashboard/settings/brand',
      cta: 'Add logo and colours',
    },
  };

/**
 * Optional fields worth asking about when missing — the registry marks them
 * optional, so they are only asked when a workflow is about to use them.
 */
const OPTIONAL_ASKABLE: ContextFieldPath[] = [
  'market.competitors',
  'identity.visual',
];

/** Fields whose section holds them, so "missing" is not "not loaded". */
const SECTION_OF: Partial<Record<ContextFieldPath, string>> = {
  'market.competitors': 'market',
  'knowledge.coverage': 'knowledge',
};

const priorityOf = (field: ContextFieldPath): QuestionPriority => {
  const req = contextField(field).requirement;
  return req === 'required'
    ? 'critical'
    : req === 'recommended'
      ? 'important'
      : 'optional';
};

/**
 * Every gap in a context, by the rules above. Only fields a person can answer
 * here are turned into gaps; module-owned data (competitors, connections,
 * materials) is pointed to by the About page's attention list instead.
 */
export function detectGaps(ctx: BusinessContext): Gap[] {
  const gaps: Gap[] = [];
  const add = (
    kind: GapKind,
    field: ContextFieldPath,
    priority = priorityOf(field),
  ) => {
    if (!ASKABLE[field] && !LINKED[field]) return;
    const section = SECTION_OF[field];
    if (section && !ctx.meta.sections.includes(section)) return;
    const key = `${kind}:${field}`;
    if (gaps.some((g) => g.key === key)) return;
    gaps.push({ key, kind, field, priority });
  };

  // Missing: required and recommended from completeness; selected optional
  // fields when the section that holds them was loaded.
  for (const f of ctx.meta.completeness.missingRequired)
    add('missing', f as ContextFieldPath);
  for (const f of ctx.meta.completeness.missingRecommended)
    add('missing', f as ContextFieldPath);
  for (const f of OPTIONAL_ASKABLE) if (!ctx.meta.facts[f]) add('missing', f);

  for (const issue of ctx.meta.issues) {
    const field = issue.field as ContextFieldPath;
    const fact = ctx.meta.facts[field];
    if (issue.kind === 'value_conflict') add('conflict', field);
    if (issue.kind === 'stale' && fact) add('stale', field);
    // Only AI guesses are "unverified" questions; a fallback value is asked
    // for as missing (its home field is empty) by the completeness rules.
    if (issue.kind === 'unverified' && fact?.sourceType === 'ai_derived') {
      add('unverified', field);
    }
  }

  // A value borrowed from a fallback (last month's plan) stands in for an empty
  // field — ask for the real one rather than keep using a guess.
  for (const [field, fact] of Object.entries(ctx.meta.facts)) {
    if (fact.inferred) add('missing', field as ContextFieldPath);
  }

  const rank = { critical: 0, important: 1, optional: 2 } as const;
  const kindRank = {
    missing: 0,
    conflict: 1,
    stale: 2,
    unverified: 3,
  } as const;
  return gaps.sort(
    (a, b) =>
      rank[a.priority] - rank[b.priority] ||
      kindRank[a.kind] - kindRank[b.kind],
  );
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** `link`: answered on another page (`href`), which closes the question. */
export type AnswerType = 'text' | 'textarea' | 'choice' | 'multi' | 'link';

export interface Question extends Gap {
  /** What Aura asks, in its own voice. */
  text: string;
  /** Why it matters, in one line. */
  why: string;
  answer: {
    type: AnswerType;
    choices?: { value: string; label: string }[];
    max?: number;
    placeholder?: string;
    /** Pre-filled value (the current one, for "is this still right?"). */
    current?: string | string[] | null;
    /**
     * Offer "Yes, that's right" alongside the input — for a value that exists
     * but is out of date or was guessed by AI.
     */
    confirmable?: boolean;
    /** For `link` answers: where the question is answered, and the button. */
    href?: string;
    cta?: string;
  };
}

/** How Aura asks about fields answered on their own page. */
const LINKED_PHRASING: Record<
  string,
  { missing: string; unverified?: string; why: string }
> = {
  'knowledge.coverage': {
    missing:
      "I haven't seen any of your own material yet — a pitch deck, a one-pager or your website. Can you add one?",
    why: 'So Aura can quote what you actually offer instead of describing it in general terms.',
  },
  'market.competitors': {
    missing: 'Who are your main competitors? I won’t guess them.',
    unverified:
      'I guessed some competitors when your trend tracking was set up. Can you check them?',
    why: 'So recommendations position you against the businesses you actually compete with.',
  },
  'identity.visual': {
    missing:
      'Do you have a logo and brand colours Aura should use in graphics?',
    why: 'So images look like they came from you.',
  },
};

type Phrasing = { missing: string; why: string };

/** How Aura asks for each field when it has nothing. */
const MISSING: Record<string, Phrasing> = {
  'identity.description': {
    missing:
      "I don't know what your business does yet. In a sentence or two, what do you do?",
    why: 'Everything Aura writes starts from this. Without it, it would have to guess.',
  },
  'identity.offerings': {
    missing:
      'What do you actually sell? Products, services or plans — whatever a customer buys.',
    why: 'So posts and recommendations name your real offer instead of a generic one.',
  },
  'identity.industry': {
    missing: 'Which industry are you in?',
    why: 'Helps Aura follow the right trends and speak your market’s language.',
  },
  'identity.website': {
    missing: "What's your website address?",
    why: 'Aura can read it to learn how you describe yourself.',
  },
  'audience.marketMode': {
    missing: 'Do you mainly sell to businesses or to consumers?',
    why: 'The single biggest difference in how Aura writes for you.',
  },
  'audience.stated': {
    missing:
      "I don't have enough information about your primary audience yet. Who are you mainly trying to reach?",
    why: 'Aura writes to this person. Without it, it would be writing to nobody in particular.',
  },
  'objectives.goals': {
    missing:
      'What are you working towards right now? For example, “20 demos this quarter” or “500 newsletter sign-ups”.',
    why: 'So Aura suggests work that moves that number, not just more posts.',
  },
  'channels.preferred': {
    missing: 'Where do you publish your marketing?',
    why: 'So plans and recommendations use the channels you actually use.',
  },
  'voice.summary': {
    missing:
      'How would you describe the way your brand talks? A few words is fine — “warm, plain-spoken, never salesy”.',
    why: 'So drafts sound like you rather than like a template.',
  },
};

const quote = (v: string | null | undefined, max = 140) =>
  !v ? '' : v.length > max ? `“${v.slice(0, max - 1).trimEnd()}…”` : `“${v}”`;

/** Turn a gap into the question Aura asks. */
export function questionFor(gap: Gap, ctx: BusinessContext): Question {
  const label = contextField(gap.field).label;

  const linked = LINKED[gap.field];
  if (linked) {
    const p = LINKED_PHRASING[gap.field]!;
    return {
      ...gap,
      text:
        gap.kind === 'unverified' && p.unverified ? p.unverified : p.missing,
      why: p.why,
      answer: { type: 'link', href: linked.href, cta: linked.cta },
    };
  }

  const key = ASKABLE[gap.field]!;
  const editable = EDITABLE_FIELDS[key];
  const current = editable?.read(ctx) ?? null;
  const fact = ctx.meta.facts[gap.field];
  const phrasing = MISSING[gap.field] ?? {
    missing: `What should Aura know about your ${label.toLowerCase()}?`,
    why: 'Aura will use it wherever it is relevant.',
  };

  const freeAnswer = (): Question['answer'] => {
    if (gap.field === 'audience.marketMode') {
      return {
        type: 'choice',
        choices: (['B2B', 'B2C'] as const).map((v) => ({
          value: v,
          label: MARKET_MODE_LABEL[v],
        })),
      };
    }
    if (gap.field === 'channels.preferred') {
      return {
        type: 'multi',
        choices: CONTENT_CHANNELS.map((c) => ({ value: c, label: c })),
      };
    }
    return {
      type: editable?.kind === 'text' ? 'text' : 'textarea',
      max: editable?.max,
      placeholder: editable?.placeholder,
    };
  };

  switch (gap.kind) {
    case 'missing':
      return {
        ...gap,
        text: fact?.inferred
          ? `${phrasing.missing} (Right now Aura is borrowing ${quote(Array.isArray(current) ? current.join(', ') : current)} from ${fact.note?.includes('plan') ? 'your marketing plan' : 'another source'}.)`
          : phrasing.missing,
        why: phrasing.why,
        answer: { ...freeAnswer(), current: fact?.inferred ? current : null },
      };

    case 'stale': {
      const shown = Array.isArray(current) ? current.join(', ') : current;
      const age =
        fact?.ageDays != null
          ? ` It was last updated ${fact.ageDays} days ago.`
          : '';
      return {
        ...gap,
        text: `Is this still right? Your ${label.toLowerCase()}: ${quote(shown)}.${age}`,
        why: 'Aura keeps using it either way — confirming or updating it keeps the work current.',
        answer: { ...freeAnswer(), current, confirmable: true },
      };
    }

    case 'unverified': {
      if (gap.field === 'voice.summary') {
        return {
          ...gap,
          text: `I drafted your brand voice as ${quote(ctx.voice.summary)}. Does that sound like you?`,
          why: 'Until you confirm it, Aura treats it as a guess and leans on your own words.',
          answer: {
            ...freeAnswer(),
            current: ctx.voice.notes,
            confirmable: true,
          },
        };
      }
      return {
        ...gap,
        text: `I guessed your ${label.toLowerCase()}. Is ${quote(Array.isArray(current) ? current.join(', ') : current)} right?`,
        why: 'Until you confirm it, Aura treats it as an assumption.',
        answer: { ...freeAnswer(), current, confirmable: true },
      };
    }

    case 'conflict': {
      const issue = ctx.meta.issues.find(
        (i) => i.field === gap.field && i.kind === 'value_conflict',
      );
      const options = [issue?.chosen, ...(issue?.overridden ?? [])]
        .filter((o): o is NonNullable<typeof o> => Boolean(o))
        .map((o) =>
          String(Array.isArray(o.value) ? o.value.join(', ') : o.value),
        );
      return {
        ...gap,
        text: `I have two different answers for your ${label.toLowerCase()}. Which is right?`,
        why: 'Aura uses one everywhere; the other is only in one place and may be out of date.',
        answer: {
          type: 'choice',
          choices: [...new Set(options)].map((v) => ({ value: v, label: v })),
          current,
        },
      };
    }
  }
}

/** Questions for a list of gaps, most important first. */
export function questionsFor(gaps: Gap[], ctx: BusinessContext): Question[] {
  return gaps.map((g) => questionFor(g, ctx));
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/**
 * What the user sent back.
 *
 * `confirm: true` — "yes, that's still right" (stale and unverified questions).
 * `value`         — a new answer: text, a choice, or a list of channels.
 */
export const questionAnswerSchema = z
  .object({
    confirm: z.literal(true).optional(),
    value: z
      .union([z.string().max(2000), z.array(z.string().max(80)).max(20)])
      .optional(),
  })
  .refine((a) => a.confirm === true || a.value !== undefined, {
    message: 'Answer the question, or confirm the current value.',
  });

export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

/**
 * The Business Context update an answer makes: a patch, a confirmation, or
 * both. Validation of the value itself is the write service's job — it holds
 * the same rules as every other edit.
 */
/** True for questions answered on another page rather than here. */
export function isLinkedQuestion(field: ContextFieldPath): boolean {
  return Boolean(LINKED[field]);
}

export function answerToUpdate(
  question: Pick<Gap, 'field' | 'kind'>,
  answer: QuestionAnswer,
  ctx: BusinessContext,
): { patch: Record<string, unknown>; confirm: string[] } {
  const key = ASKABLE[question.field]!;
  const editable = EDITABLE_FIELDS[key]!;

  if (answer.confirm) {
    // Confirming the AI-drafted voice vouches for the profile itself.
    const fact = ctx.meta.facts[question.field];
    const confirmPath =
      question.field === 'voice.summary'
        ? fact?.source === 'brand_voice_profile'
          ? 'voice.profile'
          : 'voice.notes'
        : key;
    return { patch: {}, confirm: [confirmPath] };
  }
  // A conflict over channels offers each side as text ("LinkedIn, X"); the
  // field itself is a list.
  const value =
    editable.kind === 'channels' && typeof answer.value === 'string'
      ? answer.value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      : answer.value!;
  return { patch: editable.toPatch(value), confirm: [] };
}
