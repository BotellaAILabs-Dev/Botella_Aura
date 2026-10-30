import type { AttentionItem } from '@/lib/business-context-ui';
import { gapHref, type MarketingGap } from '@/lib/marketing-gaps';
import type { SuggestionView } from '@/lib/aura-suggests';

/**
 * Next Best Action — one ranked list of what to do, across everything Aura
 * knows needs attention.
 *
 * Before this, a business owner had to visit Aura Suggests, Marketing
 * Intelligence (gaps), About My Business (missing details) and the review
 * queue, then work out for themselves which mattered most. Each item here
 * says the same three things in the same order — the problem, why it
 * matters, what to do — with one button, and the same thing never appears
 * twice even when two parts of Aura noticed it (a suggestion to post on
 * Instagram and a "nothing on Instagram in 6 weeks" gap are one action).
 *
 * Pure and client-safe; server/home/next-best-action.service.ts loads it.
 */

export type ActionSource = 'setup' | 'approval' | 'suggestion' | 'gap';

export interface NextAction {
  key: string;
  source: ActionSource;
  /** What is wrong or missing, in the business owner's terms. */
  problem: string;
  /** Why it matters to them. */
  whyItMatters: string;
  /** What Aura recommends doing. */
  recommendation: string;
  /** The one button. */
  action: { label: string; href: string };
  /** What it is based on, when there is something to check. */
  evidence: string | null;
  /** 0–100; higher first. */
  priority: number;
  urgency: 'now' | 'soon' | 'when_you_can';
  /** Other parts of Aura that noticed the same thing, merged into this one. */
  alsoFrom: ActionSource[];
}

export interface NextActionInput {
  attention: AttentionItem[];
  /** Drafts waiting for someone to approve them. */
  pendingApproval: number;
  /** Open suggestions, best first (Aura Suggests' own ranking). */
  suggestions: SuggestionView[];
  gaps: MarketingGap[];
  /** The person can approve content (owner or admin). */
  canApprove: boolean;
}

export const NBA_LIMIT = 6;

const GAP_WHY: Record<MarketingGap['kind'], string> = {
  no_posts: 'Until something is published, Aura has no results to learn from and nothing is reaching customers.',
  product_never: 'Customers cannot buy what they never hear about.',
  product_silent: 'People forget what they stop hearing about, and competitors fill the space.',
  channel_silent: 'Followers drift and the platform shows your next post to fewer people after a long gap.',
  cadence_drop: 'Reach falls quickly when posting slows, and it takes longer to build back.',
  format_rut: 'One format repeated gets scrolled past; a change of format earns fresh attention.',
  format_underused: 'Your own results say this format works better — doing more of it is the quickest win.',
};

const GAP_PRIORITY: Record<MarketingGap['severity'], number> = { high: 74, medium: 54, low: 30 };

/** Words that carry the subject, for spotting the same thing said twice. */
const STOP = new Set(
  'the a an and or of to in on for with your you our at by from is are be it this that post posts about more new write create join conversation again nothing'.split(' '),
);
export function subjectWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)),
  );
}

