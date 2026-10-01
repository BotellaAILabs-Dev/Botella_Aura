import {
  contextField,
  type BusinessContext,
  type BusinessFact,
  type ContextFieldPath,
  type ContextIssue,
} from '@/lib/business-context';
import { CONTENT_CHANNELS } from '@/lib/validations/planner';
import {
  AUDIENCE_MAX,
  GOALS_MAX,
  MARKET_MODES,
} from '@/lib/validations/profile';

/**
 * How the About My Business page presents the Business Context.
 *
 * Pure and client-safe, so the page and its tests share one definition of
 * what each field looks like, how it is edited, what its badge says, and what
 * the user is told needs attention.
 */

// ---------------------------------------------------------------------------
// Editable fields
// ---------------------------------------------------------------------------

export type EditorKind = 'text' | 'textarea' | 'marketMode' | 'channels';

export interface EditableField {
  /** Stable key; also the confirm path the write service accepts. */
  key: string;
  /** The registry field whose fact (source, freshness) this shows. */
  factPath: ContextFieldPath;
  label: string;
  kind: EditorKind;
  max?: number;
  placeholder?: string;
  /** Why the field matters, in one line. */
  hint?: string;
  read(ctx: BusinessContext): string | string[] | null;
  /** The PATCH /api/business-context patch for a new value. */
  toPatch(value: string | string[]): Record<string, unknown>;
}

const text = (v: string | string[]) =>
  (Array.isArray(v) ? v.join(', ') : v).trim() || null;

export const EDITABLE_FIELDS: Record<string, EditableField> = {
  'identity.name': {
    key: 'identity.name',
    factPath: 'identity.name',
    label: 'Company name',
    kind: 'text',
    max: 80,
    read: (c) => c.identity.name,
    toPatch: (v) => ({ identity: { name: text(v) } }),
  },
  'identity.description': {
    key: 'identity.description',
    factPath: 'identity.description',
    label: 'What you do',
    kind: 'textarea',
    max: 600,
    placeholder:
      'We roast single-origin coffee in small batches and ship it within 48 hours.',
    hint: 'Everything Aura writes starts here. A sentence or two, in your own words.',
    read: (c) => c.identity.description,
    toPatch: (v) => ({ identity: { description: text(v) } }),
  },
  'identity.offerings': {
    key: 'identity.offerings',
    factPath: 'identity.offerings',
    label: 'What you sell',
    kind: 'textarea',
    max: 400,
    placeholder: 'Whole-bean subscriptions, gift boxes, wholesale for cafés.',
    read: (c) => c.identity.offerings,
    toPatch: (v) => ({ identity: { offerings: text(v) } }),
  },
  'identity.industry': {
    key: 'identity.industry',
    factPath: 'identity.industry',
    label: 'Industry',
    kind: 'text',
    max: 80,
    read: (c) => c.identity.industry,
    toPatch: (v) => ({ identity: { industry: text(v) } }),
  },
  'identity.website': {
    key: 'identity.website',
    factPath: 'identity.website',
    label: 'Website',
    kind: 'text',
    max: 200,
    placeholder: 'yourcompany.com',
    read: (c) => c.identity.website,
    toPatch: (v) => ({ identity: { website: text(v) } }),
  },
  'audience.marketMode': {
    key: 'audience.marketMode',
    factPath: 'audience.marketMode',
    label: 'You sell to',
    kind: 'marketMode',
    hint: 'The biggest single difference in how Aura writes.',
    read: (c) => c.audience.marketMode,
    toPatch: (v) => ({ audience: { marketMode: text(v) } }),
  },
  'audience.stated': {
    key: 'audience.stated',
    factPath: 'audience.stated',
    label: 'Your typical customer',
    kind: 'textarea',
    max: AUDIENCE_MAX,
    placeholder:
      'Ops leads at 50–200 person logistics firms who still run scheduling in spreadsheets.',
    hint: 'Aura writes TO this person.',
    read: (c) => c.audience.stated,
    toPatch: (v) => ({ audience: { stated: text(v) } }),
  },
  'objectives.goals': {
    key: 'objectives.goals',
    factPath: 'objectives.goals',
    label: 'What you are working towards',
    kind: 'textarea',
    max: GOALS_MAX,
    placeholder: 'Book 20 qualified demos this quarter.',
    hint: 'Steers what Aura suggests, never stated in posts.',
    read: (c) => c.objectives.goals,
    toPatch: (v) => ({ objectives: { goals: text(v) } }),
  },
  'channels.preferred': {
    key: 'channels.preferred',
    factPath: 'channels.preferred',
    label: 'Where you publish',
    kind: 'channels',
    read: (c) => c.channels.preferred,
    toPatch: (v) => ({ channels: { preferred: Array.isArray(v) ? v : [v] } }),
  },
  'voice.notes': {
    key: 'voice.notes',
    factPath: 'voice.summary',
    label: 'Your voice, in your words',
    kind: 'textarea',
    max: 2000,
    placeholder: 'Warm, plain-spoken, a little dry. Never salesy.',
    read: (c) => c.voice.notes,
    toPatch: (v) => ({ voice: { notes: text(v) } }),
  },
};

