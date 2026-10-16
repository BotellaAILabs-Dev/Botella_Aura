import { describe, it, expect } from 'vitest';

import {
  campaignCreationHandoff,
  creationContextPrompt,
  outreachCreationHandoff,
  readCreationContext,
  type CampaignRequirements,
  type OutreachRequirements,
} from '@/lib/creation-handoff';
import {
  CONTEXTUAL_EXECUTION_ENABLED,
  executionGate,
  hasCreationContext,
} from '@/lib/execution-gate';
import { creationPlan, type CreatableRecommendation } from '@/lib/recommendation-creation';
import { buildContextHandoff, type HandoffInput } from '@/lib/recommendation-context-handoff';
import { AURA_MODULES, CREATION_KIND } from '@/lib/aura-modules';
import { createCampaignSchema } from '@/lib/validations/campaign';

/**
 * Campaign & Outreach creation handoffs: which recommendations can start
 * them, what is mapped (recommendation context, audience, goal, CTA, channel,
 * content requirements), that nothing is invented, and that execution of
 * what they create is held until Sprint 10.
 */

const NOW = new Date('2026-10-16T12:00:00Z');

function rec(over: Partial<CreatableRecommendation> & { engineAction?: string } = {}): CreatableRecommendation {
  const { engineAction = 'series', ...rest } = over;
  return {
    id: 'rec1',
    type: 'CAMPAIGN',
    title: 'Run a four-week tasting series',
    action: 'Plan a series of posts and invitations around weekly tastings.',
    steps: ['Announce the series', 'One spirit a week', 'Invite regulars'],
    rationale: 'Tasting posts drove bookings last quarter.',
    expectedOutcome: 'More tasting-event bookings.',
    channel: 'LinkedIn',
    contentType: 'LINKEDIN_POST',
    audience: 'Spirits enthusiasts in the city',
    details: { action: engineAction },
    status: 'ACCEPTED',
    blockers: [],
    ...rest,
  };
}

function handoff(r: Partial<HandoffInput['recommendation']> = {}, b: Partial<HandoffInput['business']> = {}) {
  return buildContextHandoff({
    recommendation: {
      id: 'rec1',
      opportunityId: 'opp1',
      status: 'ACCEPTED',
      type: 'CAMPAIGN',
      title: 'Run a four-week tasting series',
      action: 'Plan a series of posts and invitations around weekly tastings.',
      steps: ['Announce the series', 'One spirit a week', 'Invite regulars'],
      rationale: 'Tasting posts drove bookings last quarter. Based on 1 piece of evidence: tasting posts.',
      expectedOutcome: 'More tasting-event bookings.',
      outcomeMetric: 'bookings',
      channel: 'LinkedIn',
      contentType: 'LINKEDIN_POST',
      audience: 'Spirits enthusiasts in the city',
      details: { action: 'series', angle: 'Taste before you buy' },
      confidence: 'HIGH',
      confidenceReason: 'Three quarters of results',
      executable: true,
      blockers: [],
      evidence: [
        { label: 'Tasting posts doubled bookings', detail: 'Q3.', url: 'https://botella.example/results', observedAt: new Date('2026-09-30T00:00:00Z') },
      ],
      ...r,
    },
    business: {
      name: 'Botella',
      description: 'A neighbourhood bottle shop with a curated spirits list.',
      offerings: null,
      industry: 'Retail',
      website: 'https://botella.example',
      goals: 'Grow tasting-event bookings',
      audience: 'Spirits enthusiasts in the city',
      campaigns: [],
      connected: ['LinkedIn'],
      voice: null,
      memory: [],
      ...b,
    },
    now: NOW,
  });
}

