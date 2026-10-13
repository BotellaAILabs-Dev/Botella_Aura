/**
 * The unified review experience: one shape for every piece of generated Aura
 * work a person reviews before it is used — Content Studio drafts and
 * outreach messages today (campaigns, the planner and Autopilot all produce
 * Content Studio drafts). Each module converts its item into a ReviewItem
 * (server/review/review-item.service.ts); one screen and one set of actions
 * review them all (components/dashboard/review/review-screen.tsx). Pure and
 * client-safe.
 */

import type { ApprovalSummary } from '@/lib/approval';

export interface ApprovalInfo extends ApprovalSummary {
  approvedByName: string | null;
  rejectedByName: string | null;
  history: {
    at: string;
    who: string;
    action: string;
    note: string | null;
    reason: string | null;
    version: number;
    /** The content as it was before this change is kept. */
    keptPrevious: boolean;
  }[];
}

export type ReviewKind = 'content' | 'outreach';
export const REVIEW_KINDS: ReviewKind[] = ['content', 'outreach'];

/** Where an item is in its life, in the same words for every module. */
export type ReviewState =
  'draft' | 'in_review' | 'approved' | 'rejected' | 'done';

export const STATE_LABEL: Record<ReviewState, string> = {
  draft: 'Draft',
  in_review: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  done: 'Published',
};

export const REVIEW_ACTIONS = [
  'back',
  'edit',
  'save',
  'regenerate',
  /** Send for approval (for people who cannot approve). */
  'submit',
  'approve',
  'reject',
  'schedule',
] as const;
export type ReviewActionKey = (typeof REVIEW_ACTIONS)[number];

export interface ActionState {
  available: boolean;
  /** Why it cannot be used right now, in words a person can act on. */
  reason?: string | null;
}

/** One editable piece of the generated content. */
export interface ReviewField {
  /** Path into the body ("paragraphs.1", "slides.0.headline", "hashtags"). */
  key: string;
  label: string;
  value: string;
  multiline: boolean;
  /** A list edited as one line ("#a #b"), split back on save. */
  list?: boolean;
  maxLength?: number;
}

export interface ReviewFlag {
  /** block — must be fixed before approval · review — a person must check · info — worth knowing. */
  severity: 'block' | 'review' | 'info';
  label: string;
  message: string;
  quote?: string | null;
  source: string;
}

export interface ReviewItem {
  kind: ReviewKind;
  id: string;
  title: string;
  /** "Content Studio", "Outreach". */
  module: string;
  /** "Instagram post", "Connection note". */
  typeLabel: string;
  state: ReviewState;
  statusLabel: string;
  rejectionReason: string | null;
  scheduledFor: string | null;
  updatedAt: string;
  /** The generated content, field by field. */
  fields: ReviewField[];
  /** The associated image or asset. */
  asset: {
    need: 'required' | 'recommended' | 'none';
    images: { url: string; alt: string }[];
    /** Where images are made or changed. */
    manageHref: string | null;
    note: string | null;
  } | null;
  /** What it was made for. */
  context: {
    recommendation: {
      title: string;
      why: string | null;
      href: string | null;
    } | null;
    goal: string | null;
    audience: string | null;
    channel: string | null;
    keyMessage: string | null;
    /** What it was written from when not a recommendation (a brief, a signal). */
    source: string | null;
    evidence: {
      label: string;
      detail: string | null;
      url: string | null;
      observedAt: string | null;
    }[];
    /** Extra facts worth seeing (the lead, the campaign). */
    extra: { label: string; value: string }[];
  };
  /** Quality warnings, most serious first. */
  flags: ReviewFlag[];
  /** The independent reviewer's verdict, when there is one. */
  reviewer: {
    status: 'pass' | 'review_required' | 'fail';
    score: number | null;
    summary: string | null;
    current: boolean;
    ran: boolean;
    unavailable: string | null;
    issues: {
      severity: 'blocker' | 'major' | 'minor';
      area: string;
      message: string;
      quote: string | null;
      suggestion: string | null;
    }[];
  } | null;
  /** What approval needs. */
  approval: {
    /** The approver must confirm they checked what was flagged. */
    needsConfirmation: boolean;
    confirmLabel: string | null;
    /** Approval is not possible until this is fixed. */
    blockedBy: string | null;
  };
  /** The unified approval record (lib/approval.ts): state, who, when, history. */
  approvalInfo: ApprovalInfo | null;
  actions: Record<ReviewActionKey, ActionState>;
  /** Regeneration options beyond a fresh take. */
  regenerate: { fixReview: boolean; instructions: boolean };
  /** Where Back goes, and the module's own full page. */
  backHref: string;
  moduleHref: string;
}

// ---------------------------------------------------------------------------
// Editing any content body as fields
// ---------------------------------------------------------------------------

