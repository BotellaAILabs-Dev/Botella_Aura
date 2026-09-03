import { describe, it, expect, vi } from 'vitest';

// autopilot.service reaches the database on its main path. These tests cover
// the pure settings logic and the payload contract, so the client is stubbed to
// keep the modules importable without a database.
vi.mock('@/lib/db', () => ({ db: {} }));

import { readAutopilotSettings } from '@/server/briefing/autopilot.service';
import {
  briefingPayloadSchema,
  readBriefingPayload,
  readBriefingActivity,
} from '@/lib/validations/briefing';

/**
 * The autonomous agent.
 *
 * Two things get the most attention here, because both are about money and
 * trust: the settings that decide whether Aura spends anything at all, and the
 * payload contract that a home page renders from — a briefing written by an
 * older build must never crash the page someone opens on Monday.
 */

describe('autopilot settings', () => {
  it('defaults to on, so an autonomous agent needs no configuration', () => {
    const s = readAutopilotSettings({ preferences: {} });
    expect(s.enabled).toBe(true);
    expect(s.generateGraphics).toBe(true);
    expect(s.postsPerWeek).toBeGreaterThan(0);
  });

  it('respects an explicit off switch', () => {
    // Autonomous spending with no way to stop it is not a feature.
    const s = readAutopilotSettings({
      preferences: { autopilot: { enabled: false } },
    });
    expect(s.enabled).toBe(false);
  });

  it('treats only an explicit false as off', () => {
    // A partially-written preferences bag must not silently disable the agent.
    expect(readAutopilotSettings({ preferences: { autopilot: {} } }).enabled).toBe(true);
    expect(
      readAutopilotSettings({ preferences: { autopilot: { enabled: 'no' } } }).enabled,
    ).toBe(true);
  });

  it('can disable graphics while keeping writing', () => {
    const s = readAutopilotSettings({
      preferences: { autopilot: { generateGraphics: false } },
    });
    expect(s.enabled).toBe(true);
    expect(s.generateGraphics).toBe(false);
  });

  it('caps a runaway posts-per-week value', () => {
    // A bad config must not be able to spend an entire allowance in one night.
    expect(
      readAutopilotSettings({ preferences: { autopilot: { postsPerWeek: 999 } } })
        .postsPerWeek,
    ).toBeLessThanOrEqual(5);
  });

  it('allows zero posts per week', () => {
    expect(
      readAutopilotSettings({ preferences: { autopilot: { postsPerWeek: 0 } } })
        .postsPerWeek,
    ).toBe(0);
  });

  it('ignores nonsense rather than throwing', () => {
    for (const preferences of [
      {},
      { autopilot: null },
      { autopilot: 'yes' },
      { autopilot: { postsPerWeek: 'three' } },
    ]) {
      expect(() => readAutopilotSettings({ preferences })).not.toThrow();
    }
    expect(
      readAutopilotSettings({ preferences: { autopilot: { postsPerWeek: NaN } } })
        .postsPerWeek,
    ).toBeGreaterThan(0);
  });
});

describe('briefing payload contract', () => {
  it('accepts a fully empty briefing', () => {
    // A brand-new workspace has nothing to report, and that must render.
    const payload = briefingPayloadSchema.parse({});
    expect(payload.calendar).toEqual([]);
    expect(payload.coverage.skipped).toEqual([]);
  });

  it('survives a payload written by an older build', () => {
    // The home page renders from stored snapshots. A briefing that predates a
    // field must not take the page down.
    const payload = readBriefingPayload({ headline: 'old', summary: 'older shape' });
    expect(payload.headline).toBe('old');
    expect(payload.readyContent).toEqual([]);
  });

  it('never throws on garbage', () => {
    for (const raw of [null, undefined, 'nonsense', 42, []]) {
      expect(() => readBriefingPayload(raw)).not.toThrow();
      expect(readBriefingPayload(raw).calendar).toEqual([]);
    }
  });

  it('keeps the coverage record, which is the honesty mechanism', () => {
    // Without this, "no competitors tracked" and "competitor tracking failed"
    // look identical to the user.
    const payload = briefingPayloadSchema.parse({
      coverage: {
        used: ['calendar'],
        skipped: [{ source: 'competitors', reason: 'No competitors tracked yet.' }],
      },
    });
    expect(payload.coverage.skipped[0]?.reason).toMatch(/no competitors/i);
  });

  it('defaults calendar items to PLANNED with no draft', () => {
    const payload = briefingPayloadSchema.parse({
      calendar: [
        {
          date: '2026-09-07',
          contentType: 'LINKEDIN_POST',
          platform: 'LINKEDIN',
          title: 'A post',
        },
      ],
    });
    expect(payload.calendar[0]?.status).toBe('PLANNED');
    expect(payload.calendar[0]?.draftId).toBeNull();
    expect(payload.calendar[0]?.hasGraphic).toBe(false);
  });

  it('rejects a content type or platform it does not know', () => {
    expect(
      briefingPayloadSchema.safeParse({
        calendar: [
          {
            date: '2026-09-07',
            contentType: 'TIKTOK_DANCE',
            platform: 'LINKEDIN',
            title: 'x',
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('briefing activity', () => {
  it('defaults to a clean zeroed log', () => {
    const activity = readBriefingActivity({});
    expect(activity.draftsWritten).toBe(0);
    expect(activity.graphicsGenerated).toBe(0);
    expect(activity.skipped).toEqual([]);
  });

  it('preserves what the agent skipped, so the UI can explain itself', () => {
    const activity = readBriefingActivity({
      draftsWritten: 3,
      graphicsGenerated: 1,
      skipped: ['Only 1 graphic left in this month’s allowance.'],
    });
    expect(activity.draftsWritten).toBe(3);
    expect(activity.skipped).toHaveLength(1);
  });

  it('never throws on a malformed log', () => {
    expect(() => readBriefingActivity('broken')).not.toThrow();
    expect(readBriefingActivity('broken').draftsWritten).toBe(0);
  });
});