export const MARKET_MODE_LABEL: Record<(typeof MARKET_MODES)[number], string> =
  {
    B2B: 'Businesses',
    B2C: 'Consumers',
  };

export const CHANNEL_OPTIONS = CONTENT_CHANNELS;

/** How a stored value reads on the page. */
export function displayValue(
  field: EditableField,
  ctx: BusinessContext,
): string | null {
  const v = field.read(ctx);
  if (v === null) return null;
  if (Array.isArray(v)) return v.length ? v.join(', ') : null;
  if (field.kind === 'marketMode')
    return MARKET_MODE_LABEL[v as 'B2B' | 'B2C'] ?? v;
  return v;
}

// ---------------------------------------------------------------------------
// Source and freshness indicators
// ---------------------------------------------------------------------------

export type Tone = 'muted' | 'success' | 'warning' | 'default';

export interface Indicator {
  label: string;
  tone: Tone;
  /** Longer explanation for a tooltip. */
  title?: string;
}

/** Where a fact came from, as a short badge. */
export function sourceIndicator(
  fact: BusinessFact | undefined,
): Indicator | null {
  if (!fact) return null;
  if (fact.inferred) {
    return {
      label: 'Assumed',
      tone: 'warning',
      title:
        fact.note ?? 'Taken from another source because this one is empty.',
    };
  }
  switch (fact.sourceType) {
    case 'ai_derived':
      return {
        label: 'AI-suggested',
        tone: 'warning',
        title:
          'Suggested by AI and not confirmed. Aura treats it as an assumption until you confirm it.',
      };
    case 'onboarding':
      return { label: 'From onboarding', tone: 'muted' };
    case 'user_provided':
      return { label: 'Set by you', tone: 'muted' };
    case 'connected_platform':
      return { label: 'From a connected account', tone: 'muted' };
    case 'uploaded_document':
      return { label: 'From your documents', tone: 'muted' };
    case 'knowledge_base':
      return {
        label: 'From your website',
        tone: 'muted',
        title: 'Crawled from your site; not confirmed as a statement.',
      };
    case 'marketing_memory':
      return { label: 'Learned from results', tone: 'muted' };
    case 'system_generated':
      return { label: 'From your activity', tone: 'muted' };
  }
}

/** How current a fact is, as a short badge. Null when nothing is worth saying. */
export function freshnessIndicator(
  fact: BusinessFact | undefined,
): Indicator | null {
  if (!fact) return null;
  switch (fact.freshness) {
    case 'stale':
      return {
        label: 'Out of date',
        tone: 'warning',
        title:
          fact.ageDays !== null
            ? `Last updated ${fact.ageDays} days ago. Review it, then edit or confirm.`
            : 'Review it, then edit or confirm.',
      };
    case 'aging':
      return {
        label: 'Review soon',
        tone: 'default',
        title: `Last updated ${fact.ageDays} days ago.`,
      };
    case 'fresh':
      return fact.ageDays === null
        ? null
        : {
            label:
              fact.ageDays === 0
                ? 'Updated today'
                : `Updated ${fact.ageDays}d ago`,
            tone: 'muted',
          };
    case 'unknown':
      return {
        label: 'Date unknown',
        tone: 'muted',
        title:
          'Saved before Aura recorded dates. Confirm it to start the clock.',
      };
  }
}

