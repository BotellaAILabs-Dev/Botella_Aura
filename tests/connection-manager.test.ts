import { describe, it, expect } from 'vitest';

import {
  discoverAccounts,
  hasAccountChoice,
  NOT_MIRRORED,
  parseScopes,
  providerFamily,
  connectorChannels,
  toConnectionRecord,
} from '@/lib/connection-manager';
import {
  capabilityMatrix,
  checkCapability,
  executorFor,
  missingRequiredScopes,
  providerCapabilities,
  requiredScopes,
} from '@/lib/capabilities';
import { evaluateHealth, executionAllowed, healthBlocksExecution, type HealthFacts } from '@/lib/connection-health';
import { classifyProviderError, describeAuthFailure, isCredentialRejection } from '@/lib/connection-errors';
import { grantedFrom, META_SCOPES } from '@/lib/meta';

/**
 * Connection Manager (Sprint 10 connection tickets): the provider-agnostic
 * model, the capability framework, health evaluation, the token lifecycle's
 * decisions and the connection flow's error messages. Pure — the server
 * services are exercised end to end by scripts/verify-connections.ts.
 */

const META_PUBLISH = [...META_SCOPES];

describe('Connection Manager data model', () => {
  it('normalises provider, channels and scopes for every connector', () => {
    expect(providerFamily('ga4')).toBe('google');
    expect(providerFamily('search-console')).toBe('google');
    expect(providerFamily('meta')).toBe('meta');
    expect(connectorChannels('meta')).toEqual(['FACEBOOK', 'INSTAGRAM']);
    expect(connectorChannels('linkedin')).toEqual(['LINKEDIN']);
    expect(parseScopes('openid profile, w_member_social  openid')).toEqual(['openid', 'profile', 'w_member_social']);
    expect(parseScopes(null)).toEqual([]);
    expect(NOT_MIRRORED).toEqual({ connectorId: { notIn: ['linkedin'] } });
  });

  it('never exposes a token: the browser view has no encrypted fields', () => {
    const now = new Date('2026-10-17T00:00:00Z');
    const record = toConnectionRecord({
      id: 'c1', companyId: 'co1', connectorId: 'meta', kind: 'OAUTH', status: 'CONNECTED', accountLabel: '@cafe (Cafe)',
      scope: 'pages_show_list', accessTokenEnc: 'SECRET-CIPHERTEXT', refreshTokenEnc: 'SECRET-REFRESH', apiKeyEnc: null,
      expiresAt: now, connectedById: 'u1', provider: 'meta', channels: ['FACEBOOK', 'INSTAGRAM'], providerAccountId: 'fb1',
      scopes: ['pages_show_list'], credentialRef: 'self', setupStage: 'CONFIRMED', health: 'HEALTHY', healthReason: null,
      healthCheckedAt: now, lastHealthyAt: now, lastExecutionAt: null, lastExecutionError: null, lastExecutionFailedAt: null,
      consecutiveFailures: 0, capabilities: {}, confirmedAt: now, revokedAt: null, createdAt: now,
      accounts: [{ id: 'a1', kind: 'PAGE', externalId: '111', name: 'Cafe', parentId: null, channel: 'FACEBOOK', selectable: true, selected: true, lastSeenAt: now }],
    });
    const json = JSON.stringify(record);
    expect(json).not.toContain('SECRET');
    expect(json).not.toMatch(/accessToken|refreshToken|apiKey/);
    expect(record).toMatchObject({ workspaceId: 'co1', provider: 'meta', hasCredential: true, health: 'HEALTHY', providerAccountId: 'fb1' });
    expect(record.accounts[0]).toMatchObject({ kind: 'PAGE', selected: true });
  });

  it('LinkedIn’s mirror says where its credential lives, without holding it', () => {
    const now = new Date();
    const record = toConnectionRecord({
      id: 'c2', companyId: 'co1', connectorId: 'linkedin', kind: 'OAUTH', status: 'CONNECTED', accountLabel: 'Robin', scope: 'w_member_social',
      accessTokenEnc: null, refreshTokenEnc: null, apiKeyEnc: null, expiresAt: null, connectedById: null, provider: 'linkedin',
      channels: ['LINKEDIN'], providerAccountId: 'li1', scopes: [], credentialRef: 'linkedin_connection', setupStage: 'CONFIRMED',
      health: 'CONNECTED', healthReason: null, healthCheckedAt: null, lastHealthyAt: null, lastExecutionAt: null, lastExecutionError: null,
      lastExecutionFailedAt: null, consecutiveFailures: 0, capabilities: {}, confirmedAt: now, revokedAt: null, createdAt: now,
    });
    expect(record.hasCredential).toBe(true);
    expect(record.credentialRef).toBe('linkedin_connection');
    expect(record.scopes).toEqual(['w_member_social']); // falls back to the raw scope string
  });

  it('stores the provider → account → page relationships (Meta: login → Pages → Instagram)', () => {
    const accounts = discoverAccounts({
      connectorId: 'meta',
      accountLabel: '@cafe (Cafe)',
      metadata: {
        fbUserId: 'fb1',
        pageId: '222',
        pages: [
          { id: '111', name: 'Bakery', ig: null },
          { id: '222', name: 'Cafe', ig: { id: 'ig2', username: 'cafe' } },
        ],
      },
    });
    expect(accounts.map((a) => `${a.kind}:${a.externalId}:${a.parentKey ?? '-'}:${a.selected ? 'sel' : ''}`)).toEqual([
      'USER:fb1:-:sel',
      'PAGE:111:USER:fb1:',
      'PAGE:222:USER:fb1:sel',
      'INSTAGRAM_ACCOUNT:ig2:PAGE:222:sel',
    ]);
    expect(hasAccountChoice(accounts)).toBe(true);
    expect(hasAccountChoice(accounts.filter((a) => a.externalId !== '111'))).toBe(false);
  });

  it('other providers: the one account (LinkedIn member, GA4 property, HubSpot portal)', () => {
    expect(discoverAccounts({ connectorId: 'linkedin', accountLabel: 'Robin', providerAccountId: 'li1', metadata: {} })).toEqual([
      expect.objectContaining({ kind: 'LINKEDIN_MEMBER', externalId: 'li1', channel: 'LINKEDIN', selected: true }),
    ]);
    expect(discoverAccounts({ connectorId: 'linkedin', accountLabel: 'Robin', providerAccountId: 'li1', metadata: {}, orgUrn: 'urn:li:organization:9' })).toHaveLength(2);
    expect(discoverAccounts({ connectorId: 'ga4', accountLabel: 'Site property', metadata: {} })[0]).toMatchObject({ kind: 'PROPERTY', selected: true });
    expect(discoverAccounts({ connectorId: 'hubspot', accountLabel: 'Portal 9', metadata: {} })[0]).toMatchObject({ kind: 'PORTAL' });
    expect(discoverAccounts({ connectorId: 'ga4', accountLabel: null, metadata: {} })).toEqual([]);
  });
});

