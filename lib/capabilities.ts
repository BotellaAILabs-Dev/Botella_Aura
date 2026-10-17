/**
 * Provider Capability Framework — what each provider connection can and
 * cannot do, per channel, and why.
 *
 * The registry is the single source: execution checks it before acting
 * (`checkCapability`), and the Connection Manager shows it (`capabilityMatrix`)
 * so an unsupported action is explained instead of failing.
 *
 * A capability is available only when ALL of these hold:
 *   1. the provider supports it on that channel (registry level),
 *   2. the connection was granted the permissions it needs (scopes),
 *   3. the connection is usable right now (health — lib/connection-health.ts).
 */
import type { Channel, ConnectionHealthStatus } from '@/lib/connection-manager';
import { connectorChannels } from '@/lib/connection-manager';
import { healthBlocksExecution, HEALTH_LABEL } from '@/lib/connection-health';

export const CAPABILITIES = [
  'organic_publishing',
  'scheduling',
  'organic_analytics',
  'paid_ads',
  'messaging',
  'social_listening',
  'influencer_monitoring',
  'autonomous_posting',
  'data_read',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_LABEL: Record<Capability, string> = {
  organic_publishing: 'Organic publishing',
  scheduling: 'Scheduling',
  organic_analytics: 'Organic analytics',
  paid_ads: 'Paid ads',
  messaging: 'DMs / inbox',
  social_listening: 'Social listening',
  influencer_monitoring: 'Influencer monitoring',
  autonomous_posting: 'Autonomous posting',
  data_read: 'Reads data into Aura',
};

/**
 *   supported     yes
 *   limited       yes, with a stated limit (e.g. Aura holds the post and
 *                 publishes it at the time, because the API has no scheduling)
 *   unsupported   the provider integration does not offer it
 *   out_of_scope  possible, but deliberately not in this version
 */
export type CapabilityLevel = 'supported' | 'limited' | 'unsupported' | 'out_of_scope';

export interface CapabilitySpec {
  level: CapabilityLevel;
  /** Every one of these scopes must be granted. */
  scopes?: string[];
  /** At least one of these must be granted (LinkedIn: member OR organisation posting). */
  anyScopes?: string[];
  /** One line a person reads: the limit, or why not. */
  note?: string;
}

type ChannelCapabilities = Partial<Record<Capability, CapabilitySpec>>;

export interface ProviderCapabilities {
  /** Version of this provider's capability set ("Meta V1"). */
  version: string;
  /** Channel → capabilities. `*` applies to the whole connection. */
  channels: Partial<Record<Channel | '*', ChannelCapabilities>>;
  /** Capabilities whose permissions decide the connection's health. */
  core: Capability[];
}

const META_NOT_IN_V1: ChannelCapabilities = {
  paid_ads: { level: 'unsupported', note: 'Meta V1 publishes organic posts only. Ads are set up in Meta Ads Manager.' },
  messaging: { level: 'unsupported', note: 'Meta V1 does not read or answer DMs.' },
  social_listening: { level: 'unsupported', note: 'Meta V1 does not monitor mentions or conversations.' },
  influencer_monitoring: { level: 'unsupported', note: 'Meta V1 does not track creators or influencers.' },
  autonomous_posting: {
    level: 'out_of_scope',
    note: 'Not in the initial scope: every post is approved by a person before it publishes.',
  },
};

const LINKEDIN_NOT_IN_V1: ChannelCapabilities = {
  organic_analytics: {
    level: 'unsupported',
    note: 'Post analytics need LinkedIn’s Community Management API, which this app is not approved for.',
  },
  paid_ads: { level: 'unsupported', note: 'Ads are set up in LinkedIn Campaign Manager.' },
  messaging: { level: 'unsupported', note: 'LinkedIn does not allow third-party apps to read or send messages.' },
  social_listening: { level: 'unsupported', note: 'Not offered by LinkedIn’s API.' },
  influencer_monitoring: { level: 'unsupported', note: 'Not offered by LinkedIn’s API.' },
  autonomous_posting: {
    level: 'out_of_scope',
    note: 'Not in the initial scope: every post is approved by a person before it publishes.',
  },
};

const PAGE_READ = ['pages_show_list', 'pages_read_engagement'];

const REGISTRY: Record<string, ProviderCapabilities> = {
  meta: {
    version: 'Meta V1',
    core: ['organic_publishing'],
    channels: {
      FACEBOOK: {
        organic_publishing: { level: 'supported', scopes: [...PAGE_READ, 'pages_manage_posts'] },
        scheduling: {
          level: 'supported',
          scopes: [...PAGE_READ, 'pages_manage_posts'],
          note: 'Aura publishes at the scheduled time.',
        },
        organic_analytics: {
          level: 'supported',
          scopes: [...PAGE_READ, 'read_insights'],
          note: 'Page insights need the read_insights permission.',
        },
        ...META_NOT_IN_V1,
      },
      INSTAGRAM: {
        organic_publishing: {
          level: 'supported',
          scopes: [...PAGE_READ, 'instagram_basic', 'instagram_content_publish'],
          note: 'Needs an Instagram Business or Creator account linked to the Page.',
        },
        scheduling: {
          level: 'limited',
          scopes: [...PAGE_READ, 'instagram_basic', 'instagram_content_publish'],
          note: 'Instagram’s API has no scheduling, so Aura holds the post and publishes it at the time.',
        },
        organic_analytics: {
          level: 'supported',
          scopes: ['instagram_basic', 'instagram_manage_insights'],
          note: 'Instagram insights need the instagram_manage_insights permission.',
        },
        ...META_NOT_IN_V1,
      },
    },
  },
  linkedin: {
    version: 'LinkedIn V1',
    core: ['organic_publishing'],
    channels: {
      LINKEDIN: {
        organic_publishing: {
          level: 'supported',
          anyScopes: ['w_member_social', 'w_organization_social'],
          note: 'Posts to the connected member’s profile (or the Company Page, once approved).',
        },
        scheduling: {
          level: 'limited',
          anyScopes: ['w_member_social', 'w_organization_social'],
          note: 'LinkedIn’s API has no scheduling, so Aura holds the post and publishes it at the time.',
        },
        ...LINKEDIN_NOT_IN_V1,
      },
    },
  },
};

/** Data connectors: they read into Aura and never execute anything. */
const DATA_ONLY: ProviderCapabilities = {
  version: 'V1',
  core: ['data_read'],
  channels: {
    '*': {
      data_read: { level: 'supported' },
      organic_publishing: { level: 'unsupported', note: 'This connection only reads data into Aura; it cannot publish.' },
      scheduling: { level: 'unsupported', note: 'This connection only reads data into Aura.' },
    },
  },
};

const DATA_CONNECTORS = new Set(['ga4', 'search-console', 'hubspot', 'mailchimp', 'slack', 'crunchbase', 'google-cse', 'github']);

export function providerCapabilities(connectorId: string): ProviderCapabilities | null {
  return REGISTRY[connectorId] ?? (DATA_CONNECTORS.has(connectorId) ? DATA_ONLY : null);
}

export function capabilitySpec(connectorId: string, channel: string | null | undefined, capability: Capability): CapabilitySpec | null {
  const caps = providerCapabilities(connectorId);
  if (!caps) return null;
  const byChannel = (channel && caps.channels[channel as Channel]) || null;
  return byChannel?.[capability] ?? caps.channels['*']?.[capability] ?? null;
}

/** Scopes a spec needs that were not granted. `null` grants = unknown → none missing. */
export function missingScopes(spec: CapabilitySpec, granted: string[] | null | undefined): string[] {
  if (!granted) return [];
  const have = new Set(granted);
  const missing = (spec.scopes ?? []).filter((s) => !have.has(s));
  if (spec.anyScopes?.length && !spec.anyScopes.some((s) => have.has(s))) {
    missing.push(spec.anyScopes.join(' or '));
  }
  return missing;
}

/** Every permission the core capabilities need (decides health). */
export function requiredScopes(connectorId: string, channels?: string[]): { all: string[]; anyOf: string[][] } {
  const caps = providerCapabilities(connectorId);
  if (!caps) return { all: [], anyOf: [] };
  const all = new Set<string>();
  const anyOf: string[][] = [];
  const keys = Object.keys(caps.channels).filter((c) => c === '*' || !channels?.length || channels.includes(c));
  for (const key of keys) {
    for (const cap of caps.core) {
      const spec = caps.channels[key as Channel | '*']?.[cap];
      if (!spec || spec.level === 'unsupported' || spec.level === 'out_of_scope') continue;
      spec.scopes?.forEach((s) => all.add(s));
      if (spec.anyScopes?.length && !anyOf.some((g) => g.join() === spec.anyScopes!.join())) anyOf.push(spec.anyScopes);
    }
  }
  return { all: [...all], anyOf };
}

export function missingRequiredScopes(connectorId: string, granted: string[] | null | undefined, channels?: string[]): string[] {
  if (!granted) return [];
  const have = new Set(granted);
  const { all, anyOf } = requiredScopes(connectorId, channels);
  return [...all.filter((s) => !have.has(s)), ...anyOf.filter((g) => !g.some((s) => have.has(s))).map((g) => g.join(' or '))];
}

export interface CapabilityCheck {
  allowed: boolean;
  capability: Capability;
  level: CapabilityLevel | 'unknown';
  /** Why it is not allowed (or the limit, when allowed with one). */
  reason: string | null;
  missingScopes: string[];
  /** What a person can do about it. */
  fix: { label: string; href: string } | null;
}

export interface CheckInput {
  connectorId: string;
  channel?: string | null;
  capability: Capability;
  /** Granted scopes; null/undefined when not known (then not checked). */
  grantedScopes?: string[] | null;
  /** The connection's health; omitted when there is no connection to judge. */
  health?: ConnectionHealthStatus | null;
  healthReason?: string | null;
  /** Provider display name for messages ("Facebook"). */
  label?: string;
}

const MANAGER = '/dashboard/connections';

/** May this connection do this, right now? The one check execution uses. */
export function checkCapability(input: CheckInput): CapabilityCheck {
  const { connectorId, channel, capability } = input;
  const label = input.label ?? channelLabel(channel) ?? connectorId;
  const capLabel = CAPABILITY_LABEL[capability].toLowerCase();
  const spec = capabilitySpec(connectorId, channel, capability);
  const base = { capability, missingScopes: [] as string[] };

  if (!spec) {
    return {
      ...base,
      allowed: false,
      level: 'unknown',
      reason: `${label} doesn’t offer ${capLabel} in Aura.`,
      fix: null,
    };
  }
  if (spec.level === 'unsupported' || spec.level === 'out_of_scope') {
    return {
      ...base,
      allowed: false,
      level: spec.level,
      reason: spec.note ?? `${label} doesn’t support ${capLabel}.`,
      fix: null,
    };
  }
  const missing = missingScopes(spec, input.grantedScopes);
  if (missing.length) {
    return {
      ...base,
      allowed: false,
      level: spec.level,
      missingScopes: missing,
      reason: `${label} wasn’t granted the permission ${capLabel} needs (${missing.join(', ')}). Reconnect and allow it.`,
      fix: { label: 'Reconnect', href: `${MANAGER}/${connectorId}/setup` },
    };
  }
  if (input.health && healthBlocksExecution(input.health)) {
    return {
      ...base,
      allowed: false,
      level: spec.level,
      reason: input.healthReason ?? `The ${label} connection is ${HEALTH_LABEL[input.health].toLowerCase()}.`,
      fix: { label: 'Fix connection', href: MANAGER },
    };
  }
  return { ...base, allowed: true, level: spec.level, reason: spec.level === 'limited' ? (spec.note ?? null) : null, fix: null };
}

export interface CapabilityRow {
  capability: Capability;
  label: string;
  channel: string | null;
  level: CapabilityLevel;
  /** Supported and permitted (health not considered — shown separately). */
  available: boolean;
  note: string | null;
  missingScopes: string[];
}

/** The table the Connection Manager shows: every capability × channel. */
export function capabilityMatrix(connectorId: string, grantedScopes: string[] | null, channels?: string[]): CapabilityRow[] {
  const caps = providerCapabilities(connectorId);
  if (!caps) return [];
  const rows: CapabilityRow[] = [];
  const channelKeys = Object.keys(caps.channels).filter((c) => c === '*' || !channels?.length || channels.includes(c));
  for (const key of channelKeys) {
    const set = caps.channels[key as Channel | '*'] ?? {};
    for (const capability of CAPABILITIES) {
      const spec = set[capability];
      if (!spec) continue;
      const missing = spec.level === 'supported' || spec.level === 'limited' ? missingScopes(spec, grantedScopes) : [];
      rows.push({
        capability,
        label: CAPABILITY_LABEL[capability],
        channel: key === '*' ? null : key,
        level: spec.level,
        available: (spec.level === 'supported' || spec.level === 'limited') && missing.length === 0,
        note: missing.length ? `Needs permission: ${missing.join(', ')}.` : (spec.note ?? null),
        missingScopes: missing,
      });
    }
  }
  return rows;
}

/** Stored on the connection after each check: capability → available. */
export function capabilitySnapshot(connectorId: string, grantedScopes: string[] | null, channels?: string[]): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {};
  for (const row of capabilityMatrix(connectorId, grantedScopes, channels)) {
    const key = row.channel ?? '*';
    (out[key] ??= {})[row.capability] = row.available;
  }
  return out;
}

/** Social platform → the connector and channel that executes it. */
export function executorFor(platform: string): { connectorId: string; channel: Channel } | null {
  if (platform === 'FACEBOOK') return { connectorId: 'meta', channel: 'FACEBOOK' };
  if (platform === 'INSTAGRAM') return { connectorId: 'meta', channel: 'INSTAGRAM' };
  if (platform === 'LINKEDIN') return { connectorId: 'linkedin', channel: 'LINKEDIN' };
  return null;
}

function channelLabel(channel: string | null | undefined): string | null {
  if (!channel) return null;
  return { FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', LINKEDIN: 'LinkedIn' }[channel] ?? null;
}

export { connectorChannels };