/**
 * What a "Confirm" button would confirm, or null when there is nothing a
 * person can vouch for here.
 *
 * Only a stored value can be confirmed: a value borrowed from last month's
 * plan is not stored in your profile, so it is adopted by editing instead.
 */
export function confirmTarget(
  field: EditableField | null,
  fact: BusinessFact | undefined,
): string | null {
  if (!fact || fact.inferred) return null;
  if (
    fact.trusted &&
    fact.freshness !== 'stale' &&
    fact.freshness !== 'unknown'
  )
    return null;
  if (
    field?.factPath === 'voice.summary' ||
    (!field && fact.source === 'brand_voice_profile')
  ) {
    return fact.source === 'brand_voice_profile'
      ? 'voice.profile'
      : fact.source === 'onboarding_notes'
        ? 'voice.notes'
        : null;
  }
  return field?.key ?? null;
}

// ---------------------------------------------------------------------------
// What needs attention
// ---------------------------------------------------------------------------

export interface AttentionItem {
  key: string;
  severity: 'required' | 'warning' | 'info';
  title: string;
  detail: string;
  /** A field on this page to open, or a page elsewhere to go to. */
  editKey?: string;
  href?: string;
}

/**
 * Everything the user should look at, most important first: required
 * information that is missing, then out-of-date and conflicting values, then
 * recommended information and AI suggestions awaiting review.
 */
export function attentionItems(ctx: BusinessContext): AttentionItem[] {
  const items: AttentionItem[] = [];
  const editKeyFor = (path: string) =>
    Object.values(EDITABLE_FIELDS).find(
      (f) => f.factPath === path && f.key !== 'voice.notes',
    )?.key ?? (path === 'voice.summary' ? 'voice.notes' : undefined);

  for (const path of ctx.meta.completeness.missingRequired) {
    const def = contextField(path as ContextFieldPath);
    items.push({
      key: `missing:${path}`,
      severity: 'required',
      title: `${def.label} is missing`,
      detail:
        'Aura needs this before it can write or recommend anything specific to you.',
      editKey: editKeyFor(path),
      href: editKeyFor(path) ? undefined : def.href,
    });
  }

  const seen = new Set<string>();
  const byKind = (kind: ContextIssue['kind']) =>
    ctx.meta.issues.filter((i) => i.kind === kind);
  for (const issue of [...byKind('stale'), ...byKind('value_conflict')]) {
    const key = `${issue.kind}:${issue.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const def = contextField(issue.field as ContextFieldPath);
    items.push({
      key,
      severity: 'warning',
      title:
        issue.kind === 'stale'
          ? `${def.label} may be out of date`
          : `${def.label} differs between sources`,
      detail: issue.message,
      editKey: editKeyFor(issue.field),
      href: editKeyFor(issue.field) ? undefined : def.href,
    });
  }

  for (const path of ctx.meta.completeness.missingRecommended) {
    const def = contextField(path as ContextFieldPath);
    items.push({
      key: `recommended:${path}`,
      severity: 'info',
      title: `Add ${def.label.toLowerCase()}`,
      detail: 'Not required, but Aura’s output is noticeably better with it.',
      editKey: editKeyFor(path),
      href: editKeyFor(path) ? undefined : def.href,
    });
  }

  for (const issue of byKind('unverified')) {
    const fact = ctx.meta.facts[issue.field];
    if (!fact || fact.sourceType !== 'ai_derived') continue;
    const def = contextField(issue.field as ContextFieldPath);
    items.push({
      key: `unverified:${issue.field}`,
      severity: 'info',
      title: `Review AI-suggested ${def.label.toLowerCase()}`,
      detail: issue.message,
      editKey: editKeyFor(issue.field),
      href: editKeyFor(issue.field) ? undefined : def.href,
    });
  }

  return items;
}
