/**
 * Sprint 10 execution — end to end on the running app and the real database.
 *
 *   Meta integration     the Page/Instagram account is identified, permissions
 *                        validated, unsupported capabilities blocked, a real
 *                        Graph call with a refused token handled, organic
 *                        analytics stored (Graph mocked for the metrics read)
 *   Execution job model  every field, and the trace Business Context →
 *                        Opportunity → Recommendation → Content → Approval → Execution
 *   State machine        every change recorded; invalid moves refused;
 *                        completed never runs again; failures keep their error;
 *                        rate-limit retry; cancel; UI shows the state
 *   Provider routing     correct provider/account; unsupported combinations
 *                        rejected before execution and logged
 *   Scheduling/timezone  workspace timezone; local wall time → UTC; DST gap;
 *                        past/invalid refused; reschedule; due posts run, not-yet-due don't
 *
 * Provider calls are made with deliberately fake tokens: LinkedIn and Meta
 * really refuse them, which exercises the failure paths for real.
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:execution
 */
import bcrypt from 'bcryptjs';
import type { CompanyRole, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { discoverAccounts } from '@/lib/connection-manager';
import { META_SCOPES } from '@/lib/meta';
import { checkCapability } from '@/lib/capabilities';
import { zonedToUtc } from '@/lib/timezone';
import { recordDiscoveredAccounts } from '@/server/connections/accounts';
import { contentHash } from '@/server/approval/approval.service';
import { prepareExecutionHandoff } from '@/server/execution/execution-handoff.service';
import { routeExecution } from '@/server/execution/routing.service';
import { runScheduledPublishes } from '@/server/content/publish.service';
import { claimPublication, finishPublication } from '@/server/content/publication-store';
import { runExecutionSweep } from '@/server/execution/execution-actions.service';
import { collectMetaInsights } from '@/server/connectors/meta-insights.service';

const BASE = (process.env.VERIFY_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-exec-${STAMP}!`;
const DAY = 24 * 60 * 60_000;
const FAKE = `NOT_A_REAL_TOKEN_${STAMP}`;
const NY = 'America/New_York';

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
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* page */
    }
    return { status: res.status, json, text };
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

async function workspace(tag: string, roles: CompanyRole[]) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const company = await db.company.create({ data: { name: `zzverify Exec ${tag} ${STAMP}`, slug: `zzverify-exec-${tag.toLowerCase()}-${STAMP}`, website: 'https://bakery.example' } });
  const users: Record<string, { id: string; email: string }> = {};
  const web: Record<string, Web> = {};
  for (const role of roles) {
    const u = await db.user.create({ data: { email: `zzverify-exec-${tag.toLowerCase()}-${role.toLowerCase()}-${STAMP}@example.test`, passwordHash: hash, emailVerified: new Date() } });
    await db.companyMember.create({ data: { userId: u.id, companyId: company.id, role } });
    users[role] = u;
    web[role] = new Web();
    await web[role]!.signIn(u.email);
  }
  return { company, users, web };
}

/** An approved post with its trace, as approval leaves it. */
async function approvedDraft(companyId: string, userId: string, args: { type: string; platform: 'LINKEDIN' | 'FACEBOOK' | 'INSTAGRAM'; recId?: string; oppId?: string; title: string }) {
  const draft = await db.contentDraft.create({
    data: {
      companyId,
      type: args.type as never,
      platform: args.platform,
      status: 'APPROVED',
      title: args.title,
      body: { hook: `${args.title}.`, paragraphs: ['Fresh bread daily.', 'Open from 7am.', 'Come early.'], cta: 'Visit us.', hashtags: ['bakery'] },
    },
  });
  const hash = await contentHash(draft);
  await db.contentDraft.update({
    where: { id: draft.id },
    data: {
      aiMetadata: {
        trace: {
          model: 1, traceId: `trc_verify_${STAMP}`, businessContext: { revision: `rev_${STAMP}`, fields: ['audience'] }, signalIds: [],
          opportunityId: args.oppId ?? null, recommendationId: args.recId ?? null, briefId: null, generatedVersion: 1,
          reviewedVersion: 1, reviewId: null, approvedVersion: 1, approvalId: `apv_verify_${draft.id}`, mediaAssetIds: [],
        },
        recommendation: args.recId ? { recommendationId: args.recId, opportunityId: args.oppId, title: 'Morning regulars' } : undefined,
        approval: { model: 1, version: 1, hash, approved: { id: `apv_verify_${draft.id}`, by: userId, via: 'person', at: new Date().toISOString(), version: 1, hash, snapshot: null }, rejected: null, events: [] },
      } as Prisma.InputJsonObject,
    },
  });
  await prepareExecutionHandoff({ companyId, draftId: draft.id, userId });
  return draft;
}

const exec = (draftId: string, platform: string) => db.execution.findUnique({ where: { contentDraftId_platform: { contentDraftId: draftId, platform: platform as never } }, include: { events: { orderBy: { at: 'asc' } } } });

async function main() {
  const A = await workspace('A', ['OWNER', 'MEMBER', 'VIEWER']);
  const B = await workspace('B', ['OWNER']);
  const owner = A.web.OWNER!;
  const companyId = A.company.id;
  const ownerId = A.users.OWNER!.id;
  try {
    // Connections: LinkedIn (member posting) and Meta (a Page with Instagram), with tokens the providers refuse.
    await db.linkedInConnection.create({
      data: { companyId, connectedAt: new Date(), linkedInUserId: 'li_exec', displayName: 'Dana Exec', accessTokenEnc: encrypt(`LI_${FAKE}`), scope: 'openid profile email w_member_social', expiresAt: new Date(Date.now() + 30 * DAY), status: 'ACTIVE' },
    });
    const pages = [{ id: '3330003', name: 'Exec Bakery', ig: { id: '17841400333', username: 'exec_bakery' } }];
    const metaMeta = { fbUserId: '9990333', pages, pageId: '3330003', pageName: 'Exec Bakery', igUserId: '17841400333', igUsername: 'exec_bakery' };
    const metaConn = await db.connection.create({
      data: {
        companyId, connectorId: 'meta', kind: 'OAUTH', status: 'CONNECTED', accountLabel: '@exec_bakery (Exec Bakery)', scope: META_SCOPES.join(' '),
        accessTokenEnc: encrypt(`META_${FAKE}`), expiresAt: new Date(Date.now() + 50 * DAY), metadata: metaMeta as Prisma.InputJsonObject,
        provider: 'meta', channels: ['FACEBOOK', 'INSTAGRAM'], providerAccountId: '9990333', scopes: [...META_SCOPES], setupStage: 'CONFIRMED', health: 'HEALTHY', confirmedAt: new Date(),
      },
    });
    await recordDiscoveredAccounts({ connectionId: metaConn.id, companyId, accounts: discoverAccounts({ connectorId: 'meta', accountLabel: 'Exec Bakery', providerAccountId: '9990333', metadata: metaMeta }) });
    const opp = await db.opportunity.create({ data: { companyId, type: 'TRENDING_TOPIC', title: 'Morning commuters', summary: 's', source: 'ADVISOR', detectedBy: 'verify', priority: 'HIGH', priorityScore: 80, confidence: 'HIGH', dedupeKey: `exec-${STAMP}` } });
    const rec = await db.recommendation.create({
      data: { companyId, opportunityId: opp.id, type: 'CONTENT', status: 'ACCEPTED', title: 'Invite morning regulars', summary: 's', action: 'Post.', rationale: 'Commuters pass at 7am.', expectedOutcome: 'Visits.', confidence: 'HIGH', priority: 'HIGH', priorityScore: 80, handoff: {} as Prisma.InputJsonObject, handoffVersion: 1, createdBy: 'verify' },
    });

    // ------------------------------------------------------------------ 5 (timezone first: everything after uses it)
    console.log('\n5. Scheduling & timezone');
    const memberTz = await A.web.MEMBER!.req('PATCH', '/api/company/timezone', { timezone: NY });
    const badTz = await owner.req('PATCH', '/api/company/timezone', { timezone: 'Mars/Olympus' });
    const setTz = await owner.req('PATCH', '/api/company/timezone', { timezone: NY });
    check('the workspace timezone is set by owners/admins only, and must be a real zone', memberTz.status === 403 && badTz.status === 422 && setTz.status === 200 && setTz.json.timezone === NY, `${memberTz.status} ${badTz.status} ${setTz.status}`);

    const li = await approvedDraft(companyId, ownerId, { type: 'LINKEDIN_POST', platform: 'LINKEDIN', recId: rec.id, oppId: opp.id, title: 'Fresh bread at 7' });
    const day = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
    const sched = await owner.req('POST', `/api/content/drafts/${li.id}/schedule`, { localTime: `${day}T09:00` });
    const expected = zonedToUtc(`${day}T09:00`, NY).at.toISOString();
    check('a local 09:00 is stored as the UTC instant for 09:00 in the workspace zone', sched.status === 200 && new Date(sched.json.scheduledFor).toISOString() === expected && sched.json.timeZone === NY, `${sched.status} ${sched.json.scheduledFor} vs ${expected}`);
    let e1 = await exec(li.id, 'LINKEDIN');
    check('the execution is Scheduled, keeping the zone and wall time chosen', e1?.status === 'SCHEDULED' && e1.scheduledTimeZone === NY && e1.scheduledLocal === `${day}T09:00` && e1.scheduledFor?.toISOString() === expected, `${e1?.status} ${e1?.scheduledTimeZone} ${e1?.scheduledLocal}`);
    const past = await owner.req('POST', `/api/content/drafts/${li.id}/schedule`, { localTime: '2020-01-01T09:00' });
    const far = await owner.req('POST', `/api/content/drafts/${li.id}/schedule`, { localTime: '2099-01-01T09:00' });
    const junk = await owner.req('POST', `/api/content/drafts/${li.id}/schedule`, { localTime: 'next tuesday' });
    check('past, too-far and unreadable times are refused with a reason (422)', past.status === 422 && /passed/.test(past.json.error ?? '') && far.status === 422 && junk.status === 422, `${past.status} ${far.status} ${junk.status}`);
    const gap = await owner.req('POST', `/api/content/drafts/${li.id}/schedule`, { localTime: '2027-03-14T02:30' });
    check('a time skipped by daylight saving is moved forward and explained', gap.status === 200 && /doesn’t exist/.test(gap.json.note ?? '') && new Date(gap.json.scheduledFor).toISOString() === '2027-03-14T07:30:00.000Z', `${gap.status} ${gap.json.note} ${gap.json.scheduledFor}`);
    const memberSched = await A.web.MEMBER!.req('POST', `/api/content/drafts/${li.id}/schedule`, { localTime: `${day}T10:00` });
    check('members cannot schedule an approved post', memberSched.status === 403);
    const re = await owner.req('POST', `/api/content/drafts/${li.id}/schedule`, { localTime: `${day}T11:30` });
    e1 = await exec(li.id, 'LINKEDIN');
    const rescheduled = e1?.events.filter((ev) => ev.from === 'SCHEDULED' && ev.to === 'SCHEDULED' && /Rescheduled/.test(ev.reason ?? ''));
    check('a user edit to the time is a recorded reschedule (Scheduled → Scheduled)', re.status === 200 && (rescheduled?.length ?? 0) >= 1 && e1?.scheduledLocal === `${day}T11:30`, `${rescheduled?.length} ${e1?.scheduledLocal}`);
    const page = await owner.req('GET', `/dashboard/content/${li.id}`);
    check('the person sees the intended local time with its offset (GMT-4/GMT-5), not their browser’s', page.status === 200 && /11:30 GMT-[45]/.test(page.text), `HTTP ${page.status}`);

    // ------------------------------------------------------------------ 2
    console.log('\n2. Execution job model & traceability');
    const detail = await owner.req('GET', `/api/executions/${e1!.id}`);
    const x = detail.json.execution;
    check(
      'the execution holds workspace, recommendation, opportunity, content, approved version, channel, provider, account, schedule, status, attempts',
      detail.status === 200 && x.workspaceId === companyId && x.trace.recommendationId === rec.id && x.trace.opportunityId === opp.id && x.contentId === li.id &&
        x.trace.approvedVersion === 1 && x.channel === 'LINKEDIN' && x.provider === 'linkedin' && x.target?.id === 'li_exec' && x.scheduledFor && x.status === 'SCHEDULED' && x.attemptCount === 0,
      JSON.stringify(x).slice(0, 300),
    );
    const chain = detail.json.chain;
    check('traceable: Business Context → Opportunity → Recommendation → Content → Approval → Execution', chain.businessContext?.revision === `rev_${STAMP}` && chain.opportunity?.id === opp.id && chain.recommendation?.id === rec.id && chain.content.id === li.id && Boolean(chain.approval) && chain.execution.id === e1!.id, JSON.stringify(chain).slice(0, 300));
    const foreign = await B.web.OWNER!.req('GET', `/api/executions/${e1!.id}`);
    const foreignList = await B.web.OWNER!.req('GET', '/api/executions');
    check('another workspace cannot see it (404, empty list)', foreign.status === 404 && foreignList.json.executions?.length === 0);

    // ------------------------------------------------------------------ 3
    console.log('\n3. Execution state machine');
    // Due: the scheduler runs it at its time (simulated by moving the time into the past).
    const notDue = await approvedDraft(companyId, ownerId, { type: 'LINKEDIN_POST', platform: 'LINKEDIN', title: 'Saturday loaves' });
    await owner.req('POST', `/api/content/drafts/${notDue.id}/schedule`, { localTime: `${day}T08:00` });
    await db.contentDraft.update({ where: { id: li.id }, data: { scheduledFor: new Date(Date.now() - 60_000) } });
    await db.execution.update({ where: { id: e1!.id }, data: { scheduledFor: new Date(Date.now() - 60_000) } });
    await runScheduledPublishes();
    e1 = await exec(li.id, 'LINKEDIN');
    const path = e1!.events.map((ev) => ev.to).join(' → ');
    const notDueExec = await exec(notDue.id, 'LINKEDIN');
    check('a due post runs: Scheduled → Queued → Executing → (provider) …, each change recorded', /SCHEDULED → QUEUED → EXECUTING → (ACTION_REQUIRED|FAILED)/.test(path), path);
    check('the scheduler records how late it ran', e1!.events.some((ev) => ev.to === 'QUEUED' && typeof (ev.detail as { lateByMs?: number }).lateByMs === 'number' && ev.actor === 'scheduler'));
    check('a post not yet due is left Scheduled', notDueExec?.status === 'SCHEDULED');
    check('the failed execution keeps the provider’s error and the attempt count', e1!.attemptCount === 1 && Boolean(e1!.errorMessage) && Boolean(e1!.errorCode) && Boolean(e1!.lastErrorAt), `${e1!.status} ${e1!.errorCode}: ${e1!.errorMessage}`);
    const liConn = await db.linkedInConnection.findUnique({ where: { companyId } });
    if (e1!.errorCode === 'unknown_outcome') {
      // LinkedIn did not answer in time: the outcome is unknown, so a person
      // checks — never retried automatically (it could post twice).
      check('LinkedIn timed out: Action required, never retried automatically', e1!.status === 'ACTION_REQUIRED' && !e1!.nextAttemptAt);
      console.log('  note    LinkedIn did not answer this run; the refused-token path was not exercised');
    } else {
      check('LinkedIn really refused the fake token → Action required (reconnect), never retried automatically', e1!.status === 'ACTION_REQUIRED' && e1!.errorCode === 'connection' && !e1!.nextAttemptAt, `${e1!.status} ${e1!.errorCode}: ${e1!.errorMessage}`);
      check('…and the LinkedIn connection is marked for reauthorization', liConn?.status === 'ERROR' || liConn?.status === 'EXPIRED', liConn?.status);
    }

    // Cancel a scheduled one; the scheduler then skips it.
    const viewerCancel = await A.web.VIEWER!.req('POST', `/api/executions/${notDueExec!.id}/cancel`, {});
    const cancel = await owner.req('POST', `/api/executions/${notDueExec!.id}/cancel`, { reason: 'Bakery closed that day' });
    const cancelled = await exec(notDue.id, 'LINKEDIN');
    const notDueDraft = await db.contentDraft.findUnique({ where: { id: notDue.id } });
    check('Scheduled → Cancelled (owners/admins only), the reason recorded, the schedule removed', viewerCancel.status === 403 && cancel.status === 200 && cancelled?.status === 'CANCELLED' && notDueDraft?.scheduledFor === null && cancelled.events.at(-1)?.reason?.includes('Bakery closed') === true, `${viewerCancel.status} ${cancel.status} ${cancelled?.status}`);
    const cancelAgain = await owner.req('POST', `/api/executions/${notDueExec!.id}/cancel`, {});
    check('cancelling twice is refused (409)', cancelAgain.status === 409);

    // A completed execution can never run again.
    const fb = await approvedDraft(companyId, ownerId, { type: 'LINKEDIN_POST', platform: 'FACEBOOK', title: 'Croissant Friday' });
    const claim = await claimPublication({ companyId, draftId: fb.id, platform: 'FACEBOOK', contentHash: await contentHash(fb), userId: ownerId });
    if (claim.claimed) await finishPublication(claim.publication.id, { status: 'PUBLISHED', url: 'https://www.facebook.com/3330003/posts/1', externalId: '3330003_1' });
    const done = await exec(fb.id, 'FACEBOOK');
    check('published by the provider → Completed, with the post id and link', done?.status === 'COMPLETED' && done.externalId === '3330003_1' && done.url?.includes('facebook.com') === true && Boolean(done.completedAt), `${done?.status}`);
    const again = await owner.req('POST', `/api/content/drafts/${fb.id}/publish`);
    const retryDone = await owner.req('POST', `/api/executions/${done!.id}/retry`);
    const cancelDone = await owner.req('POST', `/api/executions/${done!.id}/cancel`);
    const afterAgain = await exec(fb.id, 'FACEBOOK');
    check('a completed execution cannot run again (publish: already published; retry/cancel: 409)', retryDone.status === 409 && cancelDone.status === 409 && afterAgain?.status === 'COMPLETED' && afterAgain.attemptCount === done!.attemptCount && (again.status === 409 || again.json.mode === 'published'), `${again.status}/${again.json.mode} ${retryDone.status} ${cancelDone.status}`);

    // Rate limit: retried automatically with backoff, up to the limit.
    const rl = await approvedDraft(companyId, ownerId, { type: 'LINKEDIN_POST', platform: 'FACEBOOK', title: 'Sourdough Sunday' });
    const c1 = await claimPublication({ companyId, draftId: rl.id, platform: 'FACEBOOK', contentHash: await contentHash(rl), userId: ownerId });
    if (c1.claimed) await finishPublication(c1.publication.id, { status: 'MANUAL', message: 'Facebook is rate-limiting publishing right now. Try again later.' });
    let rlExec = await exec(rl.id, 'FACEBOOK');
    check('rate-limited → Failed, with an automatic retry scheduled', rlExec?.status === 'FAILED' && rlExec.errorCode === 'rate_limited' && Boolean(rlExec.nextAttemptAt), `${rlExec?.status} ${rlExec?.errorCode}`);
    await db.execution.update({ where: { id: rlExec!.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const sweep = await runExecutionSweep();
    rlExec = await exec(rl.id, 'FACEBOOK');
    check('when the backoff is over the scheduler retries it (attempt 2: Failed → Queued → Executing)', sweep.retried + sweep.retryFailed >= 1 && rlExec!.attemptCount === 2 && rlExec!.events.some((ev) => ev.from === 'FAILED' && ev.to === 'QUEUED'), `${JSON.stringify(sweep)} attempts=${rlExec!.attemptCount} ${rlExec!.status}`);

    // Retry by a person.
    const memberRetry = await A.web.MEMBER!.req('POST', `/api/executions/${e1!.id}/retry`);
    check('members cannot retry publishing (403)', memberRetry.status === 403);

    // UI reflects the state.
    const list = await owner.req('GET', '/dashboard/executions?show=all');
    check('the Publishing page shows each execution’s current state', list.status === 200 && /Action required/.test(list.text) && /Cancelled/.test(list.text) && /Published/.test(list.text) && /Publishing/.test(list.text), `HTTP ${list.status}`);
    const attention = await owner.req('GET', '/api/executions?status=ACTION_REQUIRED,FAILED');
    check('…and can be filtered by state (API)', attention.status === 200 && attention.json.executions.every((r: any) => ['ACTION_REQUIRED', 'FAILED'].includes(r.status)) && attention.json.executions.length >= 2);

    // Content changed after approval: the waiting execution is cancelled.
    const edit = await approvedDraft(companyId, ownerId, { type: 'LINKEDIN_POST', platform: 'LINKEDIN', title: 'Baguette Monday' });
    const patch = await owner.req('PATCH', `/api/content/drafts/${edit.id}`, { title: 'Baguette Monday', body: { hook: 'Changed after approval.', paragraphs: ['One.', 'Two.', 'Three.'], cta: 'Visit.', hashtags: [] } });
    const editExec = await exec(edit.id, 'LINKEDIN');
    check('approval withdrawn by an edit → the waiting execution is Cancelled (it needs approving again)', patch.status === 200 && editExec?.status === 'CANCELLED', `${patch.status} ${editExec?.status}`);

    // ------------------------------------------------------------------ 4
    console.log('\n4. Provider routing');
    const ig = await routeExecution({ companyId, platform: 'INSTAGRAM', contentType: 'IMAGE_POST' });
    check('Approved Instagram post → Meta → the Instagram account linked to the chosen Page', ig.ok && ig.provider === 'meta' && ig.target.kind === 'INSTAGRAM_ACCOUNT' && ig.target.externalId === '17841400333', JSON.stringify(ig).slice(0, 200));
    const fbr = await routeExecution({ companyId, platform: 'FACEBOOK', contentType: 'CAROUSEL' });
    check('Facebook → the chosen Page (Exec Bakery)', fbr.ok && fbr.target.name === 'Exec Bakery' && fbr.target.externalId === '3330003');
    const xr = await routeExecution({ companyId, platform: 'X', contentType: 'LINKEDIN_POST', record: { draftId: li.id, userId: ownerId } });
    const lc = await routeExecution({ companyId, platform: 'LINKEDIN', contentType: 'CAROUSEL', record: { draftId: li.id, userId: ownerId } });
    check('unsupported channel and content type are rejected before execution', !xr.ok && xr.code === 'unsupported_channel' && !lc.ok && lc.code === 'unsupported_content_type');
    await db.connection.update({ where: { id: metaConn.id }, data: { scopes: META_SCOPES.filter((s) => s !== 'instagram_content_publish') } });
    const np = await routeExecution({ companyId, platform: 'INSTAGRAM', contentType: 'IMAGE_POST', record: { draftId: li.id, userId: ownerId } });
    check('missing permission is rejected, naming it', !np.ok && np.code === 'missing_permission' && /instagram_content_publish/.test(np.message));
    await db.connection.update({ where: { id: metaConn.id }, data: { scopes: [...META_SCOPES], metadata: { ...metaMeta, igUserId: null } as Prisma.InputJsonObject } });
    const na = await routeExecution({ companyId, platform: 'INSTAGRAM', contentType: 'IMAGE_POST', record: { draftId: li.id, userId: ownerId } });
    check('no Instagram account on the chosen Page → invalid account, with the fix', !na.ok && na.code === 'invalid_account' && na.fix?.href === '/dashboard/connections/meta/setup');
    await db.connection.update({ where: { id: metaConn.id }, data: { metadata: metaMeta as Prisma.InputJsonObject } });
    const logged = await db.auditLog.count({ where: { companyId, action: 'EXECUTION_ROUTING_FAILED' } });
    check('routing failures are logged clearly (audited with the code and failed check)', logged >= 4, `${logged}`);

    // ------------------------------------------------------------------ 1
    console.log('\n1. Meta integration (Facebook + Instagram)');
    check('the Page and Instagram account are identified from the connection', ig.ok && fbr.ok);
    check('required permissions are validated (Instagram publishing needs instagram_content_publish)', !np.ok);
    for (const cap of ['paid_ads', 'messaging', 'social_listening', 'influencer_monitoring', 'autonomous_posting'] as const) {
      if (checkCapability({ connectorId: 'meta', channel: 'FACEBOOK', capability: cap, grantedScopes: [...META_SCOPES] }).allowed) check(`${cap} is blocked`, false);
    }
    check('out-of-scope capabilities are blocked (ads, DMs, listening, influencers, autonomous posting)', true);
    const metaPost = await approvedDraft(companyId, ownerId, { type: 'LINKEDIN_POST', platform: 'FACEBOOK', title: 'Pain au chocolat' });
    const pub = await owner.req('POST', `/api/content/drafts/${metaPost.id}/publish`);
    const metaExec = await exec(metaPost.id, 'FACEBOOK');
    check('a real Facebook publish with a refused token: not claimed as published, the reason kept, Action required', pub.status === 200 && pub.json.mode !== 'published' && metaExec?.status === 'ACTION_REQUIRED' && Boolean(metaExec.errorMessage), `${pub.json.mode} ${metaExec?.status}: ${metaExec?.errorMessage}`);
    check('the execution records provider, connection and the Page it went to', metaExec?.provider === 'meta' && metaExec.connectionId === metaConn.id && metaExec.targetExternalId === '3330003');

    // Organic analytics: the metrics read is mocked (no real post exists).
    const graph: typeof fetch = async (input) => {
      const url = String(input);
      if (/\/3330003_1\/insights/.test(url)) return new Response(JSON.stringify({ data: [{ name: 'post_impressions', values: [{ value: 1500 }] }, { name: 'post_impressions_unique', values: [{ value: 1100 }] }, { name: 'post_clicks', values: [{ value: 42 }] }] }), { status: 200 });
      if (/\/3330003_1\?/.test(url)) return new Response(JSON.stringify({ reactions: { summary: { total_count: 37 } }, comments: { summary: { total_count: 5 } }, shares: { count: 3 } }), { status: 200 });
      if (/me\/accounts/.test(url)) return new Response(JSON.stringify({ data: [{ id: '3330003', name: 'Exec Bakery', access_token: 'PAGE_TOKEN' }] }), { status: 200 });
      return new Response('{}', { status: 404 });
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = graph;
    let ins;
    try {
      ins = await collectMetaInsights({ companyId, fetchImpl: graph });
    } finally {
      globalThis.fetch = realFetch;
    }
    const snap = await db.performanceSnapshot.findFirst({ where: { contentDraftId: fb.id, source: 'META_API' } });
    const m = (snap?.metrics ?? {}) as Record<string, unknown>;
    check('organic analytics: engagement for a published post is stored (with the current permissions)', ins.saved >= 1 && m.likes === 37 && m.comments === 5 && m.reposts === 3 && m.detailed === false, JSON.stringify(m));
    await db.connection.update({ where: { id: metaConn.id }, data: { scopes: [...META_SCOPES, 'read_insights'] } });
    await db.performanceSnapshot.deleteMany({ where: { contentDraftId: fb.id } });
    globalThis.fetch = graph;
    try {
      ins = await collectMetaInsights({ companyId, fetchImpl: graph });
    } finally {
      globalThis.fetch = realFetch;
    }
    const snap2 = await db.performanceSnapshot.findFirst({ where: { contentDraftId: fb.id, source: 'META_API' } });
    const m2 = (snap2?.metrics ?? {}) as Record<string, unknown>;
    check('…and impressions, reach and clicks once read_insights is granted', ins.detailed >= 1 && m2.impressions === 1500 && m2.reach === 1100 && m2.clicks === 42, JSON.stringify(m2));
  } finally {
    for (const W of [A, B]) {
      await db.auditLog.deleteMany({ where: { OR: [{ companyId: W.company.id }, { userId: { in: Object.values(W.users).map((u) => u.id) } }] } });
      await db.company.delete({ where: { id: W.company.id } });
      await db.user.deleteMany({ where: { id: { in: Object.values(W.users).map((u) => u.id) } } });
    }
    console.log('\n  ok      cleanup: throwaway users and workspaces removed');
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll execution checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
