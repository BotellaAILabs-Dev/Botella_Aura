/**
 * `pnpm check:oauth` — asks LinkedIn, Google and Meta whether they would
 * accept this app's sign-in and connect requests, without logging in.
 *
 *   pnpm check:oauth                         the URL in NEXTAUTH_URL / APP_URL
 *   pnpm check:oauth https://aura.example.com
 *
 * Exit code 1 when any configured provider refuses, so it can run before a
 * release. Sends only the public client id. See server/oauth/redirect-check.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

import { normalizeBaseUrl, oauthRedirectUris } from '@/server/oauth/endpoints';
import { checkRedirects, type RedirectVerdict } from '@/server/oauth/redirect-check';

for (const file of ['.env', '.env.local']) {
  const p = path.join(process.cwd(), file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
}

const MARK: Record<RedirectVerdict, string> = {
  accepted: '✓',
  redirect_not_registered: '✗',
  scope_not_allowed: '✗',
  unknown_client: '✗',
  no_credentials: '·',
  unchecked: '?',
};

async function main() {
  const base = normalizeBaseUrl(process.argv[2] ?? process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? '3000');
  const entries = oauthRedirectUris(base).filter((e) => /LINKEDIN|GOOGLE|META/.test(e.credentials.join(' ')));
  console.log(`\nOAuth check for ${base}\n`);
  const results = await checkRedirects(entries);
  for (const r of results) {
    console.log(`  ${MARK[r.verdict]} ${r.label}\n      ${r.url}\n      ${r.detail}`);
  }
  const refused = results.filter((r) => MARK[r.verdict] === '✗');
  if (refused.length) {
    console.log(`\n${refused.length} refused. Add each ✗ URL exactly as shown to the provider's app (see \`pnpm auth:endpoints\` for where), then run this again.`);
    process.exit(1);
  }
  console.log('\nNo provider refused.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
