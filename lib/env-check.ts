/**
 * Environment check — which integrations are configured, by variable NAME
 * only. Values are never read into the report, logged or returned.
 *
 * Used at server start (instrumentation.ts) and by `pnpm env:check`.
 * Integrations are optional: an unconfigured one is reported "off", never
 * fatal. What is flagged:
 *   - core variables the app cannot run without
 *   - PARTIAL integrations (some variables set, others missing) — the
 *     usual sign of a copy-paste mistake in the hosting dashboard
 *   - secrets exposed to the browser (NEXT_PUBLIC_*SECRET/TOKEN/KEY…)
 *   - production settings that cannot work (localhost URLs, the load-test stub)
 */

import { isValidLinkedInVersion, LINKEDIN_DEFAULT_API_VERSION, linkedInVersionMayBeSunset } from '@/lib/linkedin-api';

export type Env = Record<string, string | undefined>;

export interface Group {
  key: string;
  label: string;
  /** All required for the integration to work. */
  required: string[];
  optional?: string[];
  /** The app cannot start without it. */
  core?: boolean;
}

export const GROUPS: Group[] = [
  { key: 'core', label: 'Core', core: true, required: ['DATABASE_URL', 'DIRECT_URL', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL', 'ENCRYPTION_KEY'], optional: ['APP_URL', 'CRON_SECRET'] },
  {
    key: 'whatsapp',
    label: 'WhatsApp Cloud API',
    required: ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'],
    optional: ['WHATSAPP_GRAPH_API_VERSION', 'WHATSAPP_DISPLAY_NUMBER', 'WHATSAPP_WORKER_CONCURRENCY', 'WHATSAPP_QUICK_RETRY_MS', 'WHATSAPP_RETENTION_DAYS'],
  },
  { key: 'meta', label: 'Facebook & Instagram (Meta login)', required: ['META_CLIENT_ID', 'META_CLIENT_SECRET'], optional: ['META_GRAPH_VERSION', 'META_OAUTH_PKCE', 'META_REQUEST_INSIGHTS', 'META_LOGIN_CONFIG_ID'] },
  {
    key: 'google',
    label: 'Google (sign-in + Analytics/Search Console)',
    required: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  },
  { key: 'linkedin', label: 'LinkedIn', required: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'], optional: ['LINKEDIN_ORG_URN', 'LINKEDIN_OAUTH_PKCE', 'LINKEDIN_API_VERSION'] },
  { key: 'video', label: 'File storage (Instagram video)', required: ['ASSET_S3_ENDPOINT', 'ASSET_S3_BUCKET', 'ASSET_S3_ACCESS_KEY_ID', 'ASSET_S3_SECRET_ACCESS_KEY'], optional: ['ASSET_S3_REGION', 'ASSET_S3_PUBLIC_BASE_URL'] },
];

export type GroupStatus = 'ready' | 'off' | 'partial' | 'missing_core';

export interface GroupReport {
  key: string;
  label: string;
  status: GroupStatus;
  set: string[];
  missing: string[];
  optionalSet: string[];
}

export interface EnvReport {
  groups: GroupReport[];
  /** Problems that break something (names and reasons only). */
  errors: string[];
  /** Settings that will probably not do what is meant. */
  warnings: string[];
}

const isSet = (env: Env, k: string) => Boolean(env[k]?.trim());
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;
const SECRETISH = /(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|ACCESS_KEY|ENCRYPTION|DATABASE_URL)/;

export function checkEnv(env: Env, opts: { production?: boolean } = {}): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const groups = GROUPS.map((g): GroupReport => {
    const set = g.required.filter((k) => isSet(env, k));
    const missing = g.required.filter((k) => !isSet(env, k));
    const optionalSet = (g.optional ?? []).filter((k) => isSet(env, k));
    const status: GroupStatus = missing.length === 0 ? 'ready' : g.core ? 'missing_core' : set.length === 0 ? 'off' : 'partial';
    if (status === 'missing_core') errors.push(`${g.label}: missing ${missing.join(', ')}.`);
    if (status === 'partial') errors.push(`${g.label}: only partly configured — missing ${missing.join(', ')} (set: ${set.join(', ')}).`);
    return { key: g.key, label: g.label, status, set, missing, optionalSet };
  });

  // Secrets must stay server-side: Next inlines NEXT_PUBLIC_* into browser bundles.
  for (const k of Object.keys(env)) {
    if (k.startsWith('NEXT_PUBLIC_') && SECRETISH.test(k) && isSet(env, k)) {
      errors.push(`${k} is exposed to the browser (NEXT_PUBLIC_). Rename it without the prefix.`);
    }
  }

  if (isSet(env, 'WHATSAPP_GRAPH_BASE_URL')) {
    (opts.production ? errors : warnings).push('WHATSAPP_GRAPH_BASE_URL is set — WhatsApp goes to the load-test stub, not Meta.');
  }
  if (isSet(env, 'LINKEDIN_API_VERSION')) {
    const v = env.LINKEDIN_API_VERSION!.trim();
    if (!isValidLinkedInVersion(v)) warnings.push(`LINKEDIN_API_VERSION must be YYYYMM — it is ignored and the default ${LINKEDIN_DEFAULT_API_VERSION} is used.`);
    else if (linkedInVersionMayBeSunset(v)) warnings.push(`LINKEDIN_API_VERSION ${v} is a year old or more — LinkedIn may have sunset it (posts would fail with HTTP 426). Use a current version.`);
  } else if (linkedInVersionMayBeSunset(LINKEDIN_DEFAULT_API_VERSION)) {
    warnings.push(`The built-in LinkedIn API version ${LINKEDIN_DEFAULT_API_VERSION} is a year old or more — set LINKEDIN_API_VERSION to a current version.`);
  }
  if (isSet(env, 'ENCRYPTION_KEY') && Buffer.from(env.ENCRYPTION_KEY!.trim(), 'base64').length !== 32) {
    errors.push('ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).');
  }
  if (opts.production) {
    for (const k of ['APP_URL', 'NEXTAUTH_URL']) {
      if (isSet(env, k) && LOCAL.test(env[k]!.trim())) errors.push(`${k} points at localhost in production — OAuth redirects and Meta callbacks will fail.`);
      if (isSet(env, k) && !/^https:\/\//i.test(env[k]!.trim())) warnings.push(`${k} is not https — Meta requires https callbacks.`);
    }
    if (!isSet(env, 'CRON_SECRET')) warnings.push('CRON_SECRET is not set — scheduled jobs (publishing, WhatsApp retries, connection checks) are refused.');
  }
  // NextAuth sign-in uses NEXTAUTH_URL; connector OAuth redirects use APP_URL (else NEXTAUTH_URL).
  if (isSet(env, 'APP_URL') && isSet(env, 'NEXTAUTH_URL')) {
    const host = (u: string) => {
      try {
        return new URL(u).host;
      } catch {
        return u;
      }
    };
    if (host(env.APP_URL!.trim()) !== host(env.NEXTAUTH_URL!.trim())) {
      warnings.push('APP_URL and NEXTAUTH_URL are different hosts — sign-in and the connector OAuth redirects will use different hosts; register each where it belongs.');
    }
  }
  if (groups.find((g) => g.key === 'meta')?.status === 'ready' && !isSet(env, 'APP_URL') && isSet(env, 'NEXTAUTH_URL') && LOCAL.test(env.NEXTAUTH_URL!)) {
    warnings.push('Meta is configured but the app URL is localhost — Instagram cannot fetch images and Meta cannot reach the callbacks.');
  }
  return { groups, errors, warnings };
}

/** One line per group, names only — safe to log. */
export function formatEnvReport(r: EnvReport): string[] {
  const lines = r.groups.map((g) => {
    const head = `${g.label}: ${g.status === 'missing_core' ? 'MISSING' : g.status.toUpperCase()}`;
    const detail = g.status === 'ready' ? (g.optionalSet.length ? ` (optional set: ${g.optionalSet.join(', ')})` : '') : g.missing.length ? ` — missing ${g.missing.join(', ')}` : '';
    return head + detail;
  });
  return [...lines, ...r.errors.map((e) => `ERROR: ${e}`), ...r.warnings.map((w) => `WARNING: ${w}`)];
}