/** Share of the smaller set's words found in the other (0–1). */
export function sameSubject(a: string, b: string): number {
  const x = subjectWords(a);
  const y = subjectWords(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}

/** Two items this alike are the same action. */
export const SAME_SUBJECT = 0.6;

function firstSentence(text: string): string {
  const t = text.trim();
  const m = /^(.{20,240}?[.!?])(\s|$)/.exec(t);
  return m ? m[1]! : t.slice(0, 240);
}

function fromSuggestion(v: SuggestionView, index: number): NextAction {
  const band = v.place.toLowerCase();
  const top = band.includes('top') || band.includes('now');
  return {
    key: `suggestion:${v.id}`,
    source: 'suggestion',
    problem: v.what,
    whyItMatters: v.whyNow[0] ?? firstSentence(v.why),
    recommendation: v.action,
    action: { label: v.next.label, href: v.next.href },
    evidence: v.evidence[0] ? `${v.evidence[0].source}: ${v.evidence[0].label}` : null,
    // Aura Suggests' own order is kept within suggestions.
    priority: Math.max(35, (top ? 80 : 62) - index * 3),
    urgency: v.timing?.includes('today') ? 'now' : top ? 'soon' : 'when_you_can',
    alsoFrom: [],
  };
}

function fromGap(g: MarketingGap): NextAction {
  return {
    key: `gap:${g.key}`,
    source: 'gap',
    problem: g.title,
    whyItMatters: GAP_WHY[g.kind],
    recommendation: g.action.brief,
    action: { label: g.action.label, href: gapHref(g) },
    evidence: g.evidence,
    priority: GAP_PRIORITY[g.severity],
    urgency: g.severity === 'high' ? 'soon' : 'when_you_can',
    alsoFrom: [],
  };
}

function fromAttention(a: AttentionItem): NextAction | null {
  // Only what stops Aura working well; "may be out of date" lives on its page.
  if (a.severity !== 'required') return null;
  return {
    key: `setup:${a.key}`,
    source: 'setup',
    problem: a.title,
    whyItMatters: a.detail,
    recommendation: 'Fill it in on About My Business — a sentence is enough.',
    action: {
      label: 'Add it now',
      href: a.href ?? (a.editKey ? `/dashboard/business#field-${a.editKey}` : '/dashboard/business'),
    },
    evidence: null,
    priority: 95,
    urgency: 'now',
    alsoFrom: [],
  };
}

/**
 * The ranked, de-duplicated list. Merging keeps the higher-priority item and
 * records where else the same thing came from; suggestions about the same
 * subject (the same story as a LinkedIn post and as a blog) are one action.
 */
export function buildNextActions(input: NextActionInput, limit = NBA_LIMIT): NextAction[] {
  const items: NextAction[] = [];
  for (const a of input.attention) {
    const x = fromAttention(a);
    if (x) items.push(x);
  }
  if (input.pendingApproval > 0 && input.canApprove) {
    const n = input.pendingApproval;
    items.push({
      key: 'approval:pending',
      source: 'approval',
      problem: `${n} draft${n === 1 ? ' is' : 's are'} waiting for approval.`,
      whyItMatters: 'Nothing is published until it is approved, so finished work is sitting idle.',
      recommendation: 'Review them: approve, or send back with a note.',
      action: { label: 'Review drafts', href: '/dashboard/review' },
      evidence: null,
      priority: 88,
      urgency: 'now',
      alsoFrom: [],
    });
  }
  input.suggestions.forEach((v, i) => items.push(fromSuggestion(v, i)));
  for (const g of input.gaps) items.push(fromGap(g));

  items.sort((a, b) => b.priority - a.priority);
  const kept: NextAction[] = [];
  for (const item of items) {
    const twin = kept.find(
      (k) =>
        k.source !== 'setup' &&
        item.source !== 'setup' &&
        k.source !== 'approval' &&
        item.source !== 'approval' &&
        sameSubject(`${k.problem} ${k.recommendation}`, `${item.problem} ${item.recommendation}`) >= SAME_SUBJECT,
    );
    if (twin) {
      if (item.source !== twin.source && !twin.alsoFrom.includes(item.source)) twin.alsoFrom.push(item.source);
      // A gap's evidence ("last mentioned on …") is worth keeping on a suggestion.
      if (!twin.evidence && item.evidence) twin.evidence = item.evidence;
      continue;
    }
    kept.push({ ...item, alsoFrom: [...item.alsoFrom] });
  }
  return kept.slice(0, limit);
}

/**
 * Suggestions about the same thing, shown once. Aura Suggests' duplicate
 * rule only matches the same kind on the same channel, so one story could
 * appear as a LinkedIn post and again as a blog. Keeps the higher-ranked.
 */
export function dedupeSuggestions(views: SuggestionView[]): { kept: SuggestionView[]; merged: number } {
  const kept: SuggestionView[] = [];
  let merged = 0;
  for (const v of views) {
    // The same story or source behind both (evidence rows are per
    // recommendation, so compare what they point at, not their ids).
    const storyOf = (e: SuggestionView['evidence'][number]) => `${e.source}|${e.url ?? e.label}`.toLowerCase();
    const stories = new Set(v.evidence.map(storyOf));
    const twin = kept.find(
      (k) =>
        (stories.size > 0 && k.evidence.some((e) => stories.has(storyOf(e))) && sameSubject(k.what, v.what) >= 0.34) ||
        sameSubject(`${k.what} ${k.action}`, `${v.what} ${v.action}`) >= 0.75,
    );
    if (twin) {
      merged++;
      continue;
    }
    kept.push(v);
  }
  return { kept, merged };
}