describe('which recommendations can start Campaign or Outreach creation', () => {
  it('Outreach is now a creation workflow with its own entry page', () => {
    expect(CREATION_KIND.outreach).toBe('workflow');
    expect(AURA_MODULES.outreach).toMatchObject({ handoff: 'prefill', creates: 'outreach drafts', entryRoute: '/dashboard/outreach/new' });
  });

  it('a campaign can be planned from a series (primary) — and from any creating suggestion', () => {
    expect(creationPlan(rec())).toMatchObject({ module: 'campaigns', state: 'ready', canCreate: true, creates: 'a campaign plan' });
    expect(creationPlan(rec({ engineAction: 'post', type: 'CONTENT' }), { module: 'campaigns' }).canCreate).toBe(true);
  });

  it('outreach only for suggestions aimed at people (targeted-post, AUDIENCE)', () => {
    const targeted = creationPlan(rec({ engineAction: 'targeted-post', type: 'AUDIENCE' }), { module: 'outreach' });
    expect(targeted).toMatchObject({ module: 'outreach', state: 'ready', canCreate: true, creates: 'outreach drafts' });
    expect(targeted.href).toBe('/dashboard/outreach/new?rec=rec1');
    const byType = creationPlan(rec({ type: 'AUDIENCE', details: {} }), { module: 'outreach' });
    expect(byType.canCreate).toBe(true);
  });

  it('a plain post or a series is not eligible for outreach — said plainly, with where it IS done', () => {
    const post = creationPlan(rec({ engineAction: 'post', type: 'CONTENT' }), { module: 'outreach' });
    expect(post).toMatchObject({ state: 'not_creatable', canCreate: false });
    expect(post.message).toMatch(/isn’t aimed at particular people/);
    expect(post.fix?.label).toBe('Create content');
    expect(creationPlan(rec(), { module: 'outreach' }).canCreate).toBe(false);
  });

  it('the usual states still apply: open → says yes on creating; closed → nothing', () => {
    expect(creationPlan(rec({ engineAction: 'targeted-post', status: 'PRESENTED' }), { module: 'outreach' })).toMatchObject({
      state: 'accept_first',
      acceptsOnCreate: true,
    });
    expect(creationPlan(rec({ status: 'REJECTED' }), { module: 'campaigns' }).state).toBe('closed');
  });
});

describe('Campaign creation handoff', () => {
  const h = handoff();
  const out = campaignCreationHandoff(h, { now: NOW });

  it('prefills the campaign form — and the form accepts it as-is', () => {
    expect(out.prefill).toMatchObject({
      name: 'Run a four-week tasting series',
      goal: 'Grow tasting-event bookings — More tasting-event bookings.',
      targetAudience: 'Spirits enthusiasts in the city',
      themes: ['Taste before you buy', 'Run a four-week tasting series'],
      durationDays: 30,
    });
    expect(createCampaignSchema.safeParse({ ...out.prefill, recommendationId: 'rec1' }).success).toBe(true);
  });

  it('maps the recommendation context (provenance), audience and goal, with where each came from', () => {
    const c = out.context;
    expect(c).toMatchObject({ version: 1, target: 'campaigns', executionGate: 'sprint-10', createdAt: NOW.toISOString() });
    expect(c.recommendation).toMatchObject({ recommendationId: 'rec1', opportunityId: 'opp1', title: 'Run a four-week tasting series', confidence: 'HIGH' });
    expect(c.recommendation.evidence).toEqual([{ label: 'Tasting posts doubled bookings', url: 'https://botella.example/results' }]);
    expect(c.audience?.value).toBe('Spirits enthusiasts in the city');
    expect(c.goal).toMatchObject({ value: 'Grow tasting-event bookings' });
    expect(c.outcome).toEqual({ outcome: 'More tasting-event bookings.', metric: 'bookings' });
  });

  it('maps CTA (destination: the business’s own site, never invented) and channel', () => {
    expect(out.context.cta.destination?.value).toBe('https://botella.example');
    expect(out.context.cta.guidance).toBeTruthy();
    expect(out.context.channel).toMatchObject({ channel: 'LinkedIn', contentType: 'LINKEDIN_POST', platform: 'LINKEDIN' });
  });

  it('maps content requirements: formats, key message, angle, steps, evidence-only claims', () => {
    const r = out.context.requirements as CampaignRequirements;
    expect(r).toMatchObject({
      contentTypes: ['LINKEDIN_POST'],
      platform: 'LINKEDIN',
      keyMessage: 'Run a four-week tasting series',
      angle: 'Taste before you buy',
      steps: ['Announce the series', 'One spirit a week', 'Invite regulars'],
      evidence: ['Tasting posts doubled bookings'],
    });
  });

  it('modules follow where the suggestion is carried out: audience-led adds outreach and discovery', () => {
    expect(campaignCreationHandoff(h, { now: NOW }).prefill.modules).toEqual({ content: true, outreach: false, discovery: false, engagement: false });
    expect(campaignCreationHandoff(h, { related: ['lead-discovery', 'outreach'], now: NOW }).prefill.modules).toMatchObject({ outreach: true, discovery: true });
  });

  it('nothing is invented: a missing website means no CTA link; missing goal/audience are listed as gaps', () => {
    const bare = campaignCreationHandoff(handoff({ audience: null }, { website: null, goals: null, audience: null }), { now: NOW });
    expect(bare.context.cta.destination).toBeNull();
    expect(bare.context.goal).toBeNull();
    expect(bare.context.audience).toBeNull();
    expect(bare.prefill.targetAudience).toBe('');
    expect(bare.context.gaps.map((g) => g.field)).toEqual(expect.arrayContaining(['goal', 'audience', 'cta']));
    expect(creationContextPrompt(bare.context)).toMatch(/Never invent a URL/);
  });
});

