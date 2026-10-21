/**
 * Provider routing — where an approved action executes, decided before
 * anything runs:
 *
 *   Approved Instagram post → Instagram channel → the Meta connection →
 *   the Instagram account linked to the chosen Page → the Graph API
 *
 * Checked in order (the first failure is the answer):
 *   1 channel supported          (a provider executes this network)
 *   2 content type supported     (the API can post this format there)
 *   3 provider connected         (a connection exists and isn't removed)
 *   4 permissions and health     (lib/capabilities.ts checkCapability)
 *   5 account/page valid         (the chosen page/profile for this channel)
 *
 * Pure: the server gathers the facts (server/execution/routing.service.ts).
 */
import { checkCapability, executorFor, type Capability } from '@/lib/capabilities';
import type { Channel, ConnectionHealthStatus } from '@/lib/connection-manager';
import { COPY_ONLY_TYPES } from '@/lib/validations/content';

const COPY_ONLY = new Set<string>(COPY_ONLY_TYPES);

/** Can the provider's API post this content type to this network? */
export function apiSupportsFormat(type: string, platform: string): boolean {
  if (COPY_ONLY.has(type)) return false;
  if (platform === 'INSTAGRAM') return true; // media is checked at publish
  if (platform === 'FACEBOOK') return true;
  if (platform === 'LINKEDIN') return type === 'LINKEDIN_POST' || type === 'IMAGE_POST';
  return false;
}

export type RouteCode =
  | 'unsupported_channel'
  | 'unsupported_content_type'
  | 'not_connected'
  | 'missing_permission'
  | 'connection_unhealthy'
  | 'invalid_account';

export interface RouteAccountFact {
  id: string;
  kind: string;
  externalId: string;
  name: string;
  parentId: string | null;
  selected: boolean;
}

export interface RouteFacts {
  platform: string;
  contentType: string;
  connection: {
    id: string;
    connectorId: string;
    provider: string | null;
    status: string;
    health: ConnectionHealthStatus;
    healthReason: string | null;
    scopes: string[];
    /** What the publisher will use (Meta: metadata.pageId / igUserId). */
    pageId?: string | null;
    igUserId?: string | null;
    linkedInOrgUrn?: string | null;
  } | null;
  accounts: RouteAccountFact[];
}

export interface RouteTarget {
  connectedAccountId: string | null;
  kind: string;
  externalId: string;
  name: string;
}

export interface RouteCheck {
  key: 'channel' | 'content_type' | 'connection' | 'permissions' | 'account';
  ok: boolean;
  detail: string;
}

export type RouteDecision =
  | {
      ok: true;
      platform: string;
      channel: Channel;
      connectorId: string;
      provider: string;
      connectionId: string;
      target: RouteTarget;
      /** Allowed with a stated limit (Instagram scheduling is held by Aura). */
      note: string | null;
      checks: RouteCheck[];
    }
  | {
      ok: false;
      platform: string;
      code: RouteCode;
      message: string;
      fix: { label: string; href: string } | null;
      connectorId: string | null;
      provider: string | null;
      connectionId: string | null;
      checks: RouteCheck[];
    };

