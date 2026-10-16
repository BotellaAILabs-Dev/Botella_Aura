import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Failure & recovery: a retried generation never writes a second draft; a
 * suggestion that disappeared is said plainly (never a silent generic
 * draft); a provider outage is one plain message, never raw provider text,
 * and is logged; a failure to record history never loses the draft.
 */

const s = vi.hoisted(() => ({
  drafts: [] as any[],
  generateCalls: 0,
  creation: null as any,
  generateError: null as any,
  recordError: null as any,
  captured: [] as any[],
}));

vi.mock('@/lib/auth-helpers', () => ({
  requireActiveCompany: async () => ({ user: { id: 'u1' }, company: { id: 'co1' }, membership: { role: 'MEMBER' } }),
}));
vi.mock('@/lib/db', () => ({
  db: {
    contentDraft: {
      findFirst: async ({ where }: any) =>
        s.drafts.find((d) => d.companyId === where.companyId && d.createdById === where.createdById && d.aiMetadata?.idempotencyKey === where.aiMetadata.equals) ?? null,
    },
  },
}));
vi.mock('@/server/company/profile.service', () => ({ getEnabledContentTypes: async () => ['LINKEDIN_POST'] }));
vi.mock('@/server/content/content-brief.service', () => ({ getContentBrief: async () => null }));
vi.mock('@/server/recommendations/creation.service', () => ({
  getCreation: async () => s.creation,
  recordCreation: async () => {
    if (s.recordError) throw s.recordError;
  },
}));
vi.mock('@/server/content/generator', () => ({
  generateDraft: async (args: any) => {
    s.generateCalls++;
    if (s.generateError) throw s.generateError;
    const d = { id: `d${s.generateCalls}`, type: args.type, status: 'DRAFT', title: 'T', companyId: 'co1', createdById: 'u1', aiMetadata: { idempotencyKey: args.idempotencyKey } };
    s.drafts.push(d);
    return d;
  },
}));
vi.mock('@/lib/monitoring', () => ({ captureException: (e: unknown, ctx: unknown) => s.captured.push({ e, ctx }) }));

import { POST as generate } from '@/app/api/content/generate/route';

const call = (body: Record<string, unknown>) =>
  generate(new Request('https://aura.example/api/content/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const base = { type: 'LINKEDIN_POST', source: { kind: 'BRIEF', brief: 'Our weekend brunch is back.' } };

beforeEach(() => {
  s.drafts = [];
  s.generateCalls = 0;
  s.creation = null;
  s.generateError = null;
  s.recordError = null;
  s.captured = [];
});

describe('a retried generation never writes a second draft', () => {
  it('the same idempotency key returns the draft already written — written once', async () => {
    const first = await call({ ...base, idempotencyKey: 'form-key-123' });
    expect(first.status).toBe(201);
    const again = await call({ ...base, idempotencyKey: 'form-key-123' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: 'd1', reused: true });
    expect(s.generateCalls).toBe(1);
    // A new form (new key) writes a new draft.
    expect((await call({ ...base, idempotencyKey: 'form-key-456' })).status).toBe(201);
    expect(s.generateCalls).toBe(2);
  });
});

describe('the suggestion it was written for disappeared', () => {
  it('409 with what to do — never an unlinked generic draft', async () => {
    const res = await call({ ...base, recommendationId: 'rec_gone' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/no longer available.*brief is kept/);
    expect(body.fix).toMatchObject({ href: '/dashboard/suggestions' });
    expect(s.generateCalls).toBe(0);
  });
});

describe('the AI provider fails', () => {
  it('quota: one plain message (no raw provider text), 503, and it is logged', async () => {
    s.generateError = Object.assign(new Error('Gemini API error (429): { "error": { "code": 429, "message": "You exceeded your current quota" } }'), { status: 429 });
    const res = await call(base);
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.error).toMatch(/at its limit right now/);
    expect(JSON.stringify(body)).not.toMatch(/Gemini API error|"code"|exceeded your current quota/);
    expect(s.captured).toHaveLength(1);
  });

  it('outage: “did not answer — nothing was changed”', async () => {
    s.generateError = Object.assign(new Error('Gemini API error (503): overloaded'), { status: 503 });
    const res = await call(base);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/did not answer\. Nothing was changed/);
  });
});

describe('recording it on the suggestion fails', () => {
  it('the draft is still returned (the person’s work is not lost)', async () => {
    s.creation = {
      plan: { canCreate: true, acceptsOnCreate: false, recommendationId: 'rec1' },
      provenance: { recommendationId: 'rec1', title: 'Rec' },
    };
    s.recordError = new Error('db blip');
    const res = await call({ ...base, recommendationId: 'rec1' });
    expect(res.status).toBe(201);
    expect((await res.json()).id).toBe('d1');
  });
});
