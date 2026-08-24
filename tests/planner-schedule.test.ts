import { describe, expect, it } from 'vitest';

import { buildSchedule } from '@/server/planner/plan.service';

/**
 * The calendar's dates are computed here, not by the model. If this drifts, a
 * "monthly plan" silently becomes a topic list with made-up dates.
 */
describe('buildSchedule', () => {
  it('only schedules weekdays', () => {
    const slots = buildSchedule('2026-09', 5);
    for (const slot of slots) {
      const day = new Date(`${slot.date}T00:00:00Z`).getUTCDay();
      expect(day).not.toBe(0); // Sunday
      expect(day).not.toBe(6); // Saturday
    }
  });

  it('respects the requested cadence per week', () => {
    const slots = buildSchedule('2026-09', 3);
    const byWeek = new Map<number, number>();
    for (const s of slots) byWeek.set(s.week, (byWeek.get(s.week) ?? 0) + 1);
    for (const count of byWeek.values()) {
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it('never schedules two pieces on the same date', () => {
    const slots = buildSchedule('2026-09', 5);
    expect(new Set(slots.map((s) => s.date)).size).toBe(slots.length);
  });

  it('keeps every date inside the requested month', () => {
    const slots = buildSchedule('2026-02', 4);
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(s.date.startsWith('2026-02')).toBe(true);
  });

  it('caps at the weekdays actually available in a short week', () => {
    // Asking for 14 a week cannot produce more than 5 weekdays in a week.
    const slots = buildSchedule('2026-09', 14);
    const byWeek = new Map<number, number>();
    for (const s of slots) byWeek.set(s.week, (byWeek.get(s.week) ?? 0) + 1);
    for (const count of byWeek.values()) expect(count).toBeLessThanOrEqual(5);
  });

  it('is deterministic', () => {
    expect(buildSchedule('2026-11', 3)).toEqual(buildSchedule('2026-11', 3));
  });
});
