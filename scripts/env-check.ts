/**
 * `pnpm env:check` — which integrations are configured in .env (or the
 * environment), by variable NAME only. Never prints a value.
 *
 *   pnpm env:check               as local development
 *   pnpm env:check --production  with the production rules (https, no localhost)
 */
import fs from 'node:fs';
import path from 'node:path';

import { checkEnv, formatEnvReport } from '@/lib/env-check';

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

loadDotEnv();
const report = checkEnv(process.env, { production: process.argv.includes('--production') });
for (const line of formatEnvReport(report)) console.log(line);
process.exit(report.errors.length ? 1 : 0);
