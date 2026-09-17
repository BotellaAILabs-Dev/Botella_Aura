import { describe, it, expect } from 'vitest';

import {
  countTasks,
  deriveCampaignState,
  taskState,
  taskTypeLabel,
  TASK_TYPE_LABEL,
} from '@/lib/campaign-status';

/**
 * Campaign state presentation.
 *
 * The stored enum could not answer the two questions a person opens a campaign
 * with — how far along is it, and does it need me. ACTIVE covered a campaign
 * running perfectly, one with drafts waiting on approval, and one whose daily
 * job had been failing for a week.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-15T12:00:00Z');
const past = (days: number) => new Date(NOW.getTime() - days * DAY);
const future = (days: number) => new Date(NOW.getTime() + days * DAY);

function tasks(
  spec: Array<[status: string, date: Date]>,
): Array<{ status: string; scheduledDate: Date }> {
  return spec.map(([status, scheduledDate]) => ({ status, scheduledDate }));
}

describe('countTasks', () => {
  it('separates work scheduled ahead from work that is genuinely overdue', () => {
    const counts = countTasks(
      tasks([
        ['PENDING', future(3)],
        ['PENDING', future(1)],
        ['PENDING', past(2)], // due and not run — a real fault
        ['GENERATED', past(1)],
        ['APPROVED', past(4)],
        ['FAILED', past(5)],
      ]),
      NOW,
    );

    expect(counts.total).toBe(6);
    expect(counts.scheduled).toBe(2);
    expect(counts.overdue).toBe(1);
    expect(counts.awaitingReview).toBe(1);
    expect(counts.failed).toBe(1);
    // GENERATED + APPROVED: both have run, whatever happens next.
    expect(counts.done).toBe(2);
  });

  it('handles a campaign with no tasks without dividing by zero', () => {
    const counts = countTasks([], NOW);
    expect(counts).toMatchObject({ total: 0, done: 0, overdue: 0 });
  });

  it('accepts ISO strings as well as Dates', () => {
    const counts = countTasks(
      [{ status: 'PENDING', scheduledDate: future(2).toISOString() }],
      NOW,
    );
    expect(counts.scheduled).toBe(1);
  });
});

describe('deriveCampaignState', () => {
  /**
   * The headline fix. A campaign whose work is all finished used to stay
   * ACTIVE forever, indistinguishable from one started this morning.
   */
  it('reports a campaign with all work run as finished, not running', () => {
    const state = deriveCampaignState(
      'ACTIVE',
      countTasks(
        tasks([
          ['APPROVED', past(5)],
          ['APPROVED', past(3)],
          ['SKIPPED', past(1)],
        ]),
        NOW,
      ),
    );
    expect(state.key).toBe('FINISHED');
    expect(state.label).toBe('Finished');
    expect(state.action).toBeNull();
    expect(state.needsAttention).toBe(false);
  });

  it('honours an explicitly stored COMPLETED', () => {
    const state = deriveCampaignState('COMPLETED', countTasks([], NOW));
    expect(state.key).toBe('FINISHED');
  });

  it('surfaces items waiting on approval as the required action', () => {
    const state = deriveCampaignState(
      'ACTIVE',
      countTasks(
        tasks([
          ['GENERATED', past(1)],
          ['GENERATED', past(2)],
          ['PENDING', future(3)],
        ]),
        NOW,
      ),
    );
    expect(state.key).toBe('NEEDS_REVIEW');
    expect(state.needsAttention).toBe(true);
    expect(state.action).toContain('2 items');
  });

  /**
   * Overdue work means the daily job has not run, which is a fault rather
   * than normal progress — it must not be dressed up as "Running".
   */
  it('flags overdue work as behind rather than running', () => {
    const state = deriveCampaignState(
      'ACTIVE',
      countTasks(
        tasks([
          ['PENDING', past(3)],
          ['PENDING', future(2)],
        ]),
        NOW,
      ),
    );
    expect(state.key).toBe('BEHIND');
    expect(state.needsAttention).toBe(true);
    expect(state.action).toBeTruthy();
  });

  it('prefers review over behind, because review is what the user can act on', () => {
    const state = deriveCampaignState(
      'ACTIVE',
      countTasks(
        tasks([
          ['GENERATED', past(1)],
          ['PENDING', past(3)],
        ]),
        NOW,
      ),
    );
    expect(state.key).toBe('NEEDS_REVIEW');
  });

  /**
   * A healthy campaign must be allowed to ask for nothing. Inventing a call to
   * action here trains people to ignore the ones that matter.
   */
  it('asks for nothing when a campaign is simply on schedule', () => {
    const state = deriveCampaignState(
      'ACTIVE',
      countTasks(
        tasks([
          ['APPROVED', past(2)],
          ['PENDING', future(1)],
          ['PENDING', future(4)],
        ]),
        NOW,
      ),
    );
    expect(state.key).toBe('RUNNING');
    expect(state.action).toBeNull();
    expect(state.needsAttention).toBe(false);
  });

  it('stays paused even when drafts are waiting', () => {
    const state = deriveCampaignState(
      'PAUSED',
      countTasks(
        tasks([
          ['GENERATED', past(1)],
          ['PENDING', future(2)],
        ]),
        NOW,
      ),
    );
    expect(state.key).toBe('PAUSED');
    expect(state.summary).toMatch(/resume/i);
  });

  it('describes an archived campaign as inert', () => {
    const state = deriveCampaignState('ARCHIVED', countTasks([], NOW));
    expect(state.key).toBe('ARCHIVED');
    expect(state.needsAttention).toBe(false);
  });

  it('gives DRAFT a meaning instead of a bare enum word', () => {
    const state = deriveCampaignState('DRAFT', countTasks([], NOW));
    expect(state.key).toBe('NOT_STARTED');
    expect(state.label).toBe('Not started');
    expect(state.action).toBeTruthy();
  });

  /** No state may reach the screen as a raw enum or an empty string. */
  it('never renders a database word or an empty label', () => {
    const shapes = [
      countTasks([], NOW),
      countTasks(tasks([['PENDING', future(1)]]), NOW),
      countTasks(tasks([['GENERATED', past(1)]]), NOW),
      countTasks(tasks([['APPROVED', past(1)]]), NOW),
      countTasks(tasks([['FAILED', past(1)]]), NOW),
    ];
    for (const status of ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED']) {
      for (const counts of shapes) {
        const state = deriveCampaignState(status, counts);
        expect(state.label.length, `${status} label`).toBeGreaterThan(0);
        expect(state.label).not.toMatch(/^[A-Z_]+$/);
        expect(state.label).not.toMatch(/^(None|Unknown|undefined|null)$/i);
        expect(state.summary.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('taskState', () => {
  /**
   * "GENERATED" described what the system did and reads as finished, when it
   * means the opposite — it is sitting there waiting for a person.
   */
  it('renames GENERATED to the action it actually requires', () => {
    const state = taskState('GENERATED', past(1), NOW);
    expect(state.label).toBe('Needs review');
    expect(state.tone).toBe('warning');
  });

  it('splits PENDING into scheduled and due', () => {
    expect(taskState('PENDING', future(2), NOW).label).toBe('Scheduled');
    expect(taskState('PENDING', past(2), NOW).label).toBe('Due');
  });

  it('says a failed task will not retry itself', () => {
    const state = taskState('FAILED', past(1), NOW);
    expect(state.tone).toBe('destructive');
    expect(state.hint).toMatch(/not retry/i);
  });

  it('never emits a raw enum for any known status', () => {
    for (const status of ['PENDING', 'GENERATED', 'APPROVED', 'SKIPPED', 'FAILED']) {
      const state = taskState(status, past(1), NOW);
      expect(state.label).not.toMatch(/^[A-Z_]+$/);
      expect(state.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('taskTypeLabel', () => {
  /**
   * The detail page carried a DRAFT_OUTREACH key while the enum value is
   * RUN_OUTREACH_BATCH, so outreach tasks fell through to the raw enum in the
   * summary line and in "Next up". One shared map removes the class of bug.
   */
  it('labels every task type the executor can create', () => {
    for (const type of [
      'GENERATE_CONTENT',
      'RUN_OUTREACH_BATCH',
      'RUN_DISCOVERY',
      'REVIEW_CHECKPOINT',
    ]) {
      expect(TASK_TYPE_LABEL[type], `${type} has no label`).toBeTruthy();
      expect(taskTypeLabel(type)).not.toMatch(/^[A-Z_]+$/);
    }
  });

  it('falls back to the raw value rather than rendering nothing', () => {
    expect(taskTypeLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
