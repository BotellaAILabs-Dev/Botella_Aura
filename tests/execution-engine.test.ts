import { describe, it, expect } from 'vitest';

import {
  canTransition,
  assertTransition,
  classifyFailure,
  failureTarget,
  InvalidTransitionError,
  pathTo,
  TRANSITIONS,
  EXECUTION_STATES,
  RETRY_BACKOFF_MS,
  type ExecutionState,
} from '@/lib/execution-state';
import { apiSupportsFormat, decideRoute, type RouteFacts } from '@/lib/execution-routing';
import {
  formatInZone,
  isValidTimeZone,
  offsetLabel,
  toLocalInput,
  validateScheduleTime,
  zonedToUtc,
  TimezoneError,
} from '@/lib/timezone';
import { insightValues } from '@/server/connectors/meta-insights.service';
import { META_INSIGHTS_SCOPES, META_SCOPES, metaRequestedScopes } from '@/lib/meta';

/**
 * Sprint 10 execution tickets: the execution state machine, provider routing,
 * scheduling across timezones (daylight saving included), and Meta organic
 * analytics parsing. Pure — the server engine is exercised end to end by
 * scripts/verify-execution.ts.
 */

describe('Execution State Machine', () => {
  it('the happy path: Approved → Ready → Scheduled → Queued → Executing → Completed', () => {
    const path: ExecutionState[] = ['APPROVED', 'READY_FOR_EXECUTION', 'SCHEDULED', 'QUEUED', 'EXECUTING', 'COMPLETED'];
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
  });

  it('the failure path: Executing → Failed → Retry (Queued) or Action required', () => {
    expect(canTransition('EXECUTING', 'FAILED')).toBe(true);
    expect(canTransition('FAILED', 'QUEUED')).toBe(true);
    expect(canTransition('FAILED', 'ACTION_REQUIRED')).toBe(true);
    expect(canTransition('EXECUTING', 'ACTION_REQUIRED')).toBe(true);
  });

  it('cancellation: Scheduled → Cancelled; cancelled work returns only by approval', () => {
    expect(canTransition('SCHEDULED', 'CANCELLED')).toBe(true);
    expect(TRANSITIONS.CANCELLED).toEqual(['APPROVED']);
    expect(canTransition('CANCELLED', 'QUEUED')).toBe(false);
  });

  it('invalid transitions are prevented', () => {
    expect(canTransition('APPROVED', 'COMPLETED')).toBe(false);
    expect(canTransition('SCHEDULED', 'EXECUTING')).toBe(false); // must be queued first
    expect(canTransition('EXECUTING', 'CANCELLED')).toBe(false); // can't cancel mid-flight
    expect(canTransition(null, 'EXECUTING')).toBe(false);
    expect(canTransition(null, 'APPROVED')).toBe(true);
    expect(() => assertTransition('READY_FOR_EXECUTION', 'COMPLETED')).toThrow(InvalidTransitionError);
  });

  it('completed executions can never run again', () => {
    expect(TRANSITIONS.COMPLETED).toEqual([]);
    for (const s of EXECUTION_STATES) expect(canTransition('COMPLETED', s)).toBe(false);
    expect(() => assertTransition('COMPLETED', 'QUEUED')).toThrow(/already been published/);
    expect(pathTo('COMPLETED', 'EXECUTING')).toBeNull();
  });

  it('multi-step moves walk the allowed path, so each state change is recorded', () => {
    expect(pathTo('APPROVED', 'EXECUTING')).toEqual(['READY_FOR_EXECUTION', 'QUEUED', 'EXECUTING']);
    expect(pathTo('SCHEDULED', 'EXECUTING')).toEqual(['QUEUED', 'EXECUTING']);
    expect(pathTo('READY_FOR_EXECUTION', 'FAILED')).toEqual(['QUEUED', 'EXECUTING', 'FAILED']);
    expect(pathTo('CANCELLED', 'EXECUTING')).toEqual(['APPROVED', 'READY_FOR_EXECUTION', 'QUEUED', 'EXECUTING']);
    expect(pathTo('SCHEDULED', 'SCHEDULED')).toEqual([]);
  });

  it('every state has a defined set of next states, and no state is unreachable', () => {
    for (const s of EXECUTION_STATES) expect(Array.isArray(TRANSITIONS[s])).toBe(true);
    for (const s of EXECUTION_STATES) if (s !== 'APPROVED') expect(pathTo('APPROVED', s)).not.toBeNull();
  });
});

