/**
 * Connection health — whether an integration is usable right now, and what a
 * person should do when it isn't. Pure: the server gathers the facts
 * (server/connections/health.service.ts), this decides.
 *
 *   CONNECTED        set up; not checked yet
 *   HEALTHY          checked: token valid, permissions granted, account reachable
 *   WARNING          works, but needs attention soon (token expiring and not
 *                    refreshable, provider briefly unreachable, a recent failure)
 *   EXPIRED          the token expired and could not be refreshed
 *   DISCONNECTED     removed — by a person here, or access revoked at the provider
 *   ACTION_REQUIRED  a person must act: reconnect, grant a permission, choose
 *                    an account/page, or finish setup
 *
 * Execution goes through CONNECTED, HEALTHY and WARNING only.
 */
import type { ConnectionHealthStatus, SetupStage } from '@/lib/connection-manager';

export const HEALTH_LABEL: Record<ConnectionHealthStatus, string> = {
  CONNECTED: 'Connected',
  HEALTHY: 'Healthy',
  WARNING: 'Warning',
  EXPIRED: 'Expired',
  DISCONNECTED: 'Disconnected',
  ACTION_REQUIRED: 'Action required',
};

const BLOCKING: ReadonlySet<ConnectionHealthStatus> = new Set(['EXPIRED', 'DISCONNECTED', 'ACTION_REQUIRED']);

export function healthBlocksExecution(health: ConnectionHealthStatus): boolean {
  return BLOCKING.has(health);
}

/** Warn this long before a token that cannot be refreshed expires. */
export const EXPIRY_WARNING_MS = 10 * 24 * 60 * 60_000;
/** A failure this recent still counts against the connection. */
export const RECENT_FAILURE_MS = 24 * 60 * 60_000;
/** This many failures in a row needs a person. */
export const FAILURES_FOR_ACTION = 3;

export type HealthAction = 'none' | 'reconnect' | 'grant_permissions' | 'select_account' | 'finish_setup' | 'retry_later' | 'review_failures';

export interface HealthFacts {
  status: 'CONNECTED' | 'ERROR' | 'EXPIRED' | 'DISCONNECTED' | 'REVOKED';
  setupStage: SetupStage;
  /** Has a stored secret to use (or is stored elsewhere and present there). */
  hasCredential: boolean;
  expiresAt: Date | null;
  /** The provider can issue a new token without the person (refresh token). */
  refreshable: boolean;
  /** Scopes the core capabilities need that were not granted. */
  missingScopes: string[];
  /**
   * The live check: `ok` the provider accepted the credential; `rejected` it
   * refused it (revoked, invalid); `unreachable` it could not be asked;
   * `null` not checked this time.
   */
  providerCheck: 'ok' | 'rejected' | 'unreachable' | null;
  providerMessage?: string | null;
  /** The selected account/page is still one the credential can reach. Null = unknown. */
  accountAvailable: boolean | null;
  consecutiveFailures: number;
  lastExecutionFailedAt: Date | null;
  lastExecutionError?: string | null;
  /** Provider display name for messages. */
  label: string;
}

export interface HealthCheckItem {
  key: 'token' | 'permissions' | 'provider' | 'account' | 'executions' | 'setup';
  label: string;
  ok: boolean | null;
  detail: string;
}

export interface HealthResult {
  health: ConnectionHealthStatus;
  reason: string | null;
  action: HealthAction;
  checks: HealthCheckItem[];
}

function days(ms: number) {
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60_000)));
}

