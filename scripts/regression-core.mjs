/**
 * `pnpm regression:core` — the core workflow regression, in one run:
 * workspace setup → content creation → approval, plus the sign-in and
 * connection checks. Prints a summary to paste into the Jira regression
 * ticket (docs/QA-PROCESS.md).
 *
 *   pnpm regression:core              config, unit tests, DB + live-AI checks
 *   pnpm regression:core --with-app   also the checks that need `pnpm dev` running
 *
 * Each step runs on its own; one failing does not stop the rest, so the
 * summary shows everything that is broken at once.
 */
import { spawnSync } from 'node:child_process';

const withApp = process.argv.includes('--with-app');

const STEPS = [
  { id: 'env', name: 'Configuration (env:check)', cmd: 'npx tsx scripts/env-check.ts' },
  { id: 'oauth', name: 'LinkedIn / Google / Meta accept our redirect URLs (check:oauth)', cmd: 'npx tsx scripts/check-oauth.ts' },
  { id: 'migrations', name: 'Database migrations applied', cmd: 'npx prisma migrate status' },
  { id: 'unit', name: 'Unit and component tests (vitest)', cmd: 'npx vitest run --reporter=dot' },
  { id: 'onboarding', name: 'Workspace setup reaches content prompts (verify:onboarding)', cmd: 'npx tsx scripts/verify-onboarding.ts' },
  { id: 'studio', name: 'Content Studio with the real AI writer (verify:content-studio)', cmd: 'npx tsx scripts/verify-content-studio.ts' },
  { id: 'approval', name: 'Approval rules (verify:approval)', cmd: 'npx tsx scripts/verify-approval.ts', app: true },
  { id: 'connections', name: 'Connection manager (verify:connections)', cmd: 'npx tsx scripts/verify-connections.ts', app: true },
  { id: 'meta', name: 'Facebook & Instagram connection (verify:meta)', cmd: 'npx tsx scripts/verify-meta.ts', app: true },
];

const results = [];
for (const step of STEPS) {
  if (step.app && !withApp) {
    results.push({ ...step, status: 'SKIPPED', ms: 0, note: 'needs the app running: add --with-app' });
    continue;
  }
  process.stdout.write(`\n▶ ${step.name}\n`);
  const started = Date.now();
  const r = spawnSync(step.cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const tail = out.trim().split(/\r?\n/).filter(Boolean).slice(-4).join('\n    ');
  results.push({ ...step, status: r.status === 0 ? 'PASS' : 'FAIL', ms: Date.now() - started, note: r.status === 0 ? '' : tail });
  process.stdout.write(`  ${r.status === 0 ? 'PASS' : 'FAIL'} (${((Date.now() - started) / 1000).toFixed(0)}s)\n`);
}

const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
console.log(`\n\n===== Core regression — ${stamp} UTC =====`);
for (const r of results) {
  console.log(`[${r.status}] ${r.name}${r.ms ? ` (${(r.ms / 1000).toFixed(0)}s)` : ''}`);
  if (r.note) console.log(`    ${r.note}`);
}
const failed = results.filter((r) => r.status === 'FAIL');
console.log(failed.length ? `\n${failed.length} failed — raise or update a Jira blocker for each (docs/QA-PROCESS.md).` : '\nAll run steps passed.');
process.exit(failed.length ? 1 : 0);
