import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Approval → Execution handoff (lib/execution-handoff.ts and
 * server/execution/*): approved work becomes an execution-ready object with
 * every required field; provider/channel requirements are validated; a
 * missing connection is an explicit BLOCKED state with a fix, never silent;
 * the payload is what was approved and carries no secrets; and Sprint 10 can
 * consume READY handoffs through the execution service seam.
 */

import {
  buildExecutionHandoff,
  executionHandoffSchema,
  readExecutionHandoff,
  type HandoffFacts,
} from '@/lib/execution-handoff';
import type { ApprovalRecord } from '@/lib/approval';

const NOW = new Date('2026-10-16T12:00:00Z');

const approval = (hash = 'H1'): ApprovalRecord => ({
  model: 1,
  version: 3,
  hash,
  approved: { id: 'apr_1', by: 'u_owner', via: 'person', at: '2026-10-16T10:00:00.000Z', version: 3, hash: 'H1', snapshot: { body: { hook: 'Approved text' } } },
  rejected: null,
  events: [],
});

function facts(over: Partial<HandoffFacts> = {}, conn: Partial<HandoffFacts['connections']> = {}): HandoffFacts {
  return {
    companyId: 'co1',
    draft: { id: 'd1', type: 'LINKEDIN_POST', status: 'APPROVED', title: 'Brunch', scheduledFor: new Date('2026-10-20T09:00:00Z'), body: { hook: 'Now text' }, currentHash: 'H1', cta: 'Book a table' },
    approval: approval(),
    versions: { model: 1, current: 4, approved: { n: 4, by: 'u_owner', at: '2026-10-16T10:00:00.000Z' }, versions: [] },
    platform: 'LINKEDIN',
    text: 'Our weekend brunch is back.',
    media: [],
    mediaProblems: [],
    formatSupported: true,
    copyOnly: false,
    recommendation: { recommendationId: 'rec1', opportunityId: 'opp1', audience: 'Brunch lovers' },
    businessWebsite: 'https://botella.example',
    connections: {
      linkedin: { connected: true, expired: false, scopes: ['openid', 'w_member_social'], memberName: 'Ana Botella', memberId: 'li_123', orgUrn: null },
      meta: { connected: true, expired: false, pageId: '111', pageName: 'Botella Page', igUserId: '1784', igUsername: 'botella' },
      ...conn,
    },
    ...over,
  };
}

const codes = (f: HandoffFacts) => buildExecutionHandoff(f, NOW).readiness.issues.map((i) => i.code);

describe('the execution-ready object', () => {
  it('carries everything the executor needs, valid against the contract', () => {
    const h = buildExecutionHandoff(facts(), NOW);
    expect(executionHandoffSchema.safeParse(h).success).toBe(true);
    expect(h).toMatchObject({
      version: 1,
      item: { type: 'content_draft', id: 'd1', companyId: 'co1' },
      asset: { contentType: 'LINKEDIN_POST', text: 'Our weekend brunch is back.', body: { body: { hook: 'Approved text' } }, media: [] },
      recommendationId: 'rec1',
      opportunityId: 'opp1',
      channel: { platform: 'LINKEDIN', label: 'LinkedIn' },
      provider: { id: 'linkedin', mode: 'api' },
      account: { kind: 'linkedin_member', label: 'Ana Botella', id: 'li_123' },
      audience: 'Brunch lovers',
      cta: { text: 'Book a table', destination: 'https://botella.example' },
      scheduledFor: '2026-10-20T09:00:00.000Z',
      contentVersion: { version: 3, hash: 'H1', versionNumber: 4 },
      approval: { id: 'apr_1', by: 'u_owner', via: 'person', version: 3, hash: 'H1' },
      requirements: { captionLimit: 3000 },
      readiness: { status: 'ready', issues: [] },
      preparedAt: NOW.toISOString(),
    });
  });

  it('the asset is the APPROVED snapshot, not later edits', () => {
    expect(buildExecutionHandoff(facts(), NOW).asset.body).toEqual({ body: { hook: 'Approved text' } });
  });

  it('carries no secrets: ids and labels only', () => {
    const json = JSON.stringify(buildExecutionHandoff(facts(), NOW));
    expect(json).not.toMatch(/token|secret|accessToken/i);
  });

  it('no CTA text → no destination (a URL is never attached to nothing)', () => {
    expect(buildExecutionHandoff(facts({ draft: { ...facts().draft, cta: null } }), NOW).cta).toEqual({ text: null, destination: null });
  });

  it('only approved work can be handed over at all', () => {
    expect(() => buildExecutionHandoff(facts({ approval: null }), NOW)).toThrow(/Only approved work/);
  });

  it('round-trips through storage; a malformed payload reads as absent', () => {
    const h = buildExecutionHandoff(facts(), NOW);
    expect(readExecutionHandoff(JSON.parse(JSON.stringify(h)))).toEqual(h);
    expect(readExecutionHandoff({ version: 1 })).toBeNull();
  });
});

describe('provider and channel validation — missing connections are never silent', () => {
  it('LinkedIn: not connected / expired / no posting permission', () => {
    expect(codes(facts({}, { linkedin: null }))).toEqual(['missing_connection']);
    expect(codes(facts({}, { linkedin: { ...facts().connections.linkedin!, expired: true } }))).toEqual(['connection_expired']);
    expect(codes(facts({}, { linkedin: { ...facts().connections.linkedin!, scopes: ['openid'] } }))).toEqual(['missing_permission']);
    const blocked = buildExecutionHandoff(facts({}, { linkedin: null }), NOW);
    expect(blocked.readiness.status).toBe('blocked');
    expect(blocked.readiness.issues[0]!.fix).toMatchObject({ label: 'Connect LinkedIn' });
  });

  it('LinkedIn company Page when the organisation scope and URN exist', () => {
    const h = buildExecutionHandoff(
      facts({}, { linkedin: { ...facts().connections.linkedin!, scopes: ['w_organization_social'], orgUrn: 'urn:li:organization:9' } }),
      NOW,
    );
    expect(h.account).toMatchObject({ kind: 'linkedin_organization', id: 'urn:li:organization:9' });
    expect(h.readiness.status).toBe('ready');
  });

  it('Facebook: needs the Meta connection and a chosen Page', () => {
    const fb = (meta: HandoffFacts['connections']['meta']) => facts({ platform: 'FACEBOOK' }, { meta });
    expect(buildExecutionHandoff(fb(facts().connections.meta), NOW)).toMatchObject({
      provider: { id: 'meta' },
      account: { kind: 'facebook_page', pageId: '111', pageName: 'Botella Page' },
      readiness: { status: 'ready' },
    });
    expect(codes(fb(null))).toEqual(['missing_connection']);
    expect(codes(fb({ ...facts().connections.meta!, expired: true }))).toEqual(['connection_expired']);
    expect(codes(fb({ ...facts().connections.meta!, pageId: null }))).toEqual(['missing_account']);
  });

  it('Instagram: needs a linked professional account and media; invalid media is listed', () => {
    const img = { assetId: 'a1', kind: 'IMAGE' as const, mimeType: 'image/jpeg', width: 1080, height: 1350, altText: null, position: 0 };
    expect(buildExecutionHandoff(facts({ platform: 'INSTAGRAM', media: [img] }), NOW)).toMatchObject({
      account: { kind: 'instagram_account', label: '@botella', id: '1784' },
      readiness: { status: 'ready' },
    });
    expect(codes(facts({ platform: 'INSTAGRAM', media: [img] }, { meta: { ...facts().connections.meta!, igUserId: null } }))).toEqual(['missing_account']);
    expect(codes(facts({ platform: 'INSTAGRAM' }))).toEqual(['missing_media']);
    expect(codes(facts({ platform: 'INSTAGRAM', media: [img], mediaProblems: ['The image is 200x200; Instagram wants at least 320px.'] }))).toEqual(['invalid_media']);
  });

  it('unsupported channels: X, a format the network’s API does not take, emails and ads', () => {
    expect(buildExecutionHandoff(facts({ platform: 'X' }), NOW)).toMatchObject({ provider: { id: 'none', mode: 'manual' }, account: null, readiness: { status: 'blocked' } });
    expect(codes(facts({ platform: 'X' }))).toEqual(['unsupported_channel']);
    expect(codes(facts({ formatSupported: false }))).toEqual(['unsupported_channel']);
    expect(codes(facts({ copyOnly: true }))).toEqual(['unsupported_channel']);
  });

  it('required fields: something to publish', () => {
    expect(codes(facts({ text: ' ' }))).toEqual(['missing_field']);
  });

  it('several problems are all listed at once (fixed in one pass)', () => {
    const c = codes(facts({ platform: 'INSTAGRAM' }, { meta: { ...facts().connections.meta!, igUserId: null } }));
    expect(c).toEqual(expect.arrayContaining(['missing_account', 'missing_media']));
  });
});

describe('the approval states it follows', () => {
  it('changed since approval, or reopened: superseded — approve again', () => {
    expect(buildExecutionHandoff(facts({ draft: { ...facts().draft, currentHash: 'H2' } }), NOW).readiness).toMatchObject({
      status: 'superseded',
      issues: [{ code: 'content_changed' }],
    });
    expect(buildExecutionHandoff(facts({ draft: { ...facts().draft, status: 'DRAFT' } }), NOW).readiness).toMatchObject({
      status: 'superseded',
      issues: [{ code: 'not_approved' }],
    });
  });

  it('published: executed', () => {
    expect(buildExecutionHandoff(facts({ draft: { ...facts().draft, status: 'PUBLISHED' } }), NOW).readiness.status).toBe('executed');
  });
});

// ---------------------------------------------------------------------------
// The service: persisted, audited, handed to the execution seam
// ---------------------------------------------------------------------------

const s = vi.hoisted(() => ({ draft: null as any, rows: [] as any[], audits: [] as any[], accepted: [] as any[], linkedin: null as any, meta: null as any, media: [] as any[] }));

vi.mock('@/lib/db', () => ({
  db: {
    contentDraft: { findFirst: async ({ where }: any) => (s.draft && s.draft.id === where.id && s.draft.companyId === where.companyId ? s.draft : null) },
    contentMedia: { findMany: async () => s.media },
    company: { findUnique: async () => ({ website: 'https://botella.example' }) },
    linkedInConnection: { findUnique: async () => s.linkedin },
    connection: { findUnique: async () => s.meta },
    executionHandoff: {
      findUnique: async ({ where }: any) => {
        const row = s.rows.find((r) => r.contentDraftId === where.contentDraftId_platform.contentDraftId && r.platform === where.contentDraftId_platform.platform);
        return row ? { ...row } : null; // a copy, as Prisma returns
      },
      upsert: async ({ where, create, update }: any) => {
        const k = where.contentDraftId_platform;
        const row = s.rows.find((r) => r.contentDraftId === k.contentDraftId && r.platform === k.platform);
        if (row) Object.assign(row, update);
        else s.rows.push({ id: `h${s.rows.length + 1}`, ...create });
      },
      updateMany: async ({ where, data }: any) => {
        const rows = s.rows.filter((r) => r.contentDraftId === where.contentDraftId && r.companyId === where.companyId);
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
      findMany: async ({ where }: any) =>
        s.rows.filter(
          (r) =>
            r.status === where.status &&
            (!where.companyId || r.companyId === where.companyId) &&
            (!where.OR || r.scheduledFor == null || r.scheduledFor <= where.OR[1].scheduledFor.lte),
        ),
    },
    auditLog: { create: async ({ data }: any) => s.audits.push(data) },
  },
}));
vi.mock('@/server/approval/approval.service', () => ({ contentHash: async () => 'H1' }));
vi.mock('@/server/content/render', () => ({
  renderForManual: (d: any) => d.body.text,
  renderLinkedInCommentary: (d: any) => d.body.text,
}));

import { prepareExecutionHandoff, markHandoffExecuted, refreshExecutionHandoff } from '@/server/execution/execution-handoff.service';
import { listReadyHandoffs, setExecutionService } from '@/server/execution/execution.service';

describe('the handoff record and the execution service seam', () => {
  beforeEach(() => {
    s.rows = [];
    s.audits = [];
    s.accepted = [];
    s.media = [];
    s.draft = {
      id: 'd1', companyId: 'co1', type: 'LINKEDIN_POST', platform: 'LINKEDIN', status: 'APPROVED', title: 'Brunch',
      scheduledFor: null, body: { text: 'Our brunch is back.', cta: '' },
      aiMetadata: { approval: approval(), recommendation: { recommendationId: 'rec1', opportunityId: 'opp1', audience: null } },
    };
    s.linkedin = { status: 'ACTIVE', accessTokenEnc: 'enc', expiresAt: new Date(Date.now() + 86_400_000), scope: 'openid w_member_social', displayName: 'Ana', linkedInUserId: 'li1' };
    s.meta = null;
    setExecutionService({ accept: async (h) => void s.accepted.push(h) });
  });

  it('approved and valid: stored READY, audited once, handed to the execution service once', async () => {
    const h = await prepareExecutionHandoff({ companyId: 'co1', draftId: 'd1', userId: 'u_owner', now: NOW });
    expect(h?.readiness.status).toBe('ready');
    expect(s.rows[0]).toMatchObject({ companyId: 'co1', contentDraftId: 'd1', platform: 'LINKEDIN', status: 'READY', contentVersion: 3, contentHash: 'H1' });
    expect(s.audits.map((a) => a.action)).toEqual(['EXECUTION_HANDOFF_READY']);
    expect(s.accepted).toHaveLength(1);
    // Re-reading an unchanged handoff records nothing new and hands nothing over twice.
    await prepareExecutionHandoff({ companyId: 'co1', draftId: 'd1', now: NOW });
    expect(s.audits).toHaveLength(1);
    expect(s.accepted).toHaveLength(1);
  });

  it('missing connection: stored BLOCKED with the issue, audited — not handed over, not silent', async () => {
    s.linkedin = null;
    const h = await prepareExecutionHandoff({ companyId: 'co1', draftId: 'd1', now: NOW });
    expect(h?.readiness).toMatchObject({ status: 'blocked', issues: [{ code: 'missing_connection' }] });
    expect(s.rows[0]).toMatchObject({ status: 'BLOCKED', issues: [{ code: 'missing_connection' }] });
    expect(s.audits[0]).toMatchObject({ action: 'EXECUTION_HANDOFF_BLOCKED', metadata: { issues: ['missing_connection'] } });
    expect(s.accepted).toHaveLength(0);
    // Connected later: the next read makes it READY and hands it over.
    s.linkedin = { status: 'ACTIVE', accessTokenEnc: 'enc', expiresAt: null, scope: 'w_member_social', displayName: 'Ana', linkedInUserId: 'li1' };
    expect((await prepareExecutionHandoff({ companyId: 'co1', draftId: 'd1', now: NOW }))?.readiness.status).toBe('ready');
    expect(s.accepted).toHaveLength(1);
  });

  it('never approved, or another workspace’s: nothing', async () => {
    expect(await prepareExecutionHandoff({ companyId: 'co2', draftId: 'd1' })).toBeNull();
    s.draft.aiMetadata = {};
    expect(await prepareExecutionHandoff({ companyId: 'co1', draftId: 'd1' })).toBeNull();
    expect(s.rows).toHaveLength(0);
  });

  it('Sprint 10 reads READY handoffs (due ones by time); published ones leave the queue', async () => {
    await prepareExecutionHandoff({ companyId: 'co1', draftId: 'd1', now: NOW });
    const ready = await listReadyHandoffs({ dueBefore: new Date() });
    expect(ready.map((r) => r.contentDraftId)).toEqual(['d1']);
    expect(ready[0]!.payload.approval.hash).toBe('H1');
    await markHandoffExecuted('co1', 'd1');
    expect(s.rows[0].status).toBe('EXECUTED');
    expect(await listReadyHandoffs()).toHaveLength(0);
  });

  it('the hook never throws (an approval must not fail because of the handoff)', async () => {
    s.draft = { ...s.draft, aiMetadata: { approval: { approved: {} } } }; // malformed
    await expect(refreshExecutionHandoff({ companyId: 'co1', draftId: 'd1' })).resolves.toBeUndefined();
  });
});