describe('Provider Capability Framework — Meta V1', () => {
  const meta = (channel: string, capability: Parameters<typeof checkCapability>[0]['capability']) =>
    checkCapability({ connectorId: 'meta', channel, capability, grantedScopes: META_PUBLISH, health: 'HEALTHY' });

  it('matches the ticket’s table', () => {
    expect(providerCapabilities('meta')?.version).toBe('Meta V1');
    expect(meta('FACEBOOK', 'organic_publishing')).toMatchObject({ allowed: true, level: 'supported' });
    expect(meta('INSTAGRAM', 'organic_publishing')).toMatchObject({ allowed: true, level: 'supported' });
    expect(meta('FACEBOOK', 'scheduling')).toMatchObject({ allowed: true, level: 'supported' });
    // "Supported where the API allows": Instagram has no API scheduling — Aura holds the post.
    expect(meta('INSTAGRAM', 'scheduling')).toMatchObject({ allowed: true, level: 'limited' });
    expect(meta('INSTAGRAM', 'scheduling').reason).toMatch(/no scheduling/);
    for (const cap of ['paid_ads', 'messaging', 'social_listening', 'influencer_monitoring'] as const) {
      expect(meta('FACEBOOK', cap)).toMatchObject({ allowed: false, level: 'unsupported' });
      expect(meta('INSTAGRAM', cap).allowed).toBe(false);
    }
    expect(meta('FACEBOOK', 'autonomous_posting')).toMatchObject({ allowed: false, level: 'out_of_scope' });
    expect(meta('FACEBOOK', 'autonomous_posting').reason).toMatch(/initial scope/);
  });

  it('organic analytics: per-post engagement with the current permissions; impressions/reach say they need insights', () => {
    const fb = meta('FACEBOOK', 'organic_analytics');
    expect(fb).toMatchObject({ allowed: true, level: 'supported' });
    expect(meta('INSTAGRAM', 'organic_analytics').allowed).toBe(true);
    // Without the Page read permission, not even engagement can be read.
    expect(checkCapability({ connectorId: 'meta', channel: 'FACEBOOK', capability: 'organic_analytics', grantedScopes: ['pages_manage_posts'] }).allowed).toBe(false);
    expect(capabilityMatrix('meta', META_PUBLISH, ['FACEBOOK']).find((r) => r.capability === 'organic_analytics')?.note).toMatch(/read_insights/);
  });

  it('an unsupported action is blocked with an explanation, never silently', () => {
    const r = checkCapability({ connectorId: 'meta', channel: 'INSTAGRAM', capability: 'messaging' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('Meta V1 does not read or answer DMs.');
    const unknown = checkCapability({ connectorId: 'ga4', channel: null, capability: 'paid_ads' });
    expect(unknown).toMatchObject({ allowed: false, level: 'unknown' });
    expect(unknown.reason).toMatch(/doesn’t offer paid ads/);
  });

  it('checks permissions before execution', () => {
    const r = checkCapability({ connectorId: 'meta', channel: 'INSTAGRAM', capability: 'organic_publishing', grantedScopes: ['pages_show_list', 'pages_read_engagement', 'instagram_basic'] });
    expect(r).toMatchObject({ allowed: false, missingScopes: ['instagram_content_publish'] });
    expect(r.fix?.href).toBe('/dashboard/connections/meta/setup');
    // Unknown grants are not held against a connection.
    expect(checkCapability({ connectorId: 'meta', channel: 'INSTAGRAM', capability: 'organic_publishing', grantedScopes: null }).allowed).toBe(true);
  });

  it('checks health before execution', () => {
    const r = checkCapability({ connectorId: 'meta', channel: 'FACEBOOK', capability: 'organic_publishing', grantedScopes: META_PUBLISH, health: 'EXPIRED', healthReason: 'The Facebook & Instagram connection expired.' });
    expect(r).toMatchObject({ allowed: false, reason: 'The Facebook & Instagram connection expired.' });
    expect(checkCapability({ connectorId: 'meta', channel: 'FACEBOOK', capability: 'organic_publishing', grantedScopes: META_PUBLISH, health: 'WARNING' }).allowed).toBe(true);
  });

  it('LinkedIn: member OR organisation posting permission', () => {
    const li = (scopes: string[]) => checkCapability({ connectorId: 'linkedin', channel: 'LINKEDIN', capability: 'organic_publishing', grantedScopes: scopes });
    expect(li(['openid', 'w_member_social']).allowed).toBe(true);
    expect(li(['w_organization_social']).allowed).toBe(true);
    expect(li(['openid', 'profile']).missingScopes).toEqual(['w_member_social or w_organization_social']);
    expect(missingRequiredScopes('linkedin', ['openid'])).toEqual(['w_member_social or w_organization_social']);
  });

  it('data connectors read and never publish', () => {
    expect(checkCapability({ connectorId: 'ga4', capability: 'data_read' }).allowed).toBe(true);
    expect(checkCapability({ connectorId: 'ga4', capability: 'organic_publishing' })).toMatchObject({ allowed: false, level: 'unsupported' });
    expect(requiredScopes('ga4')).toEqual({ all: [], anyOf: [] });
  });

  it('stored per provider and channel: the matrix the UI shows', () => {
    const rows = capabilityMatrix('meta', META_PUBLISH, ['INSTAGRAM']);
    expect(new Set(rows.map((r) => r.channel))).toEqual(new Set(['INSTAGRAM']));
    expect(rows.find((r) => r.capability === 'organic_publishing')).toMatchObject({ available: true });
    expect(rows.find((r) => r.capability === 'organic_analytics')).toMatchObject({ available: true });
    expect(rows.find((r) => r.capability === 'organic_analytics')?.note).toMatch(/instagram_manage_insights/);
    expect(rows.find((r) => r.capability === 'paid_ads')).toMatchObject({ available: false, level: 'unsupported' });
  });

  it('maps each platform to its executing connection', () => {
    expect(executorFor('INSTAGRAM')).toEqual({ connectorId: 'meta', channel: 'INSTAGRAM' });
    expect(executorFor('LINKEDIN')).toEqual({ connectorId: 'linkedin', channel: 'LINKEDIN' });
    expect(executorFor('X')).toBeNull();
  });

  it('Meta’s requested scopes cover every core capability', () => {
    expect(missingRequiredScopes('meta', META_PUBLISH)).toEqual([]);
  });
});

describe('Connection health', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const base: HealthFacts = {
    status: 'CONNECTED',
    setupStage: 'CONFIRMED',
    hasCredential: true,
    expiresAt: new Date('2026-12-01T00:00:00Z'),
    refreshable: false,
    missingScopes: [],
    providerCheck: 'ok',
    accountAvailable: true,
    consecutiveFailures: 0,
    lastExecutionFailedAt: null,
    label: 'Facebook & Instagram',
  };
  const h = (over: Partial<HealthFacts>) => evaluateHealth({ ...base, ...over }, now);

  it('Healthy when every check passes; Connected when not checked yet', () => {
    expect(h({}).health).toBe('HEALTHY');
    expect(h({}).checks.every((c) => c.ok)).toBe(true);
    expect(h({ providerCheck: null, accountAvailable: null }).health).toBe('CONNECTED');
  });

  it('Warning: works, but expiring soon / provider briefly down / a recent failure', () => {
    const expiring = h({ expiresAt: new Date('2026-10-20T00:00:00Z') });
    expect(expiring).toMatchObject({ health: 'WARNING', action: 'reconnect' });
    expect(expiring.reason).toMatch(/expires in 3 day/);
    // A refreshable token is renewed automatically: no warning.
    expect(h({ expiresAt: new Date('2026-10-17T13:00:00Z'), refreshable: true }).health).toBe('HEALTHY');
    expect(h({ providerCheck: 'unreachable' })).toMatchObject({ health: 'WARNING', action: 'retry_later' });
    expect(h({ consecutiveFailures: 1, lastExecutionFailedAt: new Date('2026-10-17T11:00:00Z'), lastExecutionError: 'rate limited' }).health).toBe('WARNING');
    // An old failure no longer counts.
    expect(h({ consecutiveFailures: 1, lastExecutionFailedAt: new Date('2026-10-10T00:00:00Z') }).health).toBe('HEALTHY');
  });

  it('Expired: the token expired and cannot be refreshed', () => {
    expect(h({ expiresAt: new Date('2026-10-17T11:00:00Z') })).toMatchObject({ health: 'EXPIRED', action: 'reconnect' });
    expect(h({ status: 'EXPIRED' }).health).toBe('EXPIRED');
  });

  it('Disconnected: removed here or revoked at the provider', () => {
    expect(h({ status: 'DISCONNECTED' }).health).toBe('DISCONNECTED');
    const revoked = h({ status: 'REVOKED', hasCredential: false });
    expect(revoked).toMatchObject({ health: 'DISCONNECTED', action: 'reconnect' });
    expect(revoked.reason).toMatch(/removed at Facebook & Instagram/);
  });

  it('Action required: invalid token, missing permission, account gone, setup unfinished, repeated failures', () => {
    expect(h({ providerCheck: 'rejected' })).toMatchObject({ health: 'ACTION_REQUIRED', action: 'reconnect' });
    expect(h({ missingScopes: ['pages_manage_posts'] })).toMatchObject({ health: 'ACTION_REQUIRED', action: 'grant_permissions' });
    expect(h({ accountAvailable: false })).toMatchObject({ health: 'ACTION_REQUIRED', action: 'select_account' });
    expect(h({ setupStage: 'AUTHORIZED' })).toMatchObject({ health: 'ACTION_REQUIRED', action: 'select_account' });
    expect(h({ setupStage: 'ACCOUNT_SELECTED' })).toMatchObject({ health: 'ACTION_REQUIRED', action: 'finish_setup' });
    expect(h({ hasCredential: false })).toMatchObject({ health: 'ACTION_REQUIRED', action: 'reconnect' });
    expect(h({ consecutiveFailures: 3, lastExecutionFailedAt: new Date('2026-10-17T11:59:00Z') })).toMatchObject({ health: 'ACTION_REQUIRED', action: 'review_failures' });
  });

  it('each check is reported (token, permissions, provider, account, executions)', () => {
    const r = h({ missingScopes: ['instagram_content_publish'], providerCheck: 'unreachable' });
    const byKey = Object.fromEntries(r.checks.map((c) => [c.key, c]));
    expect(byKey.permissions).toMatchObject({ ok: false, detail: 'Missing: instagram_content_publish.' });
    expect(byKey.provider!.ok).toBe(false);
    expect(byKey.token!.ok).toBe(true);
  });

  it('execution goes through Connected, Healthy and Warning only', () => {
    expect(['CONNECTED', 'HEALTHY', 'WARNING'].map((s) => healthBlocksExecution(s as never))).toEqual([false, false, false]);
    expect(['EXPIRED', 'DISCONNECTED', 'ACTION_REQUIRED'].map((s) => healthBlocksExecution(s as never))).toEqual([true, true, true]);
    expect(executionAllowed('EXPIRED', null, 'LinkedIn')).toEqual({ allowed: false, reason: 'The LinkedIn connection is expired — fix it in Connections.' });
  });
});

describe('Token & credential lifecycle — detection', () => {
  it('recognises a refused credential (Meta 190, HTTP 401)', () => {
    expect(isCredentialRejection(400, 190)).toBe(true);
    expect(isCredentialRejection(401)).toBe(true);
    expect(isCredentialRejection(403, 200)).toBe(false);
    expect(isCredentialRejection(429, 4)).toBe(false);
  });

  it('classifies provider failures: refused vs unreachable vs account gone', () => {
    expect(classifyProviderError('Meta rejected the credentials (HTTP 400). {"error":{"type":"OAuthException","code":190}}')).toBe('rejected');
    expect(classifyProviderError('Google Analytics rejected the credentials (HTTP 401). ')).toBe('rejected');
    expect(classifyProviderError('Token refresh failed: invalid_grant')).toBe('rejected');
    expect(classifyProviderError('Could not reach Meta: fetch failed')).toBe('unreachable');
    expect(classifyProviderError('HubSpot rejected the credentials (HTTP 503). ')).toBe('unreachable');
    expect(classifyProviderError('This Facebook account manages no Pages. Publishing needs a Page')).toBe('account');
  });

  it('reads granted permissions from Meta (declined ones excluded)', () => {
    expect(
      grantedFrom({ data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'instagram_content_publish', status: 'declined' }, { permission: 'x' }] }),
    ).toEqual(['pages_show_list']);
    expect(grantedFrom(null)).toEqual([]);
  });
});