describe('Failed executions keep their error, and only rate limits retry by themselves', () => {
  it('classifies provider failures', () => {
    expect(classifyFailure('Instagram is rate-limiting publishing right now (it allows 25 posts per 24 hours).')).toBe('rate_limited');
    expect(classifyFailure('Facebook rejected the stored credentials. Reconnect Meta in Settings → Connections.')).toBe('connection');
    expect(classifyFailure('x', { credentialRejected: true })).toBe('connection');
    expect(classifyFailure('An earlier attempt was interrupted before the network answered. Check the account for the post before retrying')).toBe('unknown_outcome');
    expect(classifyFailure('The attached graphic isn’t valid for Instagram: aspect ratio')).toBe('content');
    expect(classifyFailure('request timed out', { thrown: true })).toBe('unknown_outcome');
    expect(classifyFailure('Facebook could not publish this post (HTTP 500).')).toBe('provider');
  });

  it('rate limits back off and retry up to the limit; everything else waits for a person', () => {
    expect(failureTarget('rate_limited', 1, 3)).toEqual({ state: 'FAILED', retryInMs: RETRY_BACKOFF_MS[0] });
    expect(failureTarget('rate_limited', 2, 3)).toEqual({ state: 'FAILED', retryInMs: RETRY_BACKOFF_MS[1] });
    expect(failureTarget('rate_limited', 3, 3)).toEqual({ state: 'FAILED', retryInMs: null });
    expect(failureTarget('provider', 1, 3)).toEqual({ state: 'FAILED', retryInMs: null });
    // An unknown outcome is never retried automatically: it could post twice.
    expect(failureTarget('unknown_outcome', 1, 3)).toEqual({ state: 'ACTION_REQUIRED', retryInMs: null });
    expect(failureTarget('connection', 1, 3).state).toBe('ACTION_REQUIRED');
    expect(failureTarget('content', 1, 3).state).toBe('ACTION_REQUIRED');
  });
});