const LABELS: Record<string, string> = {
  hook: 'Hook',
  paragraphs: 'Paragraph',
  cta: 'Call to action',
  hashtags: 'Hashtags',
  caption: 'Caption',
  altText: 'Image description (alt text)',
  title: 'Title',
  slides: 'Slide',
  headline: 'Headline',
  body: 'Body',
  tweets: 'Post',
  subtitle: 'Subtitle',
  sections: 'Section',
  heading: 'Heading',
  subjectLine: 'Subject line',
  previewText: 'Preview text',
  greeting: 'Greeting',
  signOff: 'Sign-off',
  primaryText: 'Primary text',
  description: 'Description',
  tagline: 'Tagline',
  keyMessage: 'Key message',
  shortCopy: 'Short copy',
  longCopy: 'Long copy',
  offer: 'Offer',
  terms: 'Terms',
  metaDescription: 'Meta description',
  draftText: 'Message',
};

/**
 * Reading order. Postgres stores JSON keys in its own order (shortest first),
 * so a body read back from the database would put "cta" before "caption".
 */
const ORDER = [
  'subjectLine',
  'previewText',
  'headline',
  'title',
  'tagline',
  'subtitle',
  'hook',
  'greeting',
  'caption',
  'primaryText',
  'keyMessage',
  'shortCopy',
  'longCopy',
  'offer',
  'paragraphs',
  'slides',
  'tweets',
  'sections',
  'heading',
  'body',
  'description',
  'terms',
  'cta',
  'signOff',
  'hashtags',
  'metaDescription',
  'altText',
];
const byOrder = ([a]: [string, unknown], [b]: [string, unknown]) => {
  const i = ORDER.indexOf(a);
  const j = ORDER.indexOf(b);
  return (i < 0 ? ORDER.length : i) - (j < 0 ? ORDER.length : j);
};

const label = (k: string) =>
  LABELS[k] ??
  k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
const LONG = new Set([
  'paragraphs',
  'body',
  'caption',
  'longCopy',
  'primaryText',
  'tweets',
  'draftText',
  'shortCopy',
]);
const LIST_OF_TAGS = new Set(['hashtags', 'keywords', 'tags']);

/** Every editable text in a body, in order, labelled for a person. */
export function bodyToFields(body: unknown): ReviewField[] {
  const out: ReviewField[] = [];
  const walk = (
    v: unknown,
    path: string[],
    parentKey: string | null,
    index: number | null,
  ) => {
    const key = path[path.length - 1] ?? '';
    if (typeof v === 'string') {
      const base = parentKey && index !== null ? parentKey : key;
      const name =
        parentKey && index !== null && /^\d+$/.test(key)
          ? `${label(parentKey)} ${index + 1}`
          : index !== null && parentKey
            ? `${label(parentKey)} ${index + 1} · ${label(key).toLowerCase()}`
            : label(key);
      out.push({
        key: path.join('.'),
        label: name,
        value: v,
        multiline: LONG.has(base) || v.length > 90,
      });
      return;
    }
    if (Array.isArray(v)) {
      if (LIST_OF_TAGS.has(key) && v.every((x) => typeof x === 'string')) {
        out.push({
          key: path.join('.'),
          label: label(key),
          value: (v as string[]).join(' '),
          multiline: false,
          list: true,
        });
        return;
      }
      v.forEach((x, i) => {
        if (typeof x === 'string') walk(x, [...path, String(i)], key, i);
        else if (x && typeof x === 'object') {
          for (const [k, child] of Object.entries(x).sort(byOrder)) {
            if (typeof child === 'string') {
              out.push({
                key: [...path, String(i), k].join('.'),
                label: `${label(key)} ${i + 1} · ${label(k).toLowerCase()}`,
                value: child,
                multiline: LONG.has(k) || child.length > 90,
              });
            }
          }
        }
      });
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v).sort(byOrder))
        walk(child, [...path, k], null, null);
    }
  };
  walk(body, [], null, null);
  return out;
}

/** The body with edited fields written back; everything else untouched. */
export function applyFields(
  body: unknown,
  edits: Record<string, string>,
  fields: ReviewField[],
): unknown {
  const copy = JSON.parse(JSON.stringify(body ?? {})) as Record<
    string,
    unknown
  >;
  for (const f of fields) {
    if (!(f.key in edits)) continue;
    const parts = f.key.split('.');
    let target: Record<string, unknown> | unknown[] = copy;
    for (const p of parts.slice(0, -1)) {
      target = (target as Record<string, unknown>)[p] as Record<
        string,
        unknown
      >;
      if (!target || typeof target !== 'object') break;
    }
    if (!target || typeof target !== 'object') continue;
    const last = parts[parts.length - 1]!;
    const value = edits[f.key]!;
    (target as Record<string, unknown>)[last] = f.list
      ? value
          .split(/[\s,]+/)
          .map((t) => t.replace(/^#/, '').trim())
          .filter(Boolean)
      : value;
  }
  return copy;
}

/** Edits that differ from what is stored. */
export function changedEdits(
  fields: ReviewField[],
  edits: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (f.key in edits && edits[f.key] !== f.value) out[f.key] = edits[f.key]!;
  }
  return out;
}

/** Key for keeping unsaved edits in the browser, tied to the version they were made on. */
export function editsStorageKey(
  item: Pick<ReviewItem, 'kind' | 'id' | 'updatedAt'>,
): string {
  return `aura-review-edits:${item.kind}:${item.id}:${item.updatedAt}`;
}

export function reviewHref(kind: ReviewKind, id: string): string {
  return `/dashboard/review/${kind}/${id}`;
}
