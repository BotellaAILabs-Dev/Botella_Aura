/**
 * Permission & security validation, end to end on the running app and the
 * real database. Two workspaces (A and B), A with one person in each role,
 * and real assets in both:
 *
 *   Isolation   A's owner reaches NONE of B's drafts, versions, graphics,
 *               recommendations, outreach, campaigns or execution handoffs —
 *               every one is 404 (no leak that it exists), and B's data is
 *               unchanged afterwards
 *   Roles       VIEWER cannot create, edit, restore, upload or decide; MEMBER
 *               can draft and edit but cannot approve, publish, restore approved
 *               work or decide a suggestion; ADMIN/OWNER can approve
 *   Approval    unauthorised approval is refused on every path (status, review,
 *               bulk, outreach) — and nothing is approved
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:permissions
 */
import bcrypt from 'bcryptjs';
import type { CompanyRole, Prisma } from '@prisma/client';

import { db } from '@/lib/db';

const BASE = (process.env.VERIFY_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-perm-${STAMP}!`;

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

class Web {
  private jar = new Map<string, string>();
  constructor(readonly who: string) {}
  private keep(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      this.jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
  }
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: 'manual',
      headers: { Origin: BASE, cookie: this.cookie(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.keep(res);
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(await res.text());
    } catch {
      /* page */
    }
    return { status: res.status, json };
  }
  async signIn(email: string) {
    const csrf = await this.req('GET', '/api/auth/csrf');
    const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: this.cookie() },
      body: new URLSearchParams({ csrfToken: csrf.json.csrfToken, email, password: PASSWORD, json: 'true' }),
    });
    this.keep(res);
  }
}

// A 1×1 PNG, stored in the database like any graphic.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000ff2f75e70000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

async function workspace(tag: string, roles: CompanyRole[]) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const company = await db.company.create({ data: { name: `zzverify Perm ${tag} ${STAMP}`, slug: `zzverify-perm-${tag.toLowerCase()}-${STAMP}`} });
  const users: Record<string, { id: string; email: string }> = {};
  for (const role of roles) {
    const u = await db.user.create({ data: { email: `zzverify-perm-${tag.toLowerCase()}-${role.toLowerCase()}-${STAMP}@example.test`, passwordHash: hash } });
    await db.companyMember.create({ data: { userId: u.id, companyId: company.id, role } });
    users[role] = u;
  }
  const draft = await db.contentDraft.create({
    data: { companyId: company.id, type: 'LINKEDIN_POST', platform: 'LINKEDIN', status: 'DRAFT', title: `Draft ${tag}`, body: { hook: `Hook ${tag}`, paragraphs: ['One.', 'Two.', 'Three.'], cta: 'Visit us.', hashtags: [] } },
  });
  const opp = await db.opportunity.create({
    data: { companyId: company.id, type: 'TRENDING_TOPIC', title: `Opp ${tag}`, summary: 's', source: 'ADVISOR', detectedBy: 'verify', priority: 'MEDIUM', priorityScore: 50, confidence: 'MEDIUM', dedupeKey: `verify-${tag}-${STAMP}` },
  });
  const rec = await db.recommendation.create({
    data: {
      companyId: company.id, opportunityId: opp.id, type: 'CONTENT', status: 'PRESENTED', title: `Rec ${tag}`, summary: 's', action: 'Post about it.',
      rationale: 'Because.', expectedOutcome: 'Reach.', confidence: 'MEDIUM', priority: 'MEDIUM', priorityScore: 50, handoff: {} as Prisma.InputJsonObject, handoffVersion: 1, createdBy: 'verify',
    },
  });
  const lead = await db.lead.create({ data: { companyId: company.id, companyName: `Lead Co ${tag}`, name: `Lead ${tag}` } });
  const message = await db.outreachMessage.create({ data: { companyId: company.id, leadId: lead.id, type: 'CONNECTION_NOTE', status: 'PENDING_APPROVAL', draftText: `Hello from ${tag}` } });
  const campaign = await db.campaign.create({ data: { companyId: company.id, name: `Campaign ${tag}`, goal: 'Grow', status: 'ACTIVE' } });
  const asset = await db.generatedAsset.create({
    data: { companyId: company.id, contentDraftId: draft.id, provider: 'UPLOAD', model: 'upload', prompt: 'verify', aspectRatio: '1:1', width: 1, height: 1, mimeType: 'image/png', fileSize: PNG.length, data: PNG },
  });
  return { company, users, draft, rec, lead, message, campaign, asset };
}

async function main() {
  const A = await workspace('A', ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);
  const B = await workspace('B', ['OWNER']);
  const web: Record<string, Web> = {};
  try {
    for (const role of ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']) {
      web[role] = new Web(role);
      await web[role]!.signIn(A.users[role]!.email);
    }
    const owner = web.OWNER!;
    const notFound = async (label: string, method: string, path: string, body?: unknown) => {
      const r = await owner.req(method, path, body);
      check(`another workspace: ${label} → 404`, r.status === 404, `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    };

    console.log('Cross-business isolation (A’s owner → B’s assets)');
    await notFound('read a draft', 'GET', `/api/content/drafts/${B.draft.id}`);
    await notFound('edit a draft', 'PATCH', `/api/content/drafts/${B.draft.id}`, { title: 'hijack', body: { hook: 'Edited hook', paragraphs: ['One.', 'Two.', 'Three.'], cta: 'Visit us.', hashtags: [] } });
    await notFound('approve a draft (status)', 'POST', `/api/content/drafts/${B.draft.id}/status`, { action: 'approve' });
    await notFound('approve a draft (review)', 'POST', `/api/review/content/${B.draft.id}`, { action: 'approve' });
    await notFound('read a draft’s versions', 'GET', `/api/review/content/${B.draft.id}/versions`);
    await notFound('restore a draft version', 'POST', `/api/review/content/${B.draft.id}/versions`, { version: 1 });
    await notFound('read the execution handoff', 'GET', `/api/content/drafts/${B.draft.id}/execution`);
    await notFound('read a graphic', 'GET', `/api/content/graphics/${B.asset.id}`);
    await notFound('download a graphic', 'GET', `/api/content/graphics/${B.asset.id}/file`);
    await notFound('attach B’s graphic to A’s draft', 'POST', `/api/content/graphics/${B.asset.id}/attach`, { draftId: A.draft.id, replace: true });
    await notFound('delete a graphic', 'DELETE', `/api/content/graphics/${B.asset.id}`);
    await notFound('read a recommendation', 'GET', `/api/recommendations/${B.rec.id}`);
    await notFound('decide a recommendation', 'POST', `/api/recommendations/${B.rec.id}/decision`, { decision: 'ACCEPTED' });
    await notFound('approve outreach (review)', 'POST', `/api/review/outreach/${B.message.id}`, { action: 'approve' });
    await notFound('approve outreach (status)', 'POST', `/api/outreach/messages/${B.message.id}/status`, { action: 'approve' });
    await notFound('pause a campaign', 'POST', `/api/campaigns/${B.campaign.id}/status`, { action: 'pause' });
    const bulk = await owner.req('POST', '/api/content/drafts/bulk', { ids: [B.draft.id], action: 'approve' });
    check('another workspace: bulk approve does nothing to B’s draft', bulk.status < 500, `HTTP ${bulk.status}`);
    const bAfter = await db.contentDraft.findUnique({ where: { id: B.draft.id } });
    const recAfter = await db.recommendation.findUnique({ where: { id: B.rec.id } });
    const msgAfter = await db.outreachMessage.findUnique({ where: { id: B.message.id } });
    const campAfter = await db.campaign.findUnique({ where: { id: B.campaign.id } });
    check(
      'B’s data is untouched (draft, recommendation, outreach, campaign, graphic)',
      bAfter?.status === 'DRAFT' && bAfter.title === 'Draft B' && recAfter?.status === 'PRESENTED' && msgAfter?.status === 'PENDING_APPROVAL' && campAfter?.status === 'ACTIVE' && Boolean(await db.generatedAsset.findUnique({ where: { id: B.asset.id } })),
      `${bAfter?.status} ${bAfter?.title} ${recAfter?.status} ${msgAfter?.status} ${campAfter?.status}`,
    );

    console.log('Roles inside a workspace');
    const as = (role: string) => web[role]!;
    const denied = async (role: string, label: string, method: string, path: string, body?: unknown) => {
      const r = await as(role).req(method, path, body);
      check(`${role.toLowerCase()} cannot ${label} (403)`, r.status === 403, `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    };
    // VIEWER: read-only.
    const viewerRead = await as('VIEWER').req('GET', `/api/content/drafts/${A.draft.id}`);
    check('viewer can read its workspace’s draft', viewerRead.status === 200, String(viewerRead.status));
    await denied('VIEWER', 'edit a draft', 'PATCH', `/api/content/drafts/${A.draft.id}`, { title: 'viewer edit', body: { hook: 'Edited hook', paragraphs: ['One.', 'Two.', 'Three.'], cta: 'Visit us.', hashtags: [] } });
    await denied('VIEWER', 'change a draft’s network', 'PATCH', `/api/content/drafts/${A.draft.id}`, { platform: 'FACEBOOK' });
    await denied('VIEWER', 'save edits in review', 'POST', `/api/review/content/${A.draft.id}`, { action: 'save', edits: { hook: 'x' } });
    await denied('VIEWER', 'submit for approval', 'POST', `/api/content/drafts/${A.draft.id}/status`, { action: 'submit' });
    await denied('VIEWER', 'restore a version', 'POST', `/api/review/content/${A.draft.id}/versions`, { version: 1 });
    await denied('VIEWER', 'attach a graphic', 'POST', `/api/content/graphics/${A.asset.id}/attach`, { draftId: A.draft.id, replace: true });
    await denied('VIEWER', 'delete a graphic', 'DELETE', `/api/content/graphics/${A.asset.id}`);
    await denied('VIEWER', 'decide a suggestion', 'POST', `/api/recommendations/${A.rec.id}/decision`, { decision: 'ACCEPTED' });
    await denied('VIEWER', 'approve outreach', 'POST', `/api/review/outreach/${A.message.id}`, { action: 'approve' });
    await denied('VIEWER', 'pause a campaign', 'POST', `/api/campaigns/${A.campaign.id}/status`, { action: 'pause' });
    const viewerTitle = (await db.contentDraft.findUnique({ where: { id: A.draft.id } }))?.title;
    check('…and the draft is unchanged', viewerTitle === 'Draft A', viewerTitle ?? '');

    // MEMBER: drafts and edits; never approves, publishes or decides.
    const memberEdit = await as('MEMBER').req('PATCH', `/api/content/drafts/${A.draft.id}`, { title: 'Member edit', body: { hook: 'Edited hook', paragraphs: ['One.', 'Two.', 'Three.'], cta: 'Visit us.', hashtags: [] } });
    check('member can edit a draft', memberEdit.status === 200, `HTTP ${memberEdit.status} ${JSON.stringify(memberEdit.json).slice(0, 120)}`);
    await denied('MEMBER', 'approve (status)', 'POST', `/api/content/drafts/${A.draft.id}/status`, { action: 'approve' });
    await denied('MEMBER', 'approve (review)', 'POST', `/api/review/content/${A.draft.id}`, { action: 'approve' });
    await denied('MEMBER', 'reject', 'POST', `/api/content/drafts/${A.draft.id}/status`, { action: 'reject' });
    await denied('MEMBER', 'publish', 'POST', `/api/content/drafts/${A.draft.id}/publish`);
    await denied('MEMBER', 'approve outreach', 'POST', `/api/review/outreach/${A.message.id}`, { action: 'approve' });
    await denied('MEMBER', 'approve outreach (status)', 'POST', `/api/outreach/messages/${A.message.id}/status`, { action: 'approve' });
    await denied('MEMBER', 'decide a suggestion', 'POST', `/api/recommendations/${A.rec.id}/decision`, { decision: 'ACCEPTED' });
    const memberBulk = await as('MEMBER').req('POST', '/api/content/drafts/bulk', { ids: [A.draft.id], action: 'approve' });
    const afterMember = await db.contentDraft.findUnique({ where: { id: A.draft.id } });
    const msgA = await db.outreachMessage.findUnique({ where: { id: A.message.id } });
    check(
      'unauthorised approval changed nothing (draft not approved by any path, outreach still pending)',
      afterMember?.status === 'DRAFT' && msgA?.status === 'PENDING_APPROVAL',
      `bulk HTTP ${memberBulk.status}; draft ${afterMember?.status}; outreach ${msgA?.status}`,
    );

    // Approved work cannot be un-approved, scheduled or rewritten by the wrong role.
    const approvedDraft = await db.contentDraft.create({
      data: { companyId: A.company.id, type: 'LINKEDIN_POST', platform: 'LINKEDIN', status: 'APPROVED', title: 'Approved A', body: { hook: 'Approved hook', paragraphs: ['One.', 'Two.', 'Three.'], cta: 'Visit us.', hashtags: [] } },
    });
    await denied('MEMBER', 'schedule an approved post through the queue', 'POST', `/api/content/drafts/${approvedDraft.id}/queue`, { scheduledFor: new Date(Date.now() + 60_000).toISOString() });
    await denied('VIEWER', 'send approved work back to draft', 'POST', `/api/content/drafts/${approvedDraft.id}/status`, { action: 'request_changes' });
    await denied('VIEWER', 'send outreach back for changes', 'POST', `/api/outreach/messages/${A.message.id}/status`, { action: 'request_changes' });
    await denied('MEMBER', 'bulk-submit outreach', 'POST', '/api/outreach/messages/bulk', { messageIds: [A.message.id], action: 'submit' });
    await denied('VIEWER', 'record an outreach outcome', 'POST', `/api/outreach/messages/${A.message.id}/outcome`, { connectionAccepted: true, replyReceived: true });
    await denied('VIEWER', 'generate an image', 'POST', '/api/generate-image', { prompt: 'A bottle on a counter' });
    await denied('VIEWER', 'run a generation job', 'POST', '/api/jobs/not-a-real-job/run');
    const stillApproved = await db.contentDraft.findUnique({ where: { id: approvedDraft.id } });
    check('…the approved post is still approved and unscheduled', stillApproved?.status === 'APPROVED' && !stillApproved.scheduledFor, `${stillApproved?.status} ${stillApproved?.scheduledFor}`);

    // ADMIN/OWNER: may approve (the approval gate's own checks may still ask for more).
    const adminApprove = await as('ADMIN').req('POST', `/api/review/outreach/${A.message.id}`, { action: 'approve' });
    check('admin can approve outreach', adminApprove.status === 200, `HTTP ${adminApprove.status} ${JSON.stringify(adminApprove.json).slice(0, 160)}`);
    const ownerDecide = await as('OWNER').req('POST', `/api/recommendations/${A.rec.id}/decision`, { decision: 'ACCEPTED' });
    check('owner can decide a suggestion', ownerDecide.status === 200, `HTTP ${ownerDecide.status} ${JSON.stringify(ownerDecide.json).slice(0, 160)}`);

    console.log('Signed out');
    const anon = await fetch(`${BASE}/api/content/drafts/${A.draft.id}`, { redirect: 'manual' });
    check('signed out: no draft data', anon.status === 401 || (anon.status >= 300 && anon.status < 400), String(anon.status));
  } finally {
    const companyIds = [A.company.id, B.company.id];
    const userIds = [...Object.values(A.users), ...Object.values(B.users)].map((u) => u.id);
    await db.auditLog.deleteMany({ where: { OR: [{ companyId: { in: companyIds } }, { userId: { in: userIds } }] } });
    await db.company.deleteMany({ where: { id: { in: companyIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    console.log('  ok      cleanup: throwaway users, workspaces and their assets removed');
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll permission checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