describe('Provider Routing', () => {
  const META = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish', 'business_management'];
  const accounts = [
    { id: 'a_user', kind: 'USER', externalId: 'fb1', name: 'Facebook login', parentId: null, selected: true },
    { id: 'a_page1', kind: 'PAGE', externalId: '111', name: 'Bakery', parentId: 'a_user', selected: false },
    { id: 'a_page2', kind: 'PAGE', externalId: '222', name: 'Cafe', parentId: 'a_user', selected: true },
    { id: 'a_ig2', kind: 'INSTAGRAM_ACCOUNT', externalId: 'ig2', name: '@cafe', parentId: 'a_page2', selected: true },
  ];
  const meta = (over: Partial<NonNullable<RouteFacts['connection']>> = {}): RouteFacts['connection'] => ({
    id: 'c_meta', connectorId: 'meta', provider: 'meta', status: 'CONNECTED', health: 'HEALTHY', healthReason: null, scopes: META, pageId: '222', igUserId: 'ig2', ...over,
  });
  const route = (platform: string, contentType: string, connection: RouteFacts['connection'], accts = accounts) => decideRoute({ platform, contentType, connection, accounts: accts });

  it('Approved Instagram post → Instagram channel → Meta connection → the Instagram account of the chosen Page', () => {
    const r = route('INSTAGRAM', 'IMAGE_POST', meta());
    expect(r).toMatchObject({ ok: true, channel: 'INSTAGRAM', connectorId: 'meta', provider: 'meta', connectionId: 'c_meta' });
    if (r.ok) expect(r.target).toEqual({ connectedAccountId: 'a_ig2', kind: 'INSTAGRAM_ACCOUNT', externalId: 'ig2', name: '@cafe' });
    expect(r.checks.map((c) => `${c.key}:${c.ok}`)).toEqual(['channel:true', 'content_type:true', 'connection:true', 'permissions:true', 'account:true']);
  });

  it('Facebook → the chosen Page (not another one the login manages)', () => {
    const r = route('FACEBOOK', 'LINKEDIN_POST', meta());
    expect(r.ok && r.target).toMatchObject({ kind: 'PAGE', externalId: '222', name: 'Cafe' });
  });

  it('LinkedIn → the member, or the Company Page when organisation posting is granted', () => {
    const li = { id: 'c_li', connectorId: 'linkedin', provider: 'linkedin', status: 'CONNECTED', health: 'CONNECTED' as const, healthReason: null, scopes: ['openid', 'w_member_social'] };
    const member = [{ id: 'a_m', kind: 'LINKEDIN_MEMBER', externalId: 'li1', name: 'Dana', parentId: null, selected: true }];
    const r = route('LINKEDIN', 'LINKEDIN_POST', li, member);
    expect(r.ok && r.target).toMatchObject({ kind: 'LINKEDIN_MEMBER', externalId: 'li1' });
    const org = route('LINKEDIN', 'LINKEDIN_POST', { ...li, scopes: ['w_organization_social'], linkedInOrgUrn: 'urn:li:organization:9' }, member);
    expect(org.ok && org.target).toMatchObject({ kind: 'LINKEDIN_ORGANIZATION', externalId: 'urn:li:organization:9' });
  });

  it('unsupported combinations are rejected before execution, each with its reason', () => {
    expect(route('X', 'LINKEDIN_POST', null)).toMatchObject({ ok: false, code: 'unsupported_channel' });
    expect(route('LINKEDIN', 'CAROUSEL', null)).toMatchObject({ ok: false, code: 'unsupported_content_type' });
    expect(route('FACEBOOK', 'EMAIL', meta())).toMatchObject({ ok: false, code: 'unsupported_content_type' });
    expect(route('INSTAGRAM', 'IMAGE_POST', null)).toMatchObject({ ok: false, code: 'not_connected' });
    expect(route('INSTAGRAM', 'IMAGE_POST', meta({ status: 'REVOKED' }))).toMatchObject({ ok: false, code: 'not_connected' });
    expect(route('INSTAGRAM', 'IMAGE_POST', meta({ scopes: META.filter((s) => s !== 'instagram_content_publish') }))).toMatchObject({ ok: false, code: 'missing_permission' });
    expect(route('FACEBOOK', 'IMAGE_POST', meta({ health: 'EXPIRED', healthReason: 'The connection expired.' }))).toMatchObject({ ok: false, code: 'connection_unhealthy', message: 'The connection expired.' });
    expect(route('INSTAGRAM', 'IMAGE_POST', meta({ igUserId: null }))).toMatchObject({ ok: false, code: 'invalid_account' });
    expect(route('FACEBOOK', 'IMAGE_POST', meta({ pageId: null }))).toMatchObject({ ok: false, code: 'invalid_account' });
  });

  it('an Instagram account that belongs to another Page is not used', () => {
    const wrong = accounts.map((a) => (a.id === 'a_ig2' ? { ...a, parentId: 'a_page1' } : a));
    expect(route('INSTAGRAM', 'IMAGE_POST', meta(), wrong)).toMatchObject({ ok: false, code: 'invalid_account' });
  });

  it('a refused route says which check failed', () => {
    const r = route('INSTAGRAM', 'IMAGE_POST', meta({ igUserId: null }));
    expect(r.checks.at(-1)).toMatchObject({ key: 'account', ok: false });
    expect(r.ok ? null : r.fix?.href).toBe('/dashboard/connections/meta/setup');
  });

  it('content type support matches the publishers', () => {
    expect(apiSupportsFormat('CAROUSEL', 'FACEBOOK')).toBe(true);
    expect(apiSupportsFormat('CAROUSEL', 'LINKEDIN')).toBe(false);
    expect(apiSupportsFormat('IMAGE_POST', 'LINKEDIN')).toBe(true);
    expect(apiSupportsFormat('AD', 'INSTAGRAM')).toBe(false);
    expect(apiSupportsFormat('LINKEDIN_POST', 'X')).toBe(false);
  });
});

