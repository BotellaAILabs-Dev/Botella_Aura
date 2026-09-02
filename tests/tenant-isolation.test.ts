import { describe, it, expect, vi } from 'vitest';

/**
 * Multi-tenant data isolation (Sprint 6, Module 4) — a hard security requirement
 * and release blocker (NON-NEGOTIABLE #3). These tests drive the REAL scoped
 * service getters through a faithful in-memory mock seeded with two companies,
 * and prove a user acting for company B can never read company A's data across
 * campaigns, leads, content, and billing.
 */
const { tables } = vi.hoisted(() => ({
  tables: {
    campaign: [] as any[],
    lead: [] as any[],
    contentDraft: [] as any[],
    subscription: [] as any[],
    generatedAsset: [] as any[],
  },
}));

function whereMatch(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}
function withIncludes(row: any, include: any) {
  if (!row || !include) return row;
  const clone = { ...row };
  for (const key of Object.keys(include)) {
    if (!(key in clone)) clone[key] = key === 'discoveryProfile' ? null : [];
  }
  return clone;
}
function model(name: keyof typeof tables) {
  return {
    findFirst: async ({ where, include }: any) => {
      const row = tables[name].find((r) => whereMatch(r, where)) ?? null;
      return withIncludes(row, include);
    },
    findUnique: async ({ where, include }: any) => {
      const row = tables[name].find((r) => whereMatch(r, where)) ?? null;
      return withIncludes(row, include);
    },
  };
}

vi.mock('@/lib/db', () => ({
  db: {
    campaign: model('campaign'),
    lead: model('lead'),
    contentDraft: model('contentDraft'),
    subscription: model('subscription'),
    generatedAsset: model('generatedAsset'),
  },
}));

import { getCampaign, CampaignNotFoundError } from '@/server/campaigns/campaign.service';
import { getLeadDetail } from '@/server/leads/detail.service';
import { getDraft } from '@/server/content/content.service';
import { getSubscription } from '@/server/billing/subscription.service';
import { getAsset, AssetNotFoundError } from '@/server/media/asset.service';

const A = 'company_A';
const B = 'company_B';

// Seed one resource per domain for company A.
tables.campaign.push({ id: 'camp_A', companyId: A, name: 'A campaign' });
tables.lead.push({ id: 'lead_A', companyId: A, companyName: 'A lead' });
tables.contentDraft.push({ id: 'draft_A', companyId: A, title: 'A draft' });
tables.subscription.push({ id: 'sub_A', companyId: A, plan: 'GROWTH' });
tables.subscription.push({ id: 'sub_B', companyId: B, plan: 'STARTER' });
tables.generatedAsset.push({
  id: 'asset_A',
  companyId: A,
  storage: 'DATABASE',
  mimeType: 'image/png',
});

describe('multi-tenant isolation', () => {
  it('campaigns: company B cannot read company A campaign', async () => {
    await expect(getCampaign(B, 'camp_A')).rejects.toBeInstanceOf(CampaignNotFoundError);
    // control: the owner can.
    await expect(getCampaign(A, 'camp_A')).resolves.toMatchObject({ id: 'camp_A' });
  });

  it('leads: company B cannot read company A lead', async () => {
    expect(await getLeadDetail(B, 'lead_A')).toBeNull();
    expect(await getLeadDetail(A, 'lead_A')).toMatchObject({ id: 'lead_A' });
  });

  it('content: company B cannot read company A draft', async () => {
    expect(await getDraft(B, 'draft_A')).toBeNull();
    expect(await getDraft(A, 'draft_A')).toMatchObject({ id: 'draft_A' });
  });

  it('billing: each company only sees its own subscription', async () => {
    expect(await getSubscription(A)).toMatchObject({ plan: 'GROWTH' });
    expect(await getSubscription(B)).toMatchObject({ plan: 'STARTER' });
  });

  it('graphics: company B cannot read company A generated asset', async () => {
    // Generated graphics can be commercially sensitive (unreleased campaigns,
    // unannounced products), so they get the same scoping as everything else.
    // Note this throws NotFound rather than Forbidden on purpose: confirming
    // that an asset id exists is itself a leak.
    await expect(getAsset(B, 'asset_A')).rejects.toBeInstanceOf(AssetNotFoundError);
    await expect(getAsset(A, 'asset_A')).resolves.toMatchObject({ id: 'asset_A' });
  });
});
