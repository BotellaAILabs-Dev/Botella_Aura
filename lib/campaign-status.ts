import type { BadgeProps } from '@/components/ui/badge';

/**
 * What a campaign's state actually means, in one place.
 *
 * Three problems this replaces.
 *
 * FIRST, the UI rendered the database enum directly — `<Badge>{status}</Badge>`
 * put ACTIVE, DRAFT and COMPLETED on screen in the list, the detail header and
 * the timeline. Those are storage values, not English, and they say nothing
 * about whether the person looking at them has to do something.
 *
 * SECOND, three of the five stored states were unreachable. Creation sets
 * ACTIVE directly, so DRAFT was dead on arrival; nothing anywhere wrote
 * COMPLETED or ARCHIVED, though the UI carried branches for both. A campaign
 * that finished all thirty days of its work still read as ACTIVE forever,
 * indistinguishable from one that started this morning.
 *
 * THIRD, and the reason the first two matter: the stored status alone cannot
 * answer the only two questions a person opens this page with — how far along
 * is it, and does it need me? A campaign can be ACTIVE and perfectly on
 * schedule, or ACTIVE with nine drafts waiting on approval, or ACTIVE with
 * every task overdue because the daily job has been failing. Those are three
 * different situations wearing one word.
 *
 * So presentation state is DERIVED from the stored status plus real task
 * counts, and every state names its required action or explicitly says there
 * is none.
 */

/** The stored column. Kept in sync with the Prisma CampaignStatus enum. */
export type CampaignStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'PAUSED'
  | 'COMPLETED'
  | 'ARCHIVED';

/** The stored task column. Kept in sync with CampaignTaskStatus. */
export type CampaignTaskStatus =
  | 'PENDING'
  | 'GENERATED'
  | 'APPROVED'
  | 'SKIPPED'
  | 'FAILED';

/**
 * What the user sees. Deliberately not the same set as the stored column:
 * NEEDS_REVIEW and BEHIND are both stored as ACTIVE, and the difference
 * between them is the whole point of looking at the page.
 */
export type CampaignStateKey =
  | 'NEEDS_REVIEW'
  | 'BEHIND'
  | 'RUNNING'
  | 'PAUSED'
  | 'FINISHED'
  | 'ARCHIVED'
  | 'NOT_STARTED';

export interface CampaignState {
  key: CampaignStateKey;
  /** Two words at most — this sits in a badge. */
  label: string;
  tone: NonNullable<BadgeProps['variant']>;
  /** What is happening, in a sentence. */
  summary: string;
  /**
   * What the person has to do, or null when the honest answer is "nothing".
   *
   * Null is a real and common answer, and saying so plainly is worth more than
   * inventing a call to action. A campaign running correctly with everything
   * scheduled for next week needs nothing from anyone, and a UI that implies
   * otherwise trains people to ignore it.
   */
  action: string | null;
  /** True when `action` is something the user must do now. */
  needsAttention: boolean;
}

export interface CampaignTaskCounts {
  total: number;
  /** GENERATED — produced and waiting on a human. */
  awaitingReview: number;
  /** PENDING and due, i.e. the daily job has not picked it up. */
  overdue: number;
  /** PENDING with a future date — nothing to do yet. */
  scheduled: number;
  /** APPROVED + SKIPPED + GENERATED, i.e. no longer waiting to run. */
  done: number;
  failed: number;
}