describe('Scheduling & Timezone Handling', () => {
  it('a wall time in the workspace zone becomes the right UTC instant', () => {
    expect(zonedToUtc('2026-07-01T09:00', 'Europe/London').at.toISOString()).toBe('2026-07-01T08:00:00.000Z'); // BST
    expect(zonedToUtc('2026-12-01T09:00', 'Europe/London').at.toISOString()).toBe('2026-12-01T09:00:00.000Z'); // GMT
    expect(zonedToUtc('2026-11-02T09:00', 'Asia/Kolkata').at.toISOString()).toBe('2026-11-02T03:30:00.000Z');
    expect(zonedToUtc('2026-11-02T09:00', 'America/New_York').at.toISOString()).toBe('2026-11-02T14:00:00.000Z'); // EST
    expect(zonedToUtc('2026-12-31T23:59', 'Pacific/Kiritimati').at.toISOString()).toBe('2026-12-31T09:59:00.000Z'); // +14
  });

  it('daylight saving: the same 09:00 either side of the change is still 09:00 local', () => {
    const before = zonedToUtc('2026-03-28T09:00', 'Europe/London').at;
    const after = zonedToUtc('2026-03-30T09:00', 'Europe/London').at;
    expect(toLocalInput(before, 'Europe/London')).toBe('2026-03-28T09:00');
    expect(toLocalInput(after, 'Europe/London')).toBe('2026-03-30T09:00');
    expect(after.getTime() - before.getTime()).toBe(2 * 24 * 3600_000 - 3600_000);
  });

  it('a time skipped by the clocks going forward moves forward, and says so', () => {
    const r = zonedToUtc('2026-03-08T02:30', 'America/New_York');
    expect(r).toMatchObject({ adjustment: 'skipped_forward', local: '2026-03-08T03:30' });
    expect(r.at.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(r.note).toMatch(/doesn’t exist/);
    expect(zonedToUtc('2026-03-29T01:30', 'Europe/London')).toMatchObject({ adjustment: 'skipped_forward', local: '2026-03-29T02:30' });
  });

  it('a time that happens twice when the clocks go back takes the first', () => {
    const r = zonedToUtc('2026-11-01T01:30', 'America/New_York');
    expect(r).toMatchObject({ adjustment: 'ambiguous_first', local: '2026-11-01T01:30' });
    expect(r.at.toISOString()).toBe('2026-11-01T05:30:00.000Z'); // EDT, the first 01:30
    expect(r.note).toMatch(/happens twice/);
  });

  it('the person sees the intended local time, with the offset', () => {
    const at = new Date('2026-07-01T08:00:00Z');
    expect(formatInZone(at, 'Europe/London')).toMatch(/^Wed,? 1 Jul 2026, 09:00 GMT\+1$/);
    expect(formatInZone(at, 'Asia/Kolkata')).toMatch(/^Wed,? 1 Jul 2026, 13:30 GMT\+5:30$/);
    expect(offsetLabel(new Date('2026-01-15T12:00:00Z'), 'UTC')).toBe('GMT');
    expect(toLocalInput('2026-07-01T08:00:00Z', 'America/Los_Angeles')).toBe('2026-07-01T01:00');
  });

  it('past and invalid times are refused with a reason', () => {
    const now = new Date('2026-10-21T12:00:00Z');
    expect(validateScheduleTime(new Date('2026-10-21T11:00:00Z'), now)).toMatchObject({ ok: false, problem: 'past' });
    expect(validateScheduleTime(new Date('2026-10-21T12:00:30Z'), now)).toMatchObject({ ok: false, problem: 'too_soon' });
    expect(validateScheduleTime(new Date('2028-01-01T00:00:00Z'), now)).toMatchObject({ ok: false, problem: 'too_far' });
    expect(validateScheduleTime(new Date('nope'), now)).toMatchObject({ ok: false, problem: 'invalid' });
    expect(validateScheduleTime(new Date('2026-10-22T09:00:00Z'), now)).toEqual({ ok: true });
    expect(() => zonedToUtc('2026-02-30T09:00', 'UTC')).toThrow(TimezoneError);
    expect(() => zonedToUtc('tomorrow 9am', 'UTC')).toThrow(/Enter a date/);
    expect(() => zonedToUtc('2026-11-02T09:00', 'Mars/Olympus')).toThrow(/isn’t a timezone/);
  });

  it('only real IANA zones are accepted', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('Meta integration — organic analytics', () => {
  it('reads Graph insights rows', () => {
    expect(
      insightValues({
        data: [
          { name: 'post_impressions', values: [{ value: 1200 }] },
          { name: 'reach', total_value: { value: 900 } },
          { name: 'broken', values: [{ value: 'x' }] },
        ],
      }),
    ).toEqual({ post_impressions: 1200, reach: 900 });
    expect(insightValues(null)).toEqual({});
  });

  it('insights permissions are requested only when enabled (they need App Review)', () => {
    expect(metaRequestedScopes({})).toEqual([...META_SCOPES]);
    expect(metaRequestedScopes({ META_REQUEST_INSIGHTS: 'true' })).toEqual([...META_SCOPES, ...META_INSIGHTS_SCOPES]);
  });
});
