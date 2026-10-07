import type { SuggestionView } from '@/lib/aura-suggests';

/**
 * Aura Home — the home page as a recommendation-led answer to three
 * questions, not a wall of metrics:
 *
 *   What matters right now?      whatMattersNow — a short, ranked list of the
 *                                things that need a person, each with the one
 *                                action that deals with it
 *   What does Aura suggest?      Aura Suggests (lib/aura-suggests.ts)
 *   What happened recently?      buildActivity — what Aura and the team did
 *
 * plus the open opportunities and a results summary that compares, rather
 * than lists, numbers. Everything here is computed live (the weekly briefing
 * stays below as "This week"), and pure, so the rules are tested on their own.
 */

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// What matters now
// ---------------------------------------------------------------------------

export interface MatterItem {
  /** Stable key: which rule produced it. */
  key: string;
  /** urgent = time-sensitive or going wrong; action = waiting on a person. */
  tone: 'urgent' | 'action';
  title: string;
  detail: string;
  action: string;
  href: string;
}

export interface HomeOpportunity {
  id: string;
  title: string;
  typeLabel: string;
  why: string | null;
  status: string;
  priorityScore: number;
  daysLeft: number | null;
  detectedAt: Date;
}

export interface HomeCounts {
  pendingApproval: number;
  approvedUnscheduled: number;
  newLeads: number;
  outreachReady: number;
}

export interface ResultsInput {
  /** Analytics has anything at all to report. */
  hasData: boolean;
  postsThisWeek: number;
  postsLastWeek: number;
  engagementThisWeek: number;
  engagementLastWeek: number;
  health: { score: number; previous: number | null } | null;
  /** Suggestions answered in the last 30 days, and how many were a yes. */
  suggestionsAnswered: number;
  suggestionsActedOn: number;
}

/** The most items What matters now shows: more than this is a list, not a priority. */
export const MATTERS_LIMIT = 4;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** How far engagement must fall, week on week, to need attention. */
export const ENGAGEMENT_DROP = 0.25;

export function whatMattersNow(input: {
  suggestions: SuggestionView[];
  accepted: SuggestionView[];
  opportunities: HomeOpportunity[];
  counts: HomeCounts;
  results: ResultsInput | null;
}): MatterItem[] {
  const out: MatterItem[] = [];
  const { counts } = input;

  // 1. Time-sensitive suggestions: worth doing soon or not at all.
  for (const s of input.suggestions) {
    if (!s.timing || !/today|within [1-3] days/.test(s.timing)) continue;
    out.push({
      key: `suggestion:${s.id}`,
      tone: 'urgent',
      title: s.what,
      detail: `${s.timing} — after that it stops being relevant.`,
      action: 'See the suggestion',
      href: '/dashboard/suggestions',
    });
  }

  // 2. Opportunities about to close with no decision and no suggestion yet.
  for (const o of input.opportunities) {
    if (o.daysLeft === null || o.daysLeft > 3) continue;
    if (o.status === 'RECOMMENDED') continue; // covered by its suggestion
    out.push({
      key: `opportunity:${o.id}`,
      tone: 'urgent',
      title: o.title,
      detail:
        o.daysLeft <= 0
          ? 'This opportunity closes today.'
          : `This opportunity closes in ${plural(o.daysLeft, 'day')}.`,
      action: 'Decide on it',
      href: `/dashboard/opportunities?focus=${o.id}`,
    });
  }

  // 3. Results going the wrong way.
  const r = input.results;
  if (
    r?.hasData &&
    r.engagementLastWeek > 0 &&
    r.engagementThisWeek <= r.engagementLastWeek * (1 - ENGAGEMENT_DROP)
  ) {
    const pct = Math.round(
      (1 - r.engagementThisWeek / r.engagementLastWeek) * 100,
    );
    out.push({
      key: 'results:engagement-drop',
      tone: 'urgent',
      title: `Engagement is down ${pct}% on last week`,
      detail: `${r.engagementThisWeek} this week, against ${r.engagementLastWeek} the week before.`,
      action: 'See what changed',
      href: '/dashboard/analytics',
    });
  }

  // 4. Work waiting on a person.
  if (counts.pendingApproval > 0) {
    out.push({
      key: 'content:approval',
      tone: 'action',
      title: `${plural(counts.pendingApproval, 'post')} waiting for your approval`,
      detail: 'Written and ready. Nothing publishes until you approve it.',
      action: 'Review',
      href: '/dashboard/content',
    });
  }
  if (input.accepted.length > 0) {
    const first = input.accepted[0]!;
    out.push({
      key: 'suggestions:accepted',
      tone: 'action',
      title:
        input.accepted.length === 1
          ? `Next step on “${first.what}”`
          : `${plural(input.accepted.length, 'suggestion')} you said yes to are waiting`,
      detail:
        input.accepted.length === 1
          ? 'You said yes — this is the next step.'
          : `You said yes to these. Start with “${first.what}”.`,
      action: first.next.label,
      href: first.next.href,
    });
  }
  if (counts.approvedUnscheduled > 0) {
    out.push({
      key: 'content:unscheduled',
      tone: 'action',
      title: `${plural(counts.approvedUnscheduled, 'approved post')} with no publish time`,
      detail: 'Approved, but not on the calendar yet.',
      action: 'Schedule',
      href: '/dashboard/content/calendar',
    });
  }
  if (counts.newLeads > 0) {
    out.push({
      key: 'leads:new',
      tone: 'action',
      title: `${plural(counts.newLeads, 'new lead')} to review`,
      detail: 'People who may be worth contacting.',
      action: 'Review leads',
      href: '/dashboard/leads',
    });
  }
  if (counts.outreachReady > 0) {
    out.push({
      key: 'outreach:ready',
      tone: 'action',
      title: `${plural(counts.outreachReady, 'message')} ready to send`,
      detail: 'Approved outreach, waiting to go out.',
      action: 'Send',
      href: '/dashboard/outreach',
    });
  }

  // Urgent first; within a tone, the order above.
  return [
    ...out.filter((m) => m.tone === 'urgent'),
    ...out.filter((m) => m.tone === 'action'),
  ].slice(0, MATTERS_LIMIT);
}

