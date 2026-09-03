import { describe, it, expect } from 'vitest';

import { learnTiming } from '@/server/publishing/schedule.service';
import {
  readAutopilotSettings,
  PUBLISH_MODES,
  MAX_AUTO_PUBLISH_PER_WEEK,
} from '@/server/briefing/autopilot.service';
import type { ContentPerf } from '@/server/memory/performance.service';

/**
 * Two capabilities, one rule holding both together: Aura may recommend and it
 * may act, but it must never overstate what it knows, and it must never
 * publish unless it was explicitly told it could.
 */

function post(publishedAt: string, engagement: number): ContentPerf {
  return {
    draftId: Math.random().toString(36).slice(2),
    title: 't',
    type: 'LINKEDIN_POST',
    snippet: 's',
    publishedAt,
    wordCount: 100,
    engagement,
    metrics: {},
  };
}

/** N posts on the same weekday/hour, at a given engagement level. */
function weekly(isoDate: string, weeks: number, engagement: number): ContentPerf[] {
  const out: ContentPerf[] = [];
  const start = new Date(isoDate);
  for (let i = 0; i < weeks; i += 1) {
    const d = new Date(start.getTime() + i * 7 * 86_400_000);
    out.push(post(d.toISOString(), engagement));
  }
  return out;
}

describe('learnTiming', () => {
  it('says nothing on a thin sample', () => {
    // The failure to avoid is dressing up three data points as a finding.
    expect(learnTiming([])).toBeNull();
    expect(learnTiming(weekly('2026-01-06T09:00:00Z', 3, 100))).toBeNull();
  });

  it('says nothing when no day is actually better', () => {
    // Every day identical: there is a "best" day arithmetically, and reporting
    // it would be noise presented as insight.
    const flat = [
      ...weekly('2026-01-06T09:00:00Z', 5, 100), // Tuesdays
      ...weekly('2026-01-08T09:00:00Z', 5, 100), // Thursdays
    ];
    expect(learnTiming(flat)).toBeNull();
  });

  it('finds a genuinely better day', () => {
    const mixed = [
      ...weekly('2026-01-06T09:00:00Z', 5, 300), // Tuesdays, strong
      ...weekly('2026-01-08T09:00:00Z', 5, 40), // Thursdays, weak
    ];
    const learned = learnTiming(mixed);
    expect(learned?.weekday).toBe(2); // Tuesday
    expect(learned?.count).toBe(5);
  });

  it('ignores a day with too few posts to mean anything', () => {
    // One spectacular Saturday must not become "post on Saturdays".
    const mixed = [
      ...weekly('2026-01-06T09:00:00Z', 6, 100), // Tuesdays
      post('2026-01-10T09:00:00Z', 5000), // one Saturday
      post('2026-01-13T09:00:00Z', 100),
    ];
    expect(learnTiming(mixed)?.weekday).not.toBe(6);
  });

  it('uses the median hour, so one 3am post cannot move the slot', () => {
    const posts = [
      post('2026-01-06T09:00:00Z', 300),
      post('2026-01-13T09:00:00Z', 300),
      post('2026-01-20T09:00:00Z', 300),
      post('2026-01-27T03:00:00Z', 300),
      ...weekly('2026-01-08T09:00:00Z', 4, 30),
    ];
    expect(learnTiming(posts)?.hour).toBe(9);
  });

  it('ignores posts that were never published', () => {
    const drafts = weekly('2026-01-06T09:00:00Z', 10, 300).map((p) => ({
      ...p,
      publishedAt: null,
    }));
    expect(learnTiming(drafts)).toBeNull();
  });
});

describe('autopilot publishing authority', () => {
  // Deliberately loose: these tests exist to pin down what happens when the
  // stored value is NOT a valid mode, which the Prisma types rule out.
  const withPrefs = (autopilot: unknown) =>
    ({ preferences: { autopilot } }) as unknown as { preferences: never };

  it('defaults to reviewing, never publishing', () => {
    // The default for a setting that can act in public has to be the one that
    // cannot. Every workspace that has never opened this page gets 'review'.
    expect(readAutopilotSettings({ preferences: {} }).publishMode).toBe('review');
    expect(readAutopilotSettings({ preferences: null as never }).publishMode).toBe('review');
  });

  it('falls back to reviewing when the stored value is unrecognised', () => {
    // A value written by an older build, or edited by hand, must fail closed.
    for (const bad of ['publish', 'AUTO', '', 42, null, {}, true]) {
      expect(readAutopilotSettings(withPrefs({ publishMode: bad })).publishMode).toBe('review');
    }
  });

  it('honours each real mode', () => {
    for (const mode of PUBLISH_MODES) {
      expect(readAutopilotSettings(withPrefs({ publishMode: mode })).publishMode).toBe(mode);
    }
  });

  it('caps how much can go out unattended', () => {
    // A runaway config must not be able to publish a hundred posts.
    expect(MAX_AUTO_PUBLISH_PER_WEEK).toBeLessThanOrEqual(5);
    expect(MAX_AUTO_PUBLISH_PER_WEEK).toBeGreaterThan(0);
  });

  it('keeps the other settings independent of the publish mode', () => {
    // Turning on auto-publish must not quietly change how much gets written.
    const settings = readAutopilotSettings(
      withPrefs({ publishMode: 'auto', postsPerWeek: 2, generateGraphics: false }),
    );
    expect(settings.postsPerWeek).toBe(2);
    expect(settings.generateGraphics).toBe(false);
    expect(settings.publishMode).toBe('auto');
  });

  it('still clamps posts per week', () => {
    expect(readAutopilotSettings(withPrefs({ postsPerWeek: 99 })).postsPerWeek).toBe(5);
    expect(readAutopilotSettings(withPrefs({ postsPerWeek: -3 })).postsPerWeek).toBe(0);
  });
});