export function evaluateHealth(f: HealthFacts, now: Date = new Date()): HealthResult {
  const checks: HealthCheckItem[] = [];
  const left = f.expiresAt ? f.expiresAt.getTime() - now.getTime() : null;
  const tokenExpired = left !== null && left <= 0 && !f.refreshable;
  const tokenExpiring = left !== null && left > 0 && left < EXPIRY_WARNING_MS && !f.refreshable;
  const recentFailure = Boolean(f.lastExecutionFailedAt) && now.getTime() - f.lastExecutionFailedAt!.getTime() < RECENT_FAILURE_MS;

  checks.push({
    key: 'setup',
    label: 'Setup finished',
    ok: f.setupStage === 'CONFIRMED',
    detail: f.setupStage === 'CONFIRMED' ? 'Account confirmed.' : 'The account/page has not been confirmed yet.',
  });
  checks.push({
    key: 'token',
    label: 'Token valid',
    ok: !f.hasCredential || f.status === 'EXPIRED' || tokenExpired || f.providerCheck === 'rejected' ? false : true,
    detail: !f.hasCredential
      ? 'No credential stored.'
      : f.providerCheck === 'rejected'
        ? `${f.label} rejected the stored credential.`
        : f.status === 'EXPIRED' || tokenExpired
          ? 'The access token has expired.'
          : tokenExpiring
            ? `Expires in ${days(left!)} day(s).`
            : f.expiresAt && !f.refreshable
              ? `Valid until ${f.expiresAt.toISOString().slice(0, 10)}.`
              : f.refreshable
                ? 'Valid; renewed automatically.'
                : 'Valid.',
  });
  checks.push({
    key: 'permissions',
    label: 'Required permissions',
    ok: f.missingScopes.length === 0,
    detail: f.missingScopes.length ? `Missing: ${f.missingScopes.join(', ')}.` : 'All granted.',
  });
  checks.push({
    key: 'provider',
    label: `${f.label} reachable`,
    ok: f.providerCheck === null ? null : f.providerCheck !== 'unreachable',
    detail:
      f.providerCheck === null
        ? 'Not checked yet.'
        : f.providerCheck === 'unreachable'
          ? `${f.label} didn’t answer${f.providerMessage ? `: ${f.providerMessage}` : ''}.`
          : 'Answered.',
  });
  checks.push({
    key: 'account',
    label: 'Account/page available',
    ok: f.accountAvailable,
    detail: f.accountAvailable === null ? 'Not checked yet.' : f.accountAvailable ? 'Still reachable.' : 'The chosen account/page is no longer reachable.',
  });
  checks.push({
    key: 'executions',
    label: 'Recent executions',
    ok: f.consecutiveFailures === 0 ? true : !recentFailure ? true : false,
    detail:
      f.consecutiveFailures === 0
        ? 'No recent failures.'
        : `${f.consecutiveFailures} failure(s) in a row${f.lastExecutionError ? `, last: ${f.lastExecutionError}` : ''}.`,
  });

  const result = (health: ConnectionHealthStatus, reason: string | null, action: HealthAction): HealthResult => ({ health, reason, action, checks });

  if (f.status === 'REVOKED') {
    return result('DISCONNECTED', `Access was removed at ${f.label}. Reconnect to use it again.`, 'reconnect');
  }
  if (f.status === 'DISCONNECTED') {
    return result('DISCONNECTED', `${f.label} is disconnected. Reconnect to use it again.`, 'reconnect');
  }
  if (!f.hasCredential) {
    return result('ACTION_REQUIRED', `${f.label} has no stored credential. Reconnect it.`, 'reconnect');
  }
  if (f.providerCheck === 'rejected') {
    return result(
      'ACTION_REQUIRED',
      `${f.label} no longer accepts Aura’s access (it may have been revoked or the password changed). Reconnect it.`,
      'reconnect',
    );
  }
  if (f.status === 'EXPIRED' || tokenExpired) {
    return result('EXPIRED', `The ${f.label} connection expired. Reconnect to keep publishing.`, 'reconnect');
  }
  if (f.setupStage !== 'CONFIRMED') {
    return result(
      'ACTION_REQUIRED',
      f.setupStage === 'AUTHORIZED' ? `Choose which ${f.label} account or page Aura should use.` : `Confirm the ${f.label} connection to finish setup.`,
      f.setupStage === 'AUTHORIZED' ? 'select_account' : 'finish_setup',
    );
  }
  if (f.missingScopes.length) {
    return result(
      'ACTION_REQUIRED',
      `${f.label} wasn’t granted ${f.missingScopes.length === 1 ? 'a permission' : 'permissions'} Aura needs (${f.missingScopes.join(', ')}). Reconnect and allow ${f.missingScopes.length === 1 ? 'it' : 'them'}.`,
      'grant_permissions',
    );
  }
  if (f.accountAvailable === false) {
    return result('ACTION_REQUIRED', `The chosen ${f.label} account or page is no longer available. Choose another.`, 'select_account');
  }
  if (f.consecutiveFailures >= FAILURES_FOR_ACTION && recentFailure) {
    return result(
      'ACTION_REQUIRED',
      `The last ${f.consecutiveFailures} attempts through ${f.label} failed${f.lastExecutionError ? ` (${f.lastExecutionError})` : ''}. Check the connection.`,
      'review_failures',
    );
  }
  if (f.status === 'ERROR') {
    return result('WARNING', `${f.label} reported a problem on its last use. Check the connection.`, 'review_failures');
  }
  if (f.providerCheck === 'unreachable') {
    return result('WARNING', `${f.label} couldn’t be reached just now. Aura will check again.`, 'retry_later');
  }
  if (tokenExpiring) {
    return result('WARNING', `The ${f.label} connection expires in ${days(left!)} day(s). Reconnect before then.`, 'reconnect');
  }
  if (recentFailure && f.consecutiveFailures > 0) {
    return result('WARNING', `The last attempt through ${f.label} failed${f.lastExecutionError ? ` (${f.lastExecutionError})` : ''}.`, 'review_failures');
  }
  if (f.providerCheck === null) return result('CONNECTED', null, 'none');
  return result('HEALTHY', null, 'none');
}

/** Whether a stored health still lets execution through, with the words to say when not. */
export function executionAllowed(health: ConnectionHealthStatus, reason: string | null, label: string): { allowed: boolean; reason: string | null } {
  if (!healthBlocksExecution(health)) return { allowed: true, reason: null };
  return { allowed: false, reason: reason ?? `The ${label} connection is ${HEALTH_LABEL[health].toLowerCase()} — fix it in Connections.` };
}
