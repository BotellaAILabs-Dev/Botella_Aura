import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The Campaign & Outreach creation handoffs on the server: context is kept on
 * what is created and reaches the planner/drafter, approval stays the normal
 * flow, and EXECUTION is blocked — the campaign is saved as a plan the
 * executor never runs and that cannot be started; outreach drafted from a
 * suggestion never enters the send queue and cannot be marked sent. Work
 * created any other way behaves exactly as before.
 */

const s = vi.hoisted(() => ({
  campaigns: [] as any[],
  tasks: [] as any[],
  messages: [] as any[],
  leads: [] as any[],
  audits: [] as any[],
  plannerCalls: [] as any[],
  generated: [] as any[],
  drafted: [] as any[],
  recorded: [] as any[],
  started: [] as any[],
  creation: null as any,
  auth: { role: 'OWNER' as string },
}));

vi.mock('@/lib/db', () => {
  const tx = {
    campaign: {
      create: async ({ data }: any) => {
        const row = { id: `camp_${s.campaigns.length + 1}`, creationContext: null, recommendationId: null, ...data };
        s.campaigns.push(row);
        return row;
      },
    },
    campaignTask: { createMany: async ({ data }: any) => s.tasks.push(...data) },
    auditLog: { create: async ({ data }: any) => s.audits.push(data) },
  };
  return {
    db: {
      ...tx,
      $transaction: async (fn: any) => fn(tx),
      company: { findUnique: async () => ({ id: 'co1', name: 'Botella' }) },
      campaign: {
        ...tx.campaign,
        findFirst: async ({ where }: any) => s.campaigns.find((c) => c.id === where.id && c.companyId === where.companyId) ?? null,
        update: async ({ where, data }: any) => Object.assign(s.campaigns.find((c) => c.id === where.id), data),
        findMany: async () => [],
      },
      campaignTask: {
        ...tx.campaignTask,
        findMany: async () => s.tasks.filter((t) => t.status === 'PENDING'),
        update: async () => ({}),
      },
      contentDraft: { findMany: async () => [] },
      outreachMessage: {
        findMany: async () => s.messages.filter((m) => m.status === 'APPROVED'),
        findFirst: async ({ where }: any) => s.messages.find((m) => m.id === where.id) ?? null,
        update: async ({ where, data }: any) => Object.assign(s.messages.find((m) => m.id === where.id), data),
      },
      lead: { findMany: async ({ where }: any) => s.leads.filter((l) => l.companyId === where.companyId && where.id.in.includes(l.id)) },
    },
  };
});
vi.mock('@/server/campaigns/planner', () => ({
  generateCampaignPlan: async (args: any) => {
    s.plannerCalls.push(args);
    return { plan: { overview: 'Plan', days: [{ day: 1, contentType: 'LINKEDIN_POST', topic: 'Announce', outreach: false, discovery: false }] }, model: 'none' };
  },
}));
vi.mock('@/server/content/generator', () => ({
  generateDraft: async (args: any) => {
    s.generated.push(args);
    return { id: 'draft1' };
  },
}));
vi.mock('@/server/outreach/drafting.service', () => ({
  draftForLead: async (args: any) => {
    s.drafted.push(args);
    return { connectionNoteId: `note_${args.leadId}`, followupId: `fu_${args.leadId}`, model: 'none' };
  },
}));
vi.mock('@/server/recommendations/creation.service', () => ({
  getCreation: async () => s.creation,
  startCreation: async (args: any) => {
    s.started.push(args);
    return { ...s.creation, plan: { ...s.creation.plan, acceptsOnCreate: false, state: 'ready' } };
  },
  recordCreation: async (args: any) => s.recorded.push(args),
}));
vi.mock('@/lib/auth-helpers', () => ({
  requireActiveCompany: async () => ({
    user: { id: 'u1', name: 'Olu', email: 'o@botella.test' },
    company: { id: 'co1', name: 'Botella' },
    membership: { role: s.auth.role },
  }),
}));

import { buildContextHandoff } from '@/lib/recommendation-context-handoff';
import { campaignCreationHandoff, outreachCreationHandoff } from '@/lib/creation-handoff';
import { createCampaign, setCampaignStatus } from '@/server/campaigns/campaign.service';
import { executeDueCampaignTasks } from '@/server/campaigns/executor.service';
import { getQueue } from '@/server/extension/queue.service';
import { completeAction } from '@/server/extension/action.service';
import { outreachMetaAfter } from '@/server/approval/approval.service';
import { POST as fromRecommendation } from '@/app/api/outreach/from-recommendation/route';