describe('Provider authentication — useful errors', () => {
  it('turns OAuth failures into a reason and a next step', () => {
    expect(describeAuthFailure('access_denied', 'LinkedIn')).toMatchObject({ code: 'access_denied', action: 'retry' });
    expect(describeAuthFailure('access_denied', 'LinkedIn').message).toMatch(/choose “Allow”/);
    expect(describeAuthFailure('redirect_uri_mismatch', 'Google Analytics')).toMatchObject({ action: 'contact_support' });
    expect(describeAuthFailure('invalid_request', 'Meta', 'Invalid redirect_uri: not whitelisted').code).toBe('redirect_uri_mismatch');
    expect(describeAuthFailure('invalid_scope', 'Meta').title).toBe('Meta refused a requested permission');
    expect(describeAuthFailure('forbidden', 'Slack')).toMatchObject({ action: 'ask_admin' });
    expect(describeAuthFailure('bad_state', 'Meta').message).toMatch(/Start again/);
    expect(describeAuthFailure('no_accounts', 'Facebook & Instagram').message).toMatch(/admin of a Facebook Page/);
  });

  it('an unknown failure still says something useful, without dumping the provider', () => {
    const f = describeAuthFailure('server_error', 'HubSpot', 'x'.repeat(500));
    expect(f.title).toBe('HubSpot couldn’t be connected');
    expect(f.message.length).toBeLessThan(260);
    expect(describeAuthFailure(null, 'HubSpot').code).toBe('unknown');
  });
});
