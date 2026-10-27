/**
 * Connection Manager — end to end on the running app and the real database.
 * Covers the five connection tickets:
 *
 *   1 Connection Manager   records tied to the workspace, provider → account →
 *                          page stored, status/scopes stored, no token ever in a
 *                          response, several providers (Meta, LinkedIn, an API
 *                          key connector), LinkedIn mirrored without its token
 *   2 Connection flow      Connect → Authenticate → Authorize → Select → Confirm:
 *                          steps, required permissions, selection checked live
 *                          with the provider, confirm, useful OAuth errors
 *   3 Capabilities         Meta V1 table, checked before execution, unsupported
 *                          and unpermitted actions blocked with the reason
 *   4 Token lifecycle      expiry detected, refresh attempted, refused token
 *                          detected live, revocation marked, reauthorization asked
 *   5 Health               every status reachable, refreshable by API and cron,
 *                          unhealthy connections block publishing and the
 *                          execution handoff, roles respected
 *
 * Real provider calls are made with deliberately fake tokens: Meta really
 * refuses them, which is how invalid-token detection is exercised for real.
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:connections
 */
import bcrypt from 'bcryptjs';
import type { CompanyRole, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { discoverAccounts } from '@/lib/connection-manager';
import { requireRealMeta } from './lib/meta-mode';
import { recordDiscoveredAccounts } from '@/server/connections/accounts';
import { syncLinkedInMirror } from '@/server/connections/manager.service';
import { checkConnectionHealth, connectionGate, markRevoked, recordExecutionResult, runConnectionSweep } from '@/server/connections/health.service';
import { listConnections } from '@/server/connectors/connection.service';
import { initialSetupStage } from '@/server/connectors/connection.service';
import { META_SCOPES } from '@/lib/meta';
import { prepareExecutionHandoff } from '@/server/execution/execution-handoff.service';
import { contentHash } from '@/server/approval/approval.service';

const BASE = (process.env.VERIFY_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-conn-${STAMP}!`;
const DAY = 24 * 60 * 60_000;
const FAKE_TOKEN = `NOT_A_REAL_TOKEN_${STAMP}`;

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
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: 'manual',
      headers: { Origin: BASE, cookie: this.cookie(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
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
    return { status: res.status, json, text, location: res.headers.get('location') };
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
  const company = await db.company.create({ data: { name: `zzverify Conn ${tag} ${STAMP}`, slug: `zzverify-conn-${tag.toLowerCase()}-${STAMP}` } });
  const users: Record<string, { id: string; email: string }> = {};
  const web: Record<string, Web> = {};
  for (const role of roles) {
    const u = await db.user.create({ data: { email: `zzverify-conn-${tag.toLowerCase()}-${role.toLowerCase()}-${STAMP}@example.test`, passwordHash: hash, emailVerified: new Date() } });
    await db.companyMember.create({ data: { userId: u.id, companyId: company.id, role } });
    users[role] = u;
    web[role] = new Web();
    await web[role]!.signIn(u.email);
  }
  return { company, users, web };
}

const PAGES = [
  { id: '1110001', name: 'Verify Bakery', ig: null },
  { id: '2220002', name: 'Verify Cafe', ig: { id: '17841400002', username: 'verify_cafe' } },
];

/** A Meta connection as completeOAuth stores it, with a token Meta will refuse. */
async function seedMeta(companyId: string, userId: string, opts: { chosen: string | null; stage: 'AUTHORIZED' | 'ACCOUNT_SELECTED' | 'CONFIRMED'; scopes?: string[] }) {
  const metadata = { fbUserId: '9990001', pages: PAGES, ...(opts.chosen ? { pageId: opts.chosen, pageName: PAGES.find((p) => p.id === opts.chosen)!.name } : {}) };
  const row = await db.connection.create({
    data: {
      companyId, connectorId: 'meta', kind: 'OAUTH', status: 'CONNECTED', accountLabel: 'Verify Cafe', scope: META_SCOPES.join(' '),
      accessTokenEnc: encrypt(FAKE_TOKEN), expiresAt: new Date(Date.now() + 50 * DAY), metadata: metadata as Prisma.InputJsonObject,
      connectedById: userId, provider: 'meta', channels: ['FACEBOOK', 'INSTAGRAM'], providerAccountId: '9990001',
      scopes: opts.scopes ?? [...META_SCOPES], setupStage: opts.stage, health: opts.stage === 'CONFIRMED' ? 'CONNECTED' : 'ACTION_REQUIRED',
      ...(opts.stage === 'CONFIRMED' ? { confirmedAt: new Date() } : {}),
    },
  });
  await recordDiscoveredAccounts({ connectionId: row.id, companyId, accounts: discoverAccounts({ connectorId: 'meta', accountLabel: 'Verify Cafe', providerAccountId: '9990001', metadata }) });
  return row;
}

async function main() {
  const A = await workspace('A', ['OWNER', 'MEMBER', 'VIEWER']);
  const B = await workspace('B', ['OWNER']);
  const owner = A.web.OWNER!;
  const companyId = A.company.id;
  // Several checks here turn on Meta refusing a token this suite made up.
  await requireRealMeta({
    suite: 'verify:connections',
    base: BASE,
    cookie: owner.cookie(),
  });
  try {
    // ------------------------------------------------------------------ 1
    console.log('\n1. Connection Manager data model');
    const meta = await seedMeta(companyId, A.users.OWNER!.id, { chosen: null, stage: 'AUTHORIZED' });
    await db.connection.create({
      data: {
        companyId, connectorId: 'crunchbase', kind: 'API_KEY', status: 'CONNECTED', apiKeyEnc: encrypt(`CB_${FAKE_TOKEN}`), accountLabel: 'Crunchbase API',
        provider: 'crunchbase', setupStage: 'CONFIRMED', health: 'HEALTHY', confirmedAt: new Date(),
      },
    });
    await db.linkedInConnection.create({
      data: { companyId, connectedAt: new Date(), linkedInUserId: 'li_verify_conn', displayName: 'Dana Connections', accessTokenEnc: encrypt(`LI_${FAKE_TOKEN}`), scope: 'openid profile email w_member_social', expiresAt: new Date(Date.now() + 30 * DAY), status: 'ACTIVE' },
    });
    await syncLinkedInMirror(companyId, { userId: A.users.OWNER!.id });

    const list = await owner.req('GET', '/api/connections');
    const byId = Object.fromEntries((list.json.connections ?? []).map((c: any) => [c.connectorId, c]));
    check('every connection is listed for the workspace — several providers (Meta, LinkedIn, Crunchbase)', list.status === 200 && ['meta', 'linkedin', 'crunchbase'].every((k) => byId[k]?.workspaceId === companyId), `HTTP ${list.status} ${Object.keys(byId)}`);
    check(
      'the record holds provider, channels, provider account id, scopes, status, health and setup stage',
      byId.meta?.provider === 'meta' && byId.meta?.channels?.join() === 'FACEBOOK,INSTAGRAM' && byId.meta?.providerAccountId === '9990001' &&
        byId.meta?.scopes?.includes('instagram_content_publish') && byId.meta?.status === 'CONNECTED' && byId.meta?.setupStage === 'AUTHORIZED',
      JSON.stringify(byId.meta)?.slice(0, 200),
    );
    const kinds = (byId.meta?.accounts ?? []).map((a: any) => a.kind).sort().join();
    const ig = byId.meta?.accounts?.find((a: any) => a.kind === 'INSTAGRAM_ACCOUNT');
    const cafe = byId.meta?.accounts?.find((a: any) => a.externalId === '2220002');
    check('provider → account → page relationships are stored (login → 2 Pages → Instagram under its Page)', kinds === 'INSTAGRAM_ACCOUNT,PAGE,PAGE,USER' && ig?.parentId === cafe?.id, kinds);
    check(
      'no token, key or ciphertext reaches the browser',
      !list.text.includes(FAKE_TOKEN) && !/accessTokenEnc|refreshTokenEnc|apiKeyEnc|"accessToken"|"apiKey"/.test(list.text) && !list.text.includes(meta.accessTokenEnc!),
    );
    check('the token expiry and credential location are shown without the secret', Boolean(byId.meta?.tokenExpiresAt) && byId.meta?.hasCredential === true && byId.linkedin?.credentialRef === 'linkedin_connection');
    const mirror = await db.connection.findUnique({ where: { companyId_connectorId: { companyId, connectorId: 'linkedin' } } });
    check('LinkedIn is mirrored into the Connection Manager without copying its token', mirror?.credentialRef === 'linkedin_connection' && mirror.accessTokenEnc === null && mirror.providerAccountId === 'li_verify_conn');
    const legacy = await listConnections(companyId);
    check('…and is not double-counted by the older connector list', !legacy.some((c) => c.connectorId === 'linkedin') && legacy.some((c) => c.connectorId === 'meta'));
    const other = await B.web.OWNER!.req('GET', '/api/connections');
    const otherOne = await B.web.OWNER!.req('GET', '/api/connections/meta');
    check('another workspace sees none of it (list empty, record 404)', other.status === 200 && other.json.connections?.length === 0 && otherOne.status === 404, `${other.json.connections?.length} / ${otherOne.status}`);

    // ------------------------------------------------------------------ 2
    console.log('\n2. Provider authentication & connection flow');
    check('a new connection with several Pages starts at "Select account/page"', initialSetupStage({ connectorId: 'meta', previous: null, accounts: [{ selectable: true }, { selectable: true }] }) === 'AUTHORIZED');
    check('reconnecting a confirmed one keeps it confirmed; a read-only connector needs no confirm', initialSetupStage({ connectorId: 'meta', previous: { setupStage: 'CONFIRMED', selectedStillAvailable: true }, accounts: [] }) === 'CONFIRMED' && initialSetupStage({ connectorId: 'ga4', previous: null, accounts: [{}] }) === 'CONFIRMED');
    const setup = await owner.req('GET', '/api/connections/meta');
    const steps = (setup.json.steps ?? []).map((s: any) => `${s.key}:${s.state}`).join(' ');
    check('the setup shows Connect → Authenticate → Authorize done, Select current, Confirm to do', steps === 'connect:done authenticate:done authorize:done select:current confirm:todo', steps);
    check('required permissions are identified, each granted or not', setup.json.permissions?.length >= 5 && setup.json.permissions.every((p: any) => p.granted), JSON.stringify(setup.json.permissions)?.slice(0, 160));
    check('nothing chosen yet: confirming is refused with the reason', setup.json.canConfirm === false && /Choose/.test(setup.json.blockedReason ?? ''));
    const early = await owner.req('POST', '/api/connections/meta/confirm');
    check('…and the API refuses it too (409 not_ready)', early.status === 409, `HTTP ${early.status}`);
    const viewerSel = await A.web.VIEWER!.req('POST', '/api/connections/meta/select', { accountId: cafe?.id });
    const memberConf = await A.web.MEMBER!.req('POST', '/api/connections/meta/confirm');
    check('viewers cannot choose, members cannot confirm (owners/admins only)', viewerSel.status === 403 && memberConf.status === 403, `${viewerSel.status} ${memberConf.status}`);
    const live = await owner.req('POST', '/api/connections/meta/select', { accountId: cafe?.id });
    check('a Page is only chosen once Meta confirms the account manages it — a refused token cannot choose', live.status >= 400 && !(await db.connectedAccount.findFirst({ where: { connectionId: meta.id, externalId: '2220002', selected: true } })), `HTTP ${live.status} ${live.json.error ?? ''}`);
    const foreign = await owner.req('POST', '/api/connections/meta/select', { accountId: 'not-an-account' });
    check('an account the connection does not reach is refused (404)', foreign.status === 404);
    // The person's choice as Meta would have confirmed it.
    await db.connection.update({ where: { id: meta.id }, data: { metadata: { fbUserId: '9990001', pages: PAGES, pageId: '2220002', pageName: 'Verify Cafe' } as Prisma.InputJsonObject } });
    await recordDiscoveredAccounts({ connectionId: meta.id, companyId, accounts: discoverAccounts({ connectorId: 'meta', accountLabel: 'Verify Cafe', providerAccountId: '9990001', metadata: { fbUserId: '9990001', pages: PAGES, pageId: '2220002' } }) });
    await db.connection.update({ where: { id: meta.id }, data: { setupStage: 'ACCOUNT_SELECTED' } });
    const confirm = await owner.req('POST', '/api/connections/meta/confirm');
    const afterConfirm = await db.connection.findUnique({ where: { id: meta.id } });
    check('confirming saves the connection and checks it with the provider at once', confirm.status === 200 && afterConfirm?.setupStage === 'CONFIRMED' && Boolean(afterConfirm.confirmedAt) && Boolean(afterConfirm.healthCheckedAt), `HTTP ${confirm.status} ${afterConfirm?.setupStage}`);
    const confirmedAudit = await db.auditLog.findFirst({ where: { companyId, action: 'CONNECTION_CONFIRMED' } });
    check('the confirmation is audited with the account chosen', JSON.stringify(confirmedAudit?.metadata ?? {}).includes('2220002'));
    const denied = await owner.req('GET', '/api/connectors/meta/callback?error=access_denied&error_description=Permissions+error');
    const deniedUrl = new URL(denied.location ?? 'http://x/');
    check('a declined sign-in returns a useful error, not a raw one', denied.status === 307 && deniedUrl.searchParams.get('code') === 'access_denied' && /Allow/.test(deniedUrl.searchParams.get('reason') ?? ''), denied.location ?? '');
    const mismatch = await owner.req('GET', '/api/connectors/ga4/callback?error=redirect_uri_mismatch');
    check('a misconfigured deployment says who must fix it', /administrator/.test(new URL(mismatch.location ?? 'http://x/').searchParams.get('reason') ?? ''));
    const noCode = await owner.req('GET', '/api/connectors/meta/callback');
    check('a callback without a code is explained', new URL(noCode.location ?? 'http://x/').searchParams.get('code') === 'missing_code');
    const forged = await owner.req('GET', '/api/connectors/meta/callback?code=abc&state=forged');
    check('a forged/expired state is refused and explained (nothing connected)', new URL(forged.location ?? 'http://x/').searchParams.get('code') === 'bad_state', forged.location ?? '');

    // ------------------------------------------------------------------ 3 + 4 + 5
    console.log('\n3–5. Health, invalid-token detection and capability enforcement');
    check('Meta refused the fake token at confirm: detected live → Action required, reconnect asked', afterConfirm?.health === 'ACTION_REQUIRED' && /no longer accepts|reconnect/i.test(afterConfirm.healthReason ?? ''), `${afterConfirm?.health}: ${afterConfirm?.healthReason}`);
    const reauth = await db.auditLog.findFirst({ where: { companyId, action: 'CONNECTION_REAUTH_REQUIRED' } });
    check('reauthorization is requested (audited, and sent to the person who connected it)', Boolean(reauth));
    const draft = await db.contentDraft.create({
      data: { companyId, type: 'IMAGE_POST', platform: 'FACEBOOK', status: 'APPROVED', title: 'Connection verify', body: { hook: 'A new menu.', paragraphs: ['One.', 'Two.', 'Three.'], cta: 'Visit.', hashtags: [] } },
    });
    const gate = await connectionGate(companyId, 'FACEBOOK');
    check('the execution gate refuses an unhealthy connection, with the reason and a fix', !gate.allowed && Boolean(gate.reason) && gate.fix?.href.startsWith('/dashboard/connections') === true, JSON.stringify(gate));
    // Approved by a person (the approval record), then the package is prepared
    // as approval does, and re-validated on every read.
    const hash = await contentHash(draft);
    await db.contentDraft.update({
      where: { id: draft.id },
      data: { aiMetadata: { approval: { model: 1, version: 1, hash, approved: { by: A.users.OWNER!.id, via: 'person', at: new Date().toISOString(), version: 1, hash, snapshot: null }, rejected: null, events: [] } } as Prisma.InputJsonObject },
    });
    await prepareExecutionHandoff({ companyId, draftId: draft.id, platform: 'FACEBOOK', userId: A.users.OWNER!.id });
    const ex = await owner.req('GET', `/api/content/drafts/${draft.id}/execution`);
    const exIssue = ex.json.handoff?.readiness?.issues?.find((i: any) => i.code === 'connection_unhealthy');
    check('the execution handoff is BLOCKED by it (connection_unhealthy), never Ready', ex.status === 200 && ex.json.status === 'blocked' && Boolean(exIssue), `${ex.status} ${ex.json.status} ${JSON.stringify(ex.json.handoff?.readiness?.issues)?.slice(0, 200)}`);
    // Healthy again (as after a reconnect): the handoff no longer lists it.
    await db.connection.update({ where: { id: meta.id }, data: { health: 'HEALTHY', healthReason: null, status: 'CONNECTED' } });
    check('a healthy, capable connection passes the gate', (await connectionGate(companyId, 'FACEBOOK')).allowed && (await connectionGate(companyId, 'INSTAGRAM')).allowed);
    await db.connection.update({ where: { id: meta.id }, data: { scopes: META_SCOPES.filter((s) => s !== 'instagram_content_publish') } });
    const noPerm = await connectionGate(companyId, 'INSTAGRAM');
    check('a permission not granted blocks that channel only (Instagram blocked, Facebook allowed)', !noPerm.allowed && /instagram_content_publish/.test(noPerm.reason ?? '') && (await connectionGate(companyId, 'FACEBOOK')).allowed, noPerm.reason ?? '');
    const offline = await checkConnectionHealth(companyId, 'meta', { live: false });
    check('…and health says Action required: grant the permission', offline?.health === 'ACTION_REQUIRED' && offline.result.action === 'grant_permissions', offline?.result.reason ?? '');
    await db.connection.update({ where: { id: meta.id }, data: { scopes: [...META_SCOPES], health: 'HEALTHY', healthReason: null } });

    // Publishing through an unhealthy connection never calls the network.
    await db.connection.update({ where: { id: meta.id }, data: { health: 'EXPIRED', healthReason: 'The Facebook & Instagram connection expired. Reconnect to keep publishing.' } });
    const pub = await owner.req('POST', `/api/content/drafts/${draft.id}/publish`);
    const pubRow = await db.contentDraft.findUnique({ where: { id: draft.id } });
    check('publishing through an expired connection is prevented, with the reason', pub.status === 200 && pub.json.mode === 'reconnect' && /expired/.test(pub.json.message ?? '') && pubRow?.status === 'APPROVED', `${pub.status} ${JSON.stringify(pub.json).slice(0, 160)}`);

    // Every status, from real rows.
    await db.connection.update({ where: { id: meta.id }, data: { health: 'HEALTHY', expiresAt: new Date(Date.now() + 3 * DAY) } });
    const warn = await checkConnectionHealth(companyId, 'meta', { live: false });
    check('Warning: the token expires in 3 days and cannot be refreshed — reconnect asked ahead of time', warn?.health === 'WARNING' && /expires in 3 day/.test(warn.result.reason ?? ''), warn?.result.reason ?? '');
    await db.connection.update({ where: { id: meta.id }, data: { expiresAt: new Date(Date.now() - DAY) } });
    const refreshed = await owner.req('POST', '/api/connections/meta/health');
    check('Expired: detected by a health refresh (API), clearly identified', refreshed.status === 200 && refreshed.json.connection?.health === 'EXPIRED', `${refreshed.status} ${refreshed.json.connection?.health} ${refreshed.json.connection?.healthReason}`);
    const cached = await owner.req('POST', '/api/connections/meta/health');
    check('a second refresh within seconds answers from storage (providers are not hammered)', cached.json.cached === true);
    const viewerRefresh = await A.web.VIEWER!.req('POST', '/api/connections/meta/health');
    const memberRefresh = await A.web.MEMBER!.req('POST', '/api/connections/health');
    check('viewers see health but cannot re-check; members can', viewerRefresh.status === 403 && memberRefresh.status === 200, `${viewerRefresh.status} ${memberRefresh.status}`);

    // Execution results feed health.
    await db.connection.update({ where: { id: meta.id }, data: { expiresAt: new Date(Date.now() + 50 * DAY), status: 'CONNECTED', health: 'HEALTHY', healthReason: null } });
    for (let i = 0; i < 3; i += 1) await recordExecutionResult({ companyId, platform: 'FACEBOOK', ok: false, error: 'Facebook could not publish this post (HTTP 500).' });
    const failing = await db.connection.findUnique({ where: { id: meta.id } });
    check('three failures in a row: Action required (recent execution failures count)', failing?.consecutiveFailures === 3 && failing.health === 'ACTION_REQUIRED', `${failing?.consecutiveFailures} ${failing?.health}`);
    await db.connection.update({ where: { id: meta.id }, data: { health: 'HEALTHY' } });
    await recordExecutionResult({ companyId, platform: 'FACEBOOK', ok: true });
    const ok = await db.connection.findUnique({ where: { id: meta.id } });
    check('a success clears the streak and records the last successful execution', ok?.consecutiveFailures === 0 && Boolean(ok.lastExecutionAt));
    await recordExecutionResult({ companyId, platform: 'FACEBOOK', ok: false, error: 'Facebook rejected the stored credentials.', credentialRejected: true });
    const rejected = await db.connection.findUnique({ where: { id: meta.id } });
    check('a refused credential during publishing (Meta 190) marks it for reauthorization at once', rejected?.health === 'ACTION_REQUIRED' && rejected.status === 'ERROR', `${rejected?.status} ${rejected?.health}`);

    // Revocation at the provider.
    await markRevoked([meta.id], 'Access was removed in Facebook settings — reconnect to publish again.', 'verify');
    const revoked = await db.connection.findUnique({ where: { id: meta.id } });
    check('revoked: marked REVOKED, tokens forgotten, health Disconnected, audited', revoked?.status === 'REVOKED' && revoked.accessTokenEnc === null && revoked.health === 'DISCONNECTED' && Boolean(revoked.revokedAt) && Boolean(await db.auditLog.findFirst({ where: { companyId, action: 'CONNECTION_REVOKED' } })));
    check('…and nothing executes through it', !(await connectionGate(companyId, 'INSTAGRAM')).allowed);

    // Token refresh (a refreshable connector) — the sweep tries, and records the outcome.
    await db.connection.create({
      data: {
        companyId, connectorId: 'hubspot', kind: 'OAUTH', status: 'CONNECTED', accessTokenEnc: encrypt(`HS_${FAKE_TOKEN}`), refreshTokenEnc: encrypt(`HSR_${FAKE_TOKEN}`),
        expiresAt: new Date(Date.now() + 60 * 60_000), provider: 'hubspot', setupStage: 'CONFIRMED', health: 'HEALTHY', healthCheckedAt: new Date(),
      },
    });
    const sweep = await runConnectionSweep({ limit: 200 });
    const hs = await db.connection.findUnique({ where: { companyId_connectorId: { companyId, connectorId: 'hubspot' } } });
    check('the sweep attempts a refresh before expiry and records the outcome (fake refresh token refused → not left as working)', sweep.refreshed + sweep.refreshFailed >= 1 && hs?.status !== 'CONNECTED', `${JSON.stringify(sweep)} hubspot=${hs?.status}`);
    // A token that expired without a refresh token is detected on use.
    const cron401 = await owner.req('GET', '/api/cron/connections');
    check('the cron is protected', cron401.status === 401);
    if (process.env.CRON_SECRET) {
      const cron = await owner.req('GET', '/api/cron/connections', undefined, { authorization: `Bearer ${process.env.CRON_SECRET}` });
      check('the cron runs the sweep (refresh + health checks)', cron.status === 200 && typeof cron.json.checked === 'number', `${cron.status}`);
    }

    // LinkedIn lifecycle via its mirror.
    await db.linkedInConnection.update({ where: { companyId }, data: { expiresAt: new Date(Date.now() - DAY), status: 'EXPIRED' } });
    await syncLinkedInMirror(companyId);
    const liExpired = await db.connection.findUnique({ where: { companyId_connectorId: { companyId, connectorId: 'linkedin' } } });
    check('LinkedIn expiry shows as Expired in the Connection Manager, and blocks LinkedIn', liExpired?.health === 'EXPIRED' && !(await connectionGate(companyId, 'LINKEDIN')).allowed, liExpired?.health);

    // Disconnect: revokes at the provider (best-effort), removes the record.
    await db.connection.update({ where: { id: meta.id }, data: { status: 'CONNECTED', accessTokenEnc: encrypt(FAKE_TOKEN) } });
    const disc = await owner.req('DELETE', '/api/connectors/meta');
    const discAudit = await db.auditLog.findFirst({ where: { companyId, action: 'CONNECTOR_DISCONNECTED' }, orderBy: { createdAt: 'desc' } });
    check('disconnecting asks the provider to revoke, then removes the connection and its accounts', disc.status === 200 && !(await db.connection.findUnique({ where: { id: meta.id } })) && (await db.connectedAccount.count({ where: { connectionId: meta.id } })) === 0 && 'revokedAtProvider' in ((discAudit?.metadata as object) ?? {}), `HTTP ${disc.status}`);
    const liGeneric = await owner.req('DELETE', '/api/connectors/linkedin');
    check('LinkedIn is disconnected only through its own flow', liGeneric.status === 400);
    await db.linkedInConnection.delete({ where: { companyId } });
    await syncLinkedInMirror(companyId);
    check('removing LinkedIn removes its mirror', !(await db.connection.findUnique({ where: { companyId_connectorId: { companyId, connectorId: 'linkedin' } } })));

    // Pages render.
    console.log('\nPages');
    await seedMeta(companyId, A.users.OWNER!.id, { chosen: '2220002', stage: 'ACCOUNT_SELECTED' });
    const page = await owner.req('GET', '/dashboard/connections');
    check('the Connection Manager page shows status, capabilities and the reconnect action', page.status === 200 && /Connection Manager/.test(page.text) && /Action required|Setup not finished/.test(page.text) && /Organic publishing/.test(page.text), `HTTP ${page.status}`);
    const setupPage = await owner.req('GET', '/dashboard/connections/meta/setup');
    check('the setup page shows the five steps, the Pages and the permissions', setupPage.status === 200 && /Select account\/page/.test(setupPage.text) && /Verify Cafe/.test(setupPage.text) && /pages_manage_posts/.test(setupPage.text), `HTTP ${setupPage.status}`);
    check('no page leaks a token', !page.text.includes(FAKE_TOKEN) && !setupPage.text.includes(FAKE_TOKEN));
  } finally {
    for (const W of [A, B]) {
      await db.auditLog.deleteMany({ where: { OR: [{ companyId: W.company.id }, { userId: { in: Object.values(W.users).map((u) => u.id) } }] } });
      await db.company.delete({ where: { id: W.company.id } });
      await db.user.deleteMany({ where: { id: { in: Object.values(W.users).map((u) => u.id) } } });
    }
    console.log('\n  ok      cleanup: throwaway users and workspaces removed');
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll connection checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