const NETWORK: Record<string, string> = { FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', LINKEDIN: 'LinkedIn', X: 'X' };
const MANAGER = { label: 'Open Connections', href: '/dashboard/connections' };

export function decideRoute(f: RouteFacts, capability: Capability = 'organic_publishing'): RouteDecision {
  const checks: RouteCheck[] = [];
  const name = NETWORK[f.platform] ?? f.platform;
  const exec = executorFor(f.platform);
  const refuse = (code: RouteCode, message: string, fix: { label: string; href: string } | null = MANAGER): RouteDecision => ({
    ok: false,
    platform: f.platform,
    code,
    message,
    fix,
    connectorId: exec?.connectorId ?? null,
    provider: f.connection?.provider ?? exec?.connectorId ?? null,
    connectionId: f.connection?.id ?? null,
    checks,
  });

  // 1 channel
  if (!exec) {
    checks.push({ key: 'channel', ok: false, detail: `${name} has no publishing provider in V1.` });
    return refuse('unsupported_channel', `${name} publishing isn’t supported — copy the post and publish it there by hand.`, null);
  }
  checks.push({ key: 'channel', ok: true, detail: `${name} → ${exec.connectorId === 'meta' ? 'Meta' : 'LinkedIn'}` });

  // 2 content type
  if (!apiSupportsFormat(f.contentType, f.platform)) {
    checks.push({ key: 'content_type', ok: false, detail: `${f.contentType} can’t be posted to ${name} through its API.` });
    return refuse(
      'unsupported_content_type',
      COPY_ONLY.has(f.contentType)
        ? 'Emails and ads are copied out, not published to a network.'
        : `${name}’s API can’t post this format. Use a single post or image post, or publish it by hand.`,
      null,
    );
  }
  checks.push({ key: 'content_type', ok: true, detail: `${f.contentType} is supported on ${name}.` });

  // 3 connection
  const c = f.connection;
  if (!c || c.status === 'DISCONNECTED' || c.status === 'REVOKED') {
    checks.push({ key: 'connection', ok: false, detail: c ? `The connection was ${c.status.toLowerCase()}.` : 'No connection.' });
    return refuse(
      'not_connected',
      exec.connectorId === 'meta' ? `${name} isn’t connected — connect Facebook & Instagram.` : 'LinkedIn isn’t connected for this workspace.',
      exec.connectorId === 'linkedin' ? { label: 'Connect LinkedIn', href: '/dashboard/settings/connections' } : { label: 'Connect', href: '/dashboard/connectors' },
    );
  }
  checks.push({ key: 'connection', ok: true, detail: `Connected (${c.health.toLowerCase().replace('_', ' ')}).` });

  // 4 permissions + health
  const cap = checkCapability({
    connectorId: exec.connectorId,
    channel: exec.channel,
    capability,
    grantedScopes: c.scopes.length ? c.scopes : null,
    health: c.health,
    healthReason: c.healthReason,
    label: name,
  });
  if (!cap.allowed) {
    checks.push({ key: 'permissions', ok: false, detail: cap.reason ?? 'Not allowed.' });
    return refuse(
      cap.missingScopes.length ? 'missing_permission' : cap.level === 'unsupported' || cap.level === 'out_of_scope' || cap.level === 'unknown' ? 'unsupported_channel' : 'connection_unhealthy',
      cap.reason ?? `${name} can’t be used right now.`,
      cap.fix ?? MANAGER,
    );
  }
  checks.push({ key: 'permissions', ok: true, detail: 'Required permissions granted; connection usable.' });

  // 5 account / page
  const target = targetFor(f, exec.channel);
  if (!target) {
    const detail =
      f.platform === 'INSTAGRAM'
        ? 'No Instagram Business or Creator account is linked to the chosen Facebook Page.'
        : f.platform === 'FACEBOOK'
          ? 'No Facebook Page is chosen for publishing.'
          : 'No LinkedIn profile or Page is available to post as.';
    checks.push({ key: 'account', ok: false, detail });
    return refuse('invalid_account', detail, { label: 'Choose the account', href: `/dashboard/connections/${exec.connectorId}/setup` });
  }
  checks.push({ key: 'account', ok: true, detail: `Posts as ${target.name}.` });

  return {
    ok: true,
    platform: f.platform,
    channel: exec.channel,
    connectorId: exec.connectorId,
    provider: c.provider ?? exec.connectorId,
    connectionId: c.id,
    target,
    note: cap.reason,
    checks,
  };
}

/** The page/profile this channel posts to, as the publisher will use it. */
function targetFor(f: RouteFacts, channel: Channel): RouteTarget | null {
  const c = f.connection!;
  const find = (kind: string, externalId?: string | null) =>
    f.accounts.find((a) => a.kind === kind && (externalId ? a.externalId === externalId : a.selected)) ?? null;
  if (channel === 'FACEBOOK') {
    if (!c.pageId) return null;
    const page = find('PAGE', c.pageId);
    return { connectedAccountId: page?.id ?? null, kind: 'PAGE', externalId: c.pageId, name: page?.name ?? 'Facebook Page' };
  }
  if (channel === 'INSTAGRAM') {
    if (!c.pageId || !c.igUserId) return null;
    const ig = find('INSTAGRAM_ACCOUNT', c.igUserId);
    // The Instagram account must belong to the chosen Page.
    const page = find('PAGE', c.pageId);
    if (ig && page && ig.parentId && ig.parentId !== page.id) return null;
    return { connectedAccountId: ig?.id ?? null, kind: 'INSTAGRAM_ACCOUNT', externalId: c.igUserId, name: ig?.name ?? 'Instagram account' };
  }
  if (channel === 'LINKEDIN') {
    const canOrg = c.scopes.includes('w_organization_social') && c.linkedInOrgUrn;
    if (canOrg) {
      const org = find('LINKEDIN_ORGANIZATION', c.linkedInOrgUrn);
      return { connectedAccountId: org?.id ?? null, kind: 'LINKEDIN_ORGANIZATION', externalId: c.linkedInOrgUrn!, name: org?.name ?? 'LinkedIn Page' };
    }
    const member = f.accounts.find((a) => a.kind === 'LINKEDIN_MEMBER') ?? null;
    if (!member) return null;
    return { connectedAccountId: member.id, kind: 'LINKEDIN_MEMBER', externalId: member.externalId, name: member.name };
  }
  return null;
}
