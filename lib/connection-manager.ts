/**
 * Connection Manager — the one provider-agnostic description of every
 * integration a workspace has: which provider, which account authorised it,
 * which pages/profiles it reaches, what it was granted, whether it is healthy
 * and what it can do.
 *
 * Every connector stores its record in `Connection`. LinkedIn keeps its tokens
 * in its own `LinkedInConnection` table, so its `Connection` row is a mirror:
 * `credentialRef = "linkedin_connection"`, no secret copied.
 *
 * Nothing here returns a secret. `ConnectionRecord` is what the browser sees.
 */

export const LINKEDIN_CONNECTOR_ID = 'linkedin';

/** Rows that describe a connection stored elsewhere (counted by that store). */
export const MIRRORED_CONNECTORS = [LINKEDIN_CONNECTOR_ID] as const;

/** Prisma `where` fragment: the connector's own rows, not mirrors. */
export const NOT_MIRRORED = { connectorId: { notIn: [...MIRRORED_CONNECTORS] } };

export type Channel = 'FACEBOOK' | 'INSTAGRAM' | 'LINKEDIN' | 'WEB' | 'EMAIL' | 'CRM' | 'SLACK';

/** connectorId → provider family. Several connectors can share a provider. */
const PROVIDER_FAMILY: Record<string, string> = {
  ga4: 'google',
  'search-console': 'google',
  'google-cse': 'google',
};

const CONNECTOR_CHANNELS: Record<string, Channel[]> = {
  meta: ['FACEBOOK', 'INSTAGRAM'],
  linkedin: ['LINKEDIN'],
  ga4: ['WEB'],
  'search-console': ['WEB'],
  mailchimp: ['EMAIL'],
  hubspot: ['CRM'],
  slack: ['SLACK'],
};

export function providerFamily(connectorId: string): string {
  return PROVIDER_FAMILY[connectorId] ?? connectorId;
}

export function connectorChannels(connectorId: string): Channel[] {
  return CONNECTOR_CHANNELS[connectorId] ?? [];
}

