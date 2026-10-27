/**
 * `npm run auth:endpoints` — every URL to register with Google, LinkedIn and
 * the rest, for a given base URL. Prints names of environment variables, never
 * values.
 *
 *   npm run auth:endpoints                 use NEXTAUTH_URL / APP_URL from .env
 *   npm run auth:endpoints 8081            http://localhost:8081
 *   npm run auth:endpoints aura.example.com
 *   npm run auth:endpoints https://abc.trycloudflare.com
 *
 * Why a script and not documentation: a doc goes stale the first time a port
 * changes, and a wrong redirect URI fails with `redirect_uri_mismatch`, which
 * names no URL and gives no hint whether the port, the scheme or a trailing
 * slash is the problem.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  nextAuthUrlMismatch,
  normalizeBaseUrl,
  oauthRedirectUris,
  webhookEndpoints,
  type RedirectUri,
} from '@/server/oauth/endpoints';
import { isLocalAppUrl } from '@/lib/app-url';
import { enabledSocialProviders, partiallyConfiguredSocialProviders, SOCIAL_PROVIDERS } from '@/lib/social-signin';

function loadDotEnv() {
  for (const file of ['.env', '.env.local']) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue;
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const value = m[2]!.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
    }
  }
}

const set = (key: string) => Boolean(process.env[key]?.trim());

function print(entries: RedirectUri[]) {
  for (const entry of entries) {
    const ready = entry.credentials.every(set);
    const missing = entry.credentials.filter((c) => !set(c));
    console.log(`\n  ${ready ? 'o' : '.'} ${entry.label}`);
    console.log(`      ${entry.url}`);
    console.log(`      register: ${entry.register}`);
    console.log(`      ${entry.purpose}`);
    if (!ready) console.log(`      needs: ${missing.join(', ')} (not set here)`);
  }
}

loadDotEnv();

const arg = process.argv[2];
const base = normalizeBaseUrl(
  arg ?? process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? '3000',
);

console.log(`\nOAuth endpoints for ${base}`);
console.log('='.repeat(60));
console.log('\n  o = credentials present here   . = credentials not set yet');

console.log('\n\nREDIRECT URIs — paste each into the provider exactly as shown');
console.log('-'.repeat(60));
print(oauthRedirectUris(base));

console.log('\n\nWEBHOOKS — the provider calls these, so they must be reachable');
console.log('-'.repeat(60));
print(webhookEndpoints(base));

console.log('\n\nCHECKS');
console.log('-'.repeat(60));

const mismatch = arg ? nextAuthUrlMismatch(base) : null;
if (mismatch) console.log(`\n  ! ${mismatch}`);
else console.log(`\n  o NEXTAUTH_URL agrees with ${base}`);

const enabled = enabledSocialProviders();
const off = SOCIAL_PROVIDERS.filter((p) => !enabled.includes(p.id));
if (enabled.length) {
  console.log(`  o Sign-in buttons that will render: ${enabled.join(', ')}`);
}
for (const p of off) {
  console.log(
    `  . No ${p.label} button — set ${p.clientIdEnv} and ${p.clientSecretEnv}`,
  );
}
for (const p of partiallyConfiguredSocialProviders()) {
  console.log(
    `  ! ${p.id} has only half its credentials: ${p.missing.join(', ')} missing. The button stays hidden.`,
  );
}

if (isLocalAppUrl(base)) {
  console.log(
    `\n  i ${base} is this machine only. Google and LinkedIn accept http://localhost
    redirect URIs for development, so sign-in works. Meta and the WhatsApp
    webhook do not — those need a public HTTPS URL (a tunnel is enough).`,
  );
}

console.log('\n  i A redirect URI must match character for character: same scheme,');
console.log('    same port, no trailing slash. Register every URL above that you');
console.log('    intend to use; an extra one registered does no harm.\n');