const handoff = buildContextHandoff({
  recommendation: {
    id: 'rec1', opportunityId: 'opp1', status: 'ACCEPTED', type: 'AUDIENCE',
    title: 'Reach rye fans before the holidays', action: 'Write to people who buy small-batch rye.',
    steps: ['Find rye buyers', 'Invite them to a tasting'], rationale: 'Rye sales are up.',
    expectedOutcome: 'More tasting bookings.', outcomeMetric: 'bookings', channel: 'LinkedIn',
    contentType: 'LINKEDIN_POST', audience: 'Rye enthusiasts', details: { action: 'targeted-post', angle: 'Small-batch rye' },
    confidence: 'HIGH', confidenceReason: null, executable: true, blockers: [],
    evidence: [{ label: 'Rye sales up 30%', detail: '', url: null, observedAt: null }],
  },
  business: {
    name: 'Botella', description: 'A bottle shop.', offerings: null, industry: 'Retail', website: 'https://botella.example',
    goals: 'Grow tasting bookings', audience: null, campaigns: [], connected: ['LinkedIn'], voice: null, memory: [],
  },
});
const campaignCtx = campaignCreationHandoff(handoff).context;
const outreachCtx = outreachCreationHandoff(handoff).context;
const input = { name: 'Rye season', goal: 'Grow tasting bookings', durationDays: 7, modules: { content: true, outreach: false, engagement: false, discovery: false }, targetAudience: '', themes: [] };

beforeEach(() => {
  for (const k of ['campaigns', 'tasks', 'messages', 'leads', 'audits', 'plannerCalls', 'generated', 'drafted', 'recorded', 'started'] as const) s[k].length = 0;
  s.auth.role = 'OWNER';
  s.creation = {
    plan: { recommendationId: 'rec1', canCreate: true, acceptsOnCreate: false, state: 'ready', message: null, fix: null, module: 'outreach' },
    handoff,
    provenance: null,
    related: ['lead-discovery', 'outreach'],
  };
});

describe('a campaign planned from a recommendation', () => {
  it('keeps the context, gives it to the planner, and is saved as a plan (DRAFT) — not run', async () => {
    const c = await createCampaign({ companyId: 'co1', userId: 'u1', input, creation: { recommendationId: 'rec1', context: campaignCtx } });
    expect(c.status).toBe('DRAFT');
    expect(c.recommendationId).toBe('rec1');
    expect(c.creationContext).toMatchObject({ target: 'campaigns', recommendation: { recommendationId: 'rec1' }, cta: { destination: { value: 'https://botella.example' } } });
    expect(s.plannerCalls[0].context).toBe(campaignCtx);
    expect(s.audits.find((a) => a.action === 'CAMPAIGN_CREATED').metadata).toMatchObject({ recommendationId: 'rec1', executionHeld: true });
  });

  it('a campaign planned from scratch is unchanged: ACTIVE, no context', async () => {
    const c = await createCampaign({ companyId: 'co1', userId: 'u1', input });
    expect(c.status).toBe('ACTIVE');
    expect(c.creationContext).toBeNull();
    expect(s.plannerCalls[0].context).toBeNull();
  });

  it('it cannot be started or resumed until execution arrives; ordinary campaigns still can', async () => {
    const held = await createCampaign({ companyId: 'co1', userId: 'u1', input, creation: { recommendationId: 'rec1', context: campaignCtx } });
    for (const action of ['resume', 'pause'] as const) {
      await expect(setCampaignStatus({ companyId: 'co1', userId: 'u1', campaignId: held.id, action })).rejects.toMatchObject({
        status: 409,
        code: 'execution_not_available',
      });
    }
    expect(held.status).toBe('DRAFT');
    const plain = await createCampaign({ companyId: 'co1', userId: 'u1', input });
    expect((await setCampaignStatus({ companyId: 'co1', userId: 'u1', campaignId: plain.id, action: 'pause' })).status).toBe('PAUSED');
  });

  it('the executor never runs its tasks — even if something set it ACTIVE', async () => {
    s.tasks.push(
      { id: 't1', companyId: 'co1', status: 'PENDING', taskType: 'GENERATE_CONTENT', contentType: 'LINKEDIN_POST', topic: 'x', campaign: { id: 'c1', status: 'ACTIVE', name: 'Held', goal: 'g', startDate: null, creationContext: campaignCtx } },
    );
    const r = await executeDueCampaignTasks();
    expect(s.generated).toHaveLength(0);
    expect(r).toMatchObject({ generated: 0, failed: 0 });
  });
});