// ---------------------------------------------------------------------------
// Active opportunities
// ---------------------------------------------------------------------------

/** Open opportunities, most worth a look first: closing soon, then priority. */
export function activeOpportunities(
  list: HomeOpportunity[],
  limit = 4,
): HomeOpportunity[] {
  const soon = (o: HomeOpportunity) =>
    o.daysLeft !== null && o.daysLeft <= 7 ? 0 : 1;
  return [...list]
    .sort(
      (a, b) =>
        soon(a) - soon(b) ||
        b.priorityScore - a.priorityScore ||
        b.detectedAt.getTime() - a.detectedAt.getTime() ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}

export function closesIn(daysLeft: number | null): string | null {
  if (daysLeft === null) return null;
  if (daysLeft <= 0) return 'Closes today';
  if (daysLeft === 1) return 'Closes tomorrow';
  if (daysLeft <= 30) return `Closes in ${daysLeft} days`;
  return null;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ResultTile {
  key: string;
  label: string;
  value: string;
  /** Compared with the period before, in words. Null when there is nothing to compare. */
  change: { direction: 'up' | 'down' | 'flat'; text: string } | null;
  note: string;
  href: string;
}

function compare(
  now: number,
  before: number,
  unit: string,
): ResultTile['change'] {
  if (now === before) {
    return before === 0
      ? null
      : { direction: 'flat', text: 'Same as last week' };
  }
  if (before === 0) return { direction: 'up', text: `Up from none last week` };
  const pct = Math.round(((now - before) / before) * 100);
  return pct > 0
    ? { direction: 'up', text: `Up ${pct}% on last week` }
    : {
        direction: 'down',
        text: `Down ${Math.abs(pct)}% on last week${unit ? ` (${before} ${unit})` : ''}`,
      };
}

/**
 * The results worth seeing on Home: each compared with the period before, so
 * a number says whether things are getting better. The full picture stays in
 * Results (/dashboard/analytics).
 */
export function buildResults(r: ResultsInput): ResultTile[] {
  // No results recorded in either week is "not known yet", not zero.
  const engaged = r.hasData && r.engagementThisWeek + r.engagementLastWeek > 0;
  const tiles: ResultTile[] = [
    {
      key: 'posts',
      label: 'Posts published',
      value: String(r.postsThisWeek),
      change: compare(r.postsThisWeek, r.postsLastWeek, ''),
      note: 'In the last 7 days.',
      href: '/dashboard/content',
    },
    {
      key: 'engagement',
      label: 'Engagement',
      value: engaged ? String(r.engagementThisWeek) : '—',
      change: engaged
        ? compare(r.engagementThisWeek, r.engagementLastWeek, 'then')
        : null,
      note: engaged
        ? 'Likes, comments and shares on posts from the last 7 days.'
        : 'Appears once published posts have results.',
      href: '/dashboard/analytics',
    },
  ];
  if (r.health) {
    const d =
      r.health.previous === null ? null : r.health.score - r.health.previous;
    tiles.push({
      key: 'health',
      label: 'Marketing health',
      value: `${r.health.score}/100`,
      change:
        d === null || d === 0
          ? null
          : {
              direction: d > 0 ? 'up' : 'down',
              text: `${d > 0 ? 'Up' : 'Down'} ${plural(Math.abs(d), 'point')} since the last check`,
            },
      note: 'How your marketing is doing overall.',
      href: '/dashboard/intelligence',
    });
  }
  tiles.push({
    key: 'suggestions',
    label: 'Suggestions acted on',
    value:
      r.suggestionsAnswered > 0
        ? `${r.suggestionsActedOn} of ${r.suggestionsAnswered}`
        : '—',
    change: null,
    note:
      r.suggestionsAnswered > 0
        ? 'Of those you answered in the last 30 days.'
        : 'Appears once you answer Aura’s suggestions.',
    href: '/dashboard/suggestions',
  });
  return tiles;
}

/** This week's and last week's totals from dated points. */
export function splitWeeks(
  points: { date: string | Date; value: number }[],
  now: Date,
): { thisWeek: number; lastWeek: number } {
  const t = now.getTime();
  let thisWeek = 0;
  let lastWeek = 0;
  for (const p of points) {
    const age = t - new Date(p.date).getTime();
    if (age < 0) continue;
    if (age < 7 * DAY) thisWeek += p.value;
    else if (age < 14 * DAY) lastWeek += p.value;
  }
  return { thisWeek, lastWeek };
}

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

export interface ActivityInput {
  at: Date;
  /** Who did it: Aura, or a person's name. */
  by: 'aura' | string;
  text: string;
  href: string | null;
  /**
   * Routine work Aura does in bursts (a run of suggestions, a batch of
   * posts). Several of the same kind within a day read as one line.
   */
  group?: ActivityGroup;
}

export type ActivityGroup = 'suggested' | 'spotted' | 'wrote' | 'published';

const GROUP_TEXT: Record<ActivityGroup, (n: number) => string> = {
  suggested: (n) => `made ${n} new suggestions`,
  spotted: (n) => `spotted ${n} new opportunities`,
  wrote: (n) => `wrote ${n} posts`,
  published: (n) => `published ${n} posts`,
};

/** How close together grouped items must be to share a line. */
const GROUP_WINDOW = DAY;

export interface ActivityItem {
  key: string;
  by: string;
  byAura: boolean;
  text: string;
  href: string | null;
  when: string;
  at: string;
}

export function relativeTime(at: Date, now: Date): string {
  const s = Math.max(0, (now.getTime() - at.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return plural(Math.floor(s / 60), 'minute') + ' ago';
  if (s < 86_400) return plural(Math.floor(s / 3600), 'hour') + ' ago';
  const d = Math.floor(s / 86_400);
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  return plural(Math.floor(d / 7), 'week') + ' ago';
}

/** The newest things that happened, each said once, newest first. */
export function buildActivity(
  items: ActivityInput[],
  now: Date,
  limit = 8,
): ActivityItem[] {
  const seen = new Set<string>();
  const sorted = [...items]
    .filter((i) => i.at.getTime() <= now.getTime())
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  // Fold bursts: the newest item of a group stands for every item of the
  // same group (and person) within a day of it.
  const folded: ActivityInput[] = [];
  const used = new Set<ActivityInput>();
  for (const i of sorted) {
    if (used.has(i)) continue;
    if (!i.group) {
      folded.push(i);
      continue;
    }
    const same = sorted.filter(
      (j) =>
        !used.has(j) &&
        j.group === i.group &&
        j.by === i.by &&
        i.at.getTime() - j.at.getTime() <= GROUP_WINDOW,
    );
    for (const j of same) used.add(j);
    folded.push(
      same.length >= 3 ? { ...i, text: GROUP_TEXT[i.group](same.length) } : i,
      ...(same.length >= 3 ? [] : same.slice(1)),
    );
  }
  return folded
    .filter((i) => {
      const k = `${i.by}|${i.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit)
    .map((i, n) => ({
      key: `${i.at.getTime()}-${n}`,
      by: i.by === 'aura' ? 'Aura' : i.by,
      byAura: i.by === 'aura',
      text: i.text,
      href: i.href,
      when: relativeTime(i.at, now),
      at: i.at.toISOString(),
    }));
}

/** How a recommendation's history entry reads in the activity feed. */
export function recommendationActivity(
  action: string,
  title: string,
): string | null {
  const t = `“${title}”`;
  switch (action) {
    case 'generate':
      return `suggested ${t}`;
    case 'accept':
      return `said yes to ${t}`;
    case 'edit':
      return `edited and accepted ${t}`;
    case 'skip':
      return `skipped ${t}`;
    case 'reject':
      return `turned down ${t}`;
    case 'start':
      return `started ${t}`;
    case 'complete':
      return `completed ${t}`;
    case 'defer':
      return `set ${t} aside for now`;
    case 'expire':
      return `${t} expired before anyone decided`;
    default:
      // present, withdraw: not worth a line on Home.
      return null;
  }
}