/** Bucket every task into the counts the UI reasons about. */
export function countTasks(
  tasks: ReadonlyArray<{ status: string; scheduledDate: Date | string }>,
  now: Date = new Date(),
): CampaignTaskCounts {
  const nowMs = now.getTime();
  let awaitingReview = 0;
  let overdue = 0;
  let scheduled = 0;
  let done = 0;
  let failed = 0;

  for (const task of tasks) {
    const when =
      task.scheduledDate instanceof Date
        ? task.scheduledDate.getTime()
        : new Date(task.scheduledDate).getTime();

    switch (task.status) {
      case 'GENERATED':
        awaitingReview++;
        done++;
        break;
      case 'APPROVED':
      case 'SKIPPED':
        done++;
        break;
      case 'FAILED':
        failed++;
        break;
      case 'PENDING':
      default:
        // The distinction PENDING was hiding: work scheduled for Thursday is
        // not the same as work that was due on Monday and never ran.
        if (when <= nowMs) overdue++;
        else scheduled++;
        break;
    }
  }

  return { total: tasks.length, awaitingReview, overdue, scheduled, done, failed };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The state to show, from the stored status and what the tasks actually say.
 *
 * Order matters: a paused campaign is paused even if drafts are waiting, and a
 * campaign needing review says so even while other work is still scheduled —
 * because that is the thing the person can act on.
 */
export function deriveCampaignState(
  status: CampaignStatus | string,
  counts: CampaignTaskCounts,
): CampaignState {
  if (status === 'ARCHIVED') {
    return {
      key: 'ARCHIVED',
      label: 'Archived',
      tone: 'muted',
      summary: 'Archived. Kept for reference; no work will run.',
      action: null,
      needsAttention: false,
    };
  }

  if (status === 'PAUSED') {
    return {
      key: 'PAUSED',
      label: 'Paused',
      tone: 'warning',
      summary:
        counts.scheduled + counts.overdue > 0
          ? `Paused with ${plural(counts.scheduled + counts.overdue, 'task')} not yet run. Nothing will happen until you resume.`
          : 'Paused. Nothing will happen until you resume.',
      action: 'Resume the campaign to let the remaining work run.',
      needsAttention: false,
    };
  }

  // Finished: explicitly marked, or every task has reached a terminal state.
  const allTerminal =
    counts.total > 0 && counts.scheduled === 0 && counts.overdue === 0;
  if (status === 'COMPLETED' || (status === 'ACTIVE' && allTerminal)) {
    if (counts.awaitingReview > 0) {
      return {
        key: 'NEEDS_REVIEW',
        label: 'Needs review',
        tone: 'warning',
        summary: `All work is done. ${plural(counts.awaitingReview, 'item')} still waiting for your approval.`,
        action: `Review ${plural(counts.awaitingReview, 'item')} below.`,
        needsAttention: true,
      };
    }
    return {
      key: 'FINISHED',
      label: 'Finished',
      tone: 'success',
      summary:
        counts.failed > 0
          ? `Every task has run. ${plural(counts.failed, 'task')} failed along the way.`
          : 'Every task in this campaign has run.',
      action: null,
      needsAttention: false,
    };
  }

  if (status === 'DRAFT') {
    return {
      key: 'NOT_STARTED',
      label: 'Not started',
      tone: 'muted',
      summary: 'Planned but not running yet. No work is scheduled.',
      action: 'Start the campaign to begin generating work.',
      needsAttention: true,
    };
  }

  // ACTIVE, from here down.
  if (counts.awaitingReview > 0) {
    return {
      key: 'NEEDS_REVIEW',
      label: 'Needs review',
      tone: 'warning',
      summary: `${plural(counts.awaitingReview, 'item')} generated and waiting for your approval.`,
      action: `Review ${plural(counts.awaitingReview, 'item')} below.`,
      needsAttention: true,
    };
  }

  /**
   * Overdue means the daily job has not run this work, which is a real fault
   * rather than a slow day — so it is surfaced as something to look at, not
   * dressed up as normal progress.
   */
  if (counts.overdue > 0) {
    return {
      key: 'BEHIND',
      label: 'Behind',
      tone: 'destructive',
      summary: `${plural(counts.overdue, 'task')} due but not yet generated.`,
      action:
        'The daily job runs each morning. If this does not clear by tomorrow, check the campaign job.',
      needsAttention: true,
    };
  }

  return {
    key: 'RUNNING',
    label: 'Running',
    tone: 'success',
    summary:
      counts.scheduled > 0
        ? `On schedule. Next ${plural(counts.scheduled, 'task')} queued for the days ahead.`
        : 'On schedule.',
    action: null,
    needsAttention: false,
  };
}

/**
 * Task-level presentation.
 *
 * "GENERATED" was the worst offender in the old UI: it describes what the
 * SYSTEM did, and reads to a user as a finished state, when it actually means
 * the opposite — the item is sitting there waiting for them.
 */
export interface TaskStateMeta {
  label: string;
  tone: NonNullable<BadgeProps['variant']>;
  /** Shown on hover; explains the state rather than restating the label. */
  hint: string;
}

export function taskState(
  status: CampaignTaskStatus | string,
  scheduledDate: Date | string,
  now: Date = new Date(),
): TaskStateMeta {
  switch (status) {
    case 'GENERATED':
      return {
        label: 'Needs review',
        tone: 'warning',
        hint: 'Aura produced this. It publishes nothing until you approve it.',
      };
    case 'APPROVED':
      return {
        label: 'Approved',
        tone: 'success',
        hint: 'You approved this item.',
      };
    case 'SKIPPED':
      return {
        label: 'Skipped',
        tone: 'muted',
        hint: 'Nothing to do for this task — it was passed over.',
      };
    case 'FAILED':
      return {
        label: 'Failed',
        tone: 'destructive',
        hint: 'This task errored and produced nothing. It will not retry on its own.',
      };
    case 'PENDING':
    default: {
      const when =
        scheduledDate instanceof Date
          ? scheduledDate.getTime()
          : new Date(scheduledDate).getTime();
      return when <= now.getTime()
        ? {
            label: 'Due',
            tone: 'outline',
            hint: 'Due now. The daily job picks this up each morning.',
          }
        : {
            label: 'Scheduled',
            tone: 'outline',
            hint: 'Scheduled for a future date — nothing to do until then.',
          };
    }
  }
}

/** Task types, labelled once. */
export const TASK_TYPE_LABEL: Record<string, string> = {
  GENERATE_CONTENT: 'Content',
  RUN_OUTREACH_BATCH: 'Outreach',
  RUN_DISCOVERY: 'Lead discovery',
  REVIEW_CHECKPOINT: 'Weekly review',
};

export function taskTypeLabel(type: string): string {
  return TASK_TYPE_LABEL[type] ?? type;
}