describe('outreach drafted from a recommendation', () => {
  const approved = (id: string, extra: Record<string, unknown> = {}) => {
    const base = { id, companyId: 'co1', type: 'CONNECTION_NOTE', status: 'DRAFT', draftText: `Hi from ${id}`, updatedAt: new Date(), aiMetadata: {} as any, lead: { name: 'Ana', companyName: 'Rye Co', linkedInProfileUrl: null } };
    const aiMetadata = outreachMetaAfter(base as any, { action: 'approved', by: 'u1', nextStatus: 'APPROVED', approve: true }) as any;
    return { ...base, status: 'APPROVED', aiMetadata: { ...aiMetadata, ...extra } };
  };

  it('approved, it waits: never in the extension’s send queue; ordinary approved outreach still is', async () => {
    s.messages.push(approved('m_plain'), approved('m_held', { creationContext: outreachCtx }));
    const ids = (await getQueue('co1')).map((i) => i.itemId);
    expect(ids).toContain('m_plain');
    expect(ids).not.toContain('m_held');
  });

  it('it cannot be marked sent from the extension', async () => {
    s.messages.push(approved('m_held', { creationContext: outreachCtx }));
    const ctx = { tokenId: 't', userId: 'u1', companyId: 'co1', membership: { role: 'OWNER' } as any };
    await expect(completeAction({ ctx, itemType: 'outreach_message', itemId: 'm_held' })).rejects.toMatchObject({ status: 409 });
    expect(s.messages[0].status).toBe('APPROVED');
  });
});

describe('POST /api/outreach/from-recommendation', () => {
  const call = (body: unknown) =>
    fromRecommendation(new Request('https://aura.example/api/outreach/from-recommendation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

  beforeEach(() => {
    s.leads.push({ id: 'l1', companyId: 'co1', name: 'Ana', companyName: 'Rye Co' }, { id: 'l2', companyId: 'co1', name: null, companyName: 'Barrel & Co' }, { id: 'lx', companyId: 'co2', name: 'Eve', companyName: 'Other' });
  });

  it('drafts for each chosen lead with the outreach context; records it on the suggestion; says sending waits', async () => {
    const res = await call({ recommendationId: 'rec1', leadIds: ['l1', 'l2'] });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(s.drafted.map((d) => d.leadId)).toEqual(['l1', 'l2']);
    expect(s.drafted[0].creation.context).toMatchObject({ target: 'outreach', channel: { channel: 'LinkedIn' }, recommendation: { recommendationId: 'rec1' } });
    expect(s.recorded[0]).toMatchObject({ recommendationId: 'rec1', module: 'outreach', created: { type: 'outreach-drafts', label: 'Outreach drafts for 2 leads' } });
    expect(body.execution).toMatchObject({ blocked: true });
  });

  it('a still-open suggestion is said yes to on the way — by owners and admins only', async () => {
    s.creation.plan.acceptsOnCreate = true;
    s.auth.role = 'OWNER';
    expect((await call({ recommendationId: 'rec1', leadIds: ['l1'] })).status).toBe(201);
    expect(s.started).toHaveLength(1);
  });

  it('refused: no permission, not eligible (with the reason), another workspace’s lead, too many leads', async () => {
    s.auth.role = 'MEMBER';
    expect((await call({ recommendationId: 'rec1', leadIds: ['l1'] })).status).toBe(403);
    s.auth.role = 'OWNER';

    s.creation.plan = { ...s.creation.plan, canCreate: false, state: 'not_creatable', message: 'This suggestion isn’t aimed at particular people.', fix: { label: 'Create content', href: '/x' } };
    const notEligible = await call({ recommendationId: 'rec1', leadIds: ['l1'] });
    expect(notEligible.status).toBe(409);
    expect((await notEligible.json()).error).toMatch(/aimed at particular people/);
    s.creation.plan = { ...s.creation.plan, canCreate: true, state: 'ready' };

    expect((await call({ recommendationId: 'rec1', leadIds: ['lx'] })).status).toBe(404);
    expect((await call({ recommendationId: 'rec1', leadIds: ['a', 'b', 'c', 'd', 'e', 'f'] })).status).toBe(400);
    expect(s.drafted).toHaveLength(0);
  });
});
