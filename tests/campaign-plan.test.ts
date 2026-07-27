import { describe, it, expect } from 'vitest';
import {
  campaignPlanSchema,
  createCampaignSchema,
} from '@/lib/validations/campaign';
import { deterministicPlan } from '@/server/campaigns/planner';

describe('campaign plan schema', () => {
  const good = {
    overview: 'Drive awareness over 14 days.',
    days: [
      { day: 1, contentType: 'LINKEDIN_POST', topic: 'Launch', outreach: false, discovery: false },
      { day: 3, contentType: null, outreach: true, discovery: false },
    ],
  };

  it('accepts a valid plan and applies day defaults', () => {
    const parsed = campaignPlanSchema.parse(good);
    expect(parsed.days[0]!.day).toBe(1);
    expect(parsed.days[1]!.contentType).toBeNull();
  });

  it('rejects a plan with no days or no overview', () => {
    expect(campaignPlanSchema.safeParse({ overview: 'x', days: [] }).success).toBe(false);
    expect(campaignPlanSchema.safeParse({ days: good.days }).success).toBe(false);
  });

  it('rejects an out-of-range day and a bad content type', () => {
    expect(
      campaignPlanSchema.safeParse({ overview: 'x', days: [{ day: 99, outreach: false, discovery: false }] }).success,
    ).toBe(false);
    expect(
      campaignPlanSchema.safeParse({
        overview: 'x',
        days: [{ day: 1, contentType: 'INSTAGRAM_REEL' }],
      }).success,
    ).toBe(false);
  });
});

describe('createCampaignSchema', () => {
  it('defaults duration to 30 and requires a goal', () => {
    const parsed = createCampaignSchema.parse({
      name: 'Launch',
      goal: 'Grow awareness',
      modules: { content: true, outreach: false, discovery: false, engagement: false },
    });
    expect(parsed.durationDays).toBe(30);
    expect(createCampaignSchema.safeParse({ name: 'x', goal: '', modules: {} }).success).toBe(false);
  });
});

describe('deterministic plan (fallback) respects module gating', () => {
  const base = {
    name: 'C',
    goal: 'Grow',
    durationDays: 14,
    targetAudience: '',
    themes: ['reliability'],
  };

  it('content-only plan schedules content but no outreach/discovery', () => {
    const plan = deterministicPlan({
      ...base,
      modules: { content: true, outreach: false, discovery: false, engagement: false },
    });
    expect(campaignPlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.days.some((d) => d.contentType)).toBe(true);
    expect(plan.days.some((d) => d.outreach)).toBe(false);
    expect(plan.days.some((d) => d.discovery)).toBe(false);
  });

  it('outreach-enabled plan schedules outreach batches', () => {
    const plan = deterministicPlan({
      ...base,
      modules: { content: false, outreach: true, discovery: false, engagement: false },
    });
    expect(plan.days.some((d) => d.outreach)).toBe(true);
    expect(plan.days.some((d) => d.contentType)).toBe(false);
  });
});
