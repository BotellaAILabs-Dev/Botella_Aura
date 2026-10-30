import { describe, expect, it } from 'vitest';

import { describeSlots, nextSlot } from '@/lib/website-schedule';

/** Recurring auto-publish slots, computed in the workspace's own timezone. */
describe('nextSlot', () => {
  it('finds the next chosen weekday at the wall-clock time', () => {
    // Thu 29 Oct 2026, 12:00 UTC. Slots: Mon + Thu at 09:00 UTC.
    const after = new Date('2026-10-29T12:00:00Z');
    expect(nextSlot(after, [1, 4], '09:00', 'UTC')?.toISOString()).toBe('2026-11-02T09:00:00.000Z');
  });

  it('uses today when the time has not passed yet', () => {
    expect(nextSlot(new Date('2026-10-29T08:00:00Z'), [4], '09:00', 'UTC')?.toISOString()).toBe('2026-10-29T09:00:00.000Z');
  });

  it('is strictly after: a slot that just ran moves to the next one', () => {
    expect(nextSlot(new Date('2026-10-29T09:00:00Z'), [4], '09:00', 'UTC')?.toISOString()).toBe('2026-11-05T09:00:00.000Z');
  });

  it('keeps 09:00 local across a daylight-saving change', () => {
    // London leaves summer time on Sun 25 Oct 2026: 09:00 is 08:00 UTC before, 09:00 UTC after.
    const before = nextSlot(new Date('2026-10-19T00:00:00Z'), [2], '09:00', 'Europe/London');
    const after = nextSlot(new Date('2026-10-26T00:00:00Z'), [2], '09:00', 'Europe/London');
    expect(before?.toISOString()).toBe('2026-10-20T08:00:00.000Z');
    expect(after?.toISOString()).toBe('2026-10-27T09:00:00.000Z');
  });

  it('interprets the time in the workspace zone, not UTC', () => {
    // 09:00 in Kolkata (UTC+5:30) is 03:30 UTC.
    expect(nextSlot(new Date('2026-10-29T00:00:00Z'), [4], '09:00', 'Asia/Kolkata')?.toISOString()).toBe('2026-10-29T03:30:00.000Z');
  });

  it('returns null with no days or a bad time', () => {
    expect(nextSlot(new Date(), [], '09:00', 'UTC')).toBeNull();
    expect(nextSlot(new Date(), [1], '25:00', 'UTC')).toBeNull();
  });
});

describe('describeSlots', () => {
  it('reads naturally', () => {
    expect(describeSlots([1, 2, 3, 4, 5], '09:00')).toBe('Weekdays at 09:00');
    expect(describeSlots([3, 1], '18:30')).toBe('Mon, Wed at 18:30');
    expect(describeSlots([1, 2, 3, 4, 5, 6, 7], '07:00')).toBe('Every day at 07:00');
  });
});