describe('Outreach creation handoff', () => {
  const out = outreachCreationHandoff(handoff({ type: 'AUDIENCE', details: { action: 'targeted-post', angle: 'Small-batch rye' } }), { now: NOW });

  it('always LinkedIn: a connection note (≤300) then a follow-up, personal to each lead', () => {
    const r = out.context.requirements as OutreachRequirements;
    expect(out.context.target).toBe('outreach');
    expect(out.context.channel).toEqual({ channel: 'LinkedIn', contentType: null, platform: 'LINKEDIN', publishing: 'manual' });
    expect(r).toMatchObject({ channel: 'LinkedIn', messageTypes: ['CONNECTION_NOTE', 'FOLLOWUP'], connectionNoteLimit: 300, angle: 'Small-batch rye' });
    expect(r.personalisation).toMatch(/lead’s own recent signal/);
  });

  it('CTA is soft, with no link in the connection note; a URL only if the business has one', () => {
    expect(out.context.cta.expected).toBe(true);
    expect(out.context.cta.guidance).toMatch(/never a hard sell/);
    expect(out.context.cta.guidance).toMatch(/connection note carries no link/);
    expect(out.context.cta.destination?.value).toBe('https://botella.example');
    const noSite = outreachCreationHandoff(handoff({}, { website: null }), { now: NOW });
    expect(noSite.context.cta.destination).toBeNull();
    expect(noSite.context.cta.guidance).toMatch(/no URL/);
  });

  it('prefill: audience, angle, key message, goal', () => {
    expect(out.prefill).toEqual({
      audience: 'Spirits enthusiasts in the city',
      angle: 'Small-batch rye',
      keyMessage: 'Run a four-week tasting series',
      goal: 'Grow tasting-event bookings',
    });
  });
});

describe('the stored context and the drafter/planner prompt', () => {
  const ctx = campaignCreationHandoff(handoff(), { now: NOW }).context;

  it('round-trips through storage; anything else is not a creation context', () => {
    expect(readCreationContext(JSON.parse(JSON.stringify(ctx)))).toEqual(ctx);
    expect(readCreationContext(null)).toBeNull();
    expect(readCreationContext({ version: 2, target: 'campaigns', recommendation: {} })).toBeNull();
    expect(readCreationContext({ version: 1, target: 'content-studio', recommendation: {} })).toBeNull();
  });

  it('the prompt carries the reason, evidence, outcome, CTA, channel and requirements', () => {
    const p = creationContextPrompt(ctx);
    expect(p).toMatch(/WRITTEN FOR AURA'S SUGGESTION: "Run a four-week tasting series"/);
    expect(p).toMatch(/Tasting posts doubled bookings/);
    expect(p).toMatch(/Measured by: bookings/);
    expect(p).toMatch(/Destination: https:\/\/botella\.example/);
    expect(p).toMatch(/Channel: LinkedIn \(LINKEDIN_POST\)/);
    expect(p).toMatch(/Key message: Run a four-week tasting series — angle: Taste before you buy/);
    expect(p).toMatch(/Shape: Announce the series · One spirit a week · Invite regulars/);
  });
});

describe('execution stays blocked until Sprint 10', () => {
  it('the switch is off', () => {
    expect(CONTEXTUAL_EXECUTION_ENABLED).toBe(false);
  });

  it('work created through a handoff is blocked, with a plain reason; other work is not affected', () => {
    expect(executionGate('campaign', true)).toMatchObject({ blocked: true, message: expect.stringMatching(/arrives with execution/) });
    expect(executionGate('outreach', true)).toMatchObject({ blocked: true, message: expect.stringMatching(/nothing is sent until then/) });
    expect(executionGate('campaign', false)).toEqual({ blocked: false, message: null });
    expect(executionGate('outreach', false)).toEqual({ blocked: false, message: null });
  });

  it('a stored creation context is what marks an item as made through a handoff', () => {
    expect(hasCreationContext({ creationContext: { version: 1 } })).toBe(true);
    expect(hasCreationContext({ recommendation: { id: 'r' } })).toBe(false);
    expect(hasCreationContext(null)).toBe(false);
  });
});