/** A provider's scope string ("a,b" or "a b") as a clean, de-duplicated list. */
export function parseScopes(scope: string | null | undefined): string[] {
  if (!scope) return [];
  return [...new Set(scope.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

export type AccountKind =
  | 'USER'
  | 'PAGE'
  | 'INSTAGRAM_ACCOUNT'
  | 'LINKEDIN_MEMBER'
  | 'LINKEDIN_ORGANIZATION'
  | 'PROPERTY'
  | 'SITE'
  | 'PORTAL'
  | 'WORKSPACE'
  | 'ACCOUNT';

/**
 * An account/page/profile a provider reported during connection. `parentKey`
 * refers to another discovered account's `kind:externalId` (an Instagram
 * account → its Page).
 */
export interface DiscoveredAccount {
  kind: AccountKind;
  externalId: string;
  name: string;
  channel?: Channel | null;
  parentKey?: string | null;
  /** Shown in the "Select account/page" step. */
  selectable?: boolean;
  /** Pre-selected (e.g. the only Page, or the one in metadata). */
  selected?: boolean;
  metadata?: Record<string, unknown>;
}

export function accountKey(a: { kind: string; externalId: string }): string {
  return `${a.kind}:${a.externalId}`;
}

// --- The browser-safe view --------------------------------------------------

export type ConnectionHealthStatus =
  | 'CONNECTED'
  | 'HEALTHY'
  | 'WARNING'
  | 'EXPIRED'
  | 'DISCONNECTED'
  | 'ACTION_REQUIRED';

export type SetupStage = 'AUTHORIZED' | 'ACCOUNT_SELECTED' | 'CONFIRMED';

export interface ConnectedAccountView {
  id: string;
  kind: string;
  externalId: string;
  name: string;
  parentId: string | null;
  channel: string | null;
  selectable: boolean;
  selected: boolean;
  lastSeenAt: string;
}

export interface ConnectionRecord {
  id: string;
  workspaceId: string;
  connectorId: string;
  provider: string;
  kind: string;
  /** Who connected it (user id). */
  connectedById: string | null;
  /** The authorising account at the provider, as a person reads it. */
  accountLabel: string | null;
  providerAccountId: string | null;
  channels: string[];
  scopes: string[];
  /** Where the secret lives — "self" or "linkedin_connection". Never the secret. */
  credentialRef: string;
  hasCredential: boolean;
  tokenExpiresAt: string | null;
  status: string;
  setupStage: SetupStage;
  health: ConnectionHealthStatus;
  healthReason: string | null;
  healthCheckedAt: string | null;
  lastHealthyAt: string | null;
  lastExecutionAt: string | null;
  lastExecutionError: string | null;
  lastExecutionFailedAt: string | null;
  consecutiveFailures: number;
  capabilities: Record<string, unknown>;
  accounts: ConnectedAccountView[];
  connectedAt: string;
  confirmedAt: string | null;
  revokedAt: string | null;
}

interface RowLike {
  id: string;
  companyId: string;
  connectorId: string;
  kind: string;
  status: string;
  accountLabel: string | null;
  scope: string | null;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  apiKeyEnc: string | null;
  expiresAt: Date | null;
  connectedById: string | null;
  provider: string | null;
  channels: string[];
  providerAccountId: string | null;
  scopes: string[];
  credentialRef: string;
  setupStage: string;
  health: string;
  healthReason: string | null;
  healthCheckedAt: Date | null;
  lastHealthyAt: Date | null;
  lastExecutionAt: Date | null;
  lastExecutionError: string | null;
  lastExecutionFailedAt: Date | null;
  consecutiveFailures: number;
  capabilities: unknown;
  confirmedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  accounts?: {
    id: string;
    kind: string;
    externalId: string;
    name: string;
    parentId: string | null;
    channel: string | null;
    selectable: boolean;
    selected: boolean;
    lastSeenAt: Date;
  }[];
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** A Connection row → what the browser may see. Encrypted fields are dropped. */
export function toConnectionRecord(row: RowLike): ConnectionRecord {
  return {
    id: row.id,
    workspaceId: row.companyId,
    connectorId: row.connectorId,
    provider: row.provider ?? providerFamily(row.connectorId),
    kind: row.kind,
    connectedById: row.connectedById,
    accountLabel: row.accountLabel,
    providerAccountId: row.providerAccountId,
    channels: row.channels.length ? row.channels : connectorChannels(row.connectorId),
    scopes: row.scopes.length ? row.scopes : parseScopes(row.scope),
    credentialRef: row.credentialRef,
    hasCredential:
      row.credentialRef !== 'self' || Boolean(row.accessTokenEnc || row.refreshTokenEnc || row.apiKeyEnc),
    tokenExpiresAt: iso(row.expiresAt),
    status: row.status,
    setupStage: row.setupStage as SetupStage,
    health: row.health as ConnectionHealthStatus,
    healthReason: row.healthReason,
    healthCheckedAt: iso(row.healthCheckedAt),
    lastHealthyAt: iso(row.lastHealthyAt),
    lastExecutionAt: iso(row.lastExecutionAt),
    lastExecutionError: row.lastExecutionError,
    lastExecutionFailedAt: iso(row.lastExecutionFailedAt),
    consecutiveFailures: row.consecutiveFailures,
    capabilities:
      row.capabilities && typeof row.capabilities === 'object' ? (row.capabilities as Record<string, unknown>) : {},
    accounts: (row.accounts ?? []).map((a) => ({
      id: a.id,
      kind: a.kind,
      externalId: a.externalId,
      name: a.name,
      parentId: a.parentId,
      channel: a.channel,
      selectable: a.selectable,
      selected: a.selected,
      lastSeenAt: a.lastSeenAt.toISOString(),
    })),
    connectedAt: row.createdAt.toISOString(),
    confirmedAt: iso(row.confirmedAt),
    revokedAt: iso(row.revokedAt),
  };
}

// --- Account discovery --------------------------------------------------------

interface StoredMetaPage {
  id: string;
  name: string;
  ig?: { id: string; username?: string | null } | null;
}

/**
 * The provider → account → page tree for a connection, from what verify()
 * stored (no extra provider calls). Meta: the Facebook user → each Page they
 * manage (selectable) → the Instagram account linked to each Page. LinkedIn:
 * the member (and the organisation, when configured). Others: the one account.
 */
export function discoverAccounts(input: {
  connectorId: string;
  accountLabel: string | null;
  providerAccountId?: string | null;
  metadata: Record<string, unknown>;
  orgUrn?: string | null;
}): DiscoveredAccount[] {
  const { connectorId, metadata } = input;
  if (connectorId === 'meta') {
    const pages = (Array.isArray(metadata.pages) ? metadata.pages : []) as StoredMetaPage[];
    const chosen = typeof metadata.pageId === 'string' ? metadata.pageId : null;
    const fbUserId = typeof metadata.fbUserId === 'string' ? metadata.fbUserId : input.providerAccountId ?? null;
    const out: DiscoveredAccount[] = [];
    if (fbUserId) out.push({ kind: 'USER', externalId: fbUserId, name: 'Facebook login', selected: true });
    for (const p of pages) {
      if (!p?.id) continue;
      out.push({
        kind: 'PAGE',
        externalId: p.id,
        name: p.name || 'Facebook Page',
        channel: 'FACEBOOK',
        parentKey: fbUserId ? `USER:${fbUserId}` : null,
        selectable: true,
        selected: p.id === chosen,
        metadata: { hasInstagram: Boolean(p.ig?.id) },
      });
      if (p.ig?.id) {
        out.push({
          kind: 'INSTAGRAM_ACCOUNT',
          externalId: p.ig.id,
          name: p.ig.username ? `@${p.ig.username}` : 'Instagram account',
          channel: 'INSTAGRAM',
          parentKey: `PAGE:${p.id}`,
          selected: p.id === chosen,
        });
      }
    }
    return out;
  }
  if (connectorId === LINKEDIN_CONNECTOR_ID) {
    const out: DiscoveredAccount[] = [];
    if (input.providerAccountId) {
      out.push({
        kind: 'LINKEDIN_MEMBER',
        externalId: input.providerAccountId,
        name: input.accountLabel ?? 'LinkedIn member',
        channel: 'LINKEDIN',
        selected: true,
      });
    }
    if (input.orgUrn) {
      out.push({
        kind: 'LINKEDIN_ORGANIZATION',
        externalId: input.orgUrn,
        name: 'LinkedIn Company Page',
        channel: 'LINKEDIN',
        parentKey: input.providerAccountId ? `LINKEDIN_MEMBER:${input.providerAccountId}` : null,
        selected: false,
      });
    }
    return out;
  }
  const label = input.accountLabel?.trim();
  if (!label) return [];
  const kind: AccountKind =
    connectorId === 'ga4' ? 'PROPERTY' : connectorId === 'search-console' ? 'SITE' : connectorId === 'hubspot' ? 'PORTAL' : connectorId === 'slack' ? 'WORKSPACE' : 'ACCOUNT';
  return [{ kind, externalId: input.providerAccountId || label, name: label, channel: connectorChannels(connectorId)[0] ?? null, selected: true }];
}

/** Whether this connector has a "choose which account/page" step. */
export function hasAccountChoice(accounts: Pick<DiscoveredAccount, 'selectable'>[]): boolean {
  return accounts.filter((a) => a.selectable).length > 1;
}
