import { getAppUrl, isLocalAppUrl } from '@/lib/app-url';
import { getProvider, providerReadiness } from '@/server/connectors/providers';
import { redirectUri } from '@/server/connectors/oauth';

/**
 * Connector health check, run BEFORE the user is sent to the provider.
 *
 * `redirect_uri_mismatch` is diagnosed on the provider's own error page, after
 * the user has already left the app — by which point the message is Google's,
 * not ours, and names no fix. Everything needed to predict that failure is
 * knowable here: whether app credentials exist, whether this deployment
 * resolves to a public URL, and what the redirect URI actually is. So we check
 * first and tell the user (or the admin) precisely what to register.
 */
export interface PreflightIssue {
  severity: 'blocker' | 'warning';
  message: string;
  /** Value the admin needs to copy somewhere, when there is one. */
  copyValue?: string;
}

export interface PreflightResult {
  connectorId: string;
  ok: boolean;
  /** Exact URI to register with the provider, for OAuth connectors. */
  redirectUri?: string;
  issues: PreflightIssue[];
}

export function preflightConnector(connectorId: string): PreflightResult {
  const provider = getProvider(connectorId);
  const issues: PreflightIssue[] = [];

  if (!provider) {
    return {
      connectorId,
      ok: false,
      issues: [
        {
          severity: 'blocker',
          message: `"${connectorId}" is on the roadmap and has no integration yet.`,
        },
      ],
    };
  }

  const readiness = providerReadiness(connectorId);
  if (!readiness.connectable && readiness.blockedReason) {
    issues.push({ severity: 'blocker', message: readiness.blockedReason });
  }

  if (provider.auth !== 'oauth') {
    return { connectorId, ok: issues.length === 0, issues };
  }

  const uri = redirectUri(connectorId);
  const appUrl = getAppUrl();

  // A localhost redirect cannot be registered for a hosted deployment, and is
  // the usual cause of a mismatch when APP_URL is unset in production.
  if (isLocalAppUrl(appUrl)) {
    issues.push({
      severity: 'blocker',
      message:
        `This deployment resolves its own URL to ${appUrl}, so the redirect it sends ` +
        'the provider is a localhost address that will not match your registered URI. ' +
        'Set APP_URL (or NEXTAUTH_URL) to the public URL of this deployment.',
      copyValue: uri,
    });
  }

  if (!uri.startsWith('https://') && !isLocalAppUrl(appUrl)) {
    issues.push({
      severity: 'warning',
      message:
        'The redirect URI is not HTTPS. Most providers reject plain HTTP for anything but localhost.',
      copyValue: uri,
    });
  }

  return {
    connectorId,
    redirectUri: uri,
    ok: !issues.some((i) => i.severity === 'blocker'),
    issues,
  };
}
