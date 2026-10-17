/**
 * Sprint 9 test plan, in one run: every end-to-end suite that covers the
 * Sprint 9 flow, against the running app and the real database, then a
 * summary. Each suite creates and removes its own throwaway workspace.
 *
 *   Full flow                       verify:sprint9
 *   Recommendation → Creation       verify:creation
 *   Context assembly                verify:context-handoff, verify:content-brief, verify:generation-context
 *   Content generation              verify:contextual-generation, verify:variations
 *   Image generation                verify:graphics, verify:visual-context, verify:creative
 *   Factual validation              verify:fact-check
 *   Reviewer model                  verify:review, verify:compliance
 *   Approval lifecycle              verify:approval, verify:unified-review
 *   Versioning                      verify:versions, verify:trace
 *   Permission / isolation          verify:permissions, verify:recommendation-security, verify:access
 *   Failure / retry                 verify:failure-recovery
 *   Content Studio regression       verify:content-studio, verify:publishing, verify:multi-publish
 *   Campaign / Outreach / Execution verify:instagram-api (+ unit tests)
 *   Connection Manager              verify:connections
 *   Responsive UI                   verify:responsive
 *
 * Suites that need the live model or an image provider say what they could
 * not exercise; that is reported, not counted as a pass of something unrun.
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:sprint9:all
 *   SUITES=sprint9,permissions  to run a subset.
 */
import { spawnSync } from 'node:child_process';

const PLAN: { area: string; suites: string[] }[] = [
  { area: 'Full flow (Business Context → Ready for Execution)', suites: ['sprint9'] },
  { area: 'Recommendation → Creation', suites: ['creation'] },
  { area: 'Context assembly', suites: ['context-handoff', 'content-brief', 'generation-context'] },
  { area: 'Content generation', suites: ['contextual-generation', 'variations'] },
  { area: 'Image generation', suites: ['graphics', 'visual-context', 'creative'] },
  { area: 'Factual validation', suites: ['fact-check'] },
  { area: 'Reviewer model', suites: ['review', 'compliance'] },
  { area: 'Approval lifecycle', suites: ['approval', 'unified-review'] },
  { area: 'Versioning', suites: ['versions', 'trace'] },
  { area: 'Permission / isolation', suites: ['permissions', 'recommendation-security', 'access'] },
  { area: 'Failure / retry', suites: ['failure-recovery'] },
  { area: 'Content Studio regression', suites: ['content-studio', 'publishing', 'multi-publish'] },
  { area: 'Campaign / Outreach / Execution', suites: ['instagram-api'] },
  { area: 'Connection Manager (Sprint 10 connections)', suites: ['connections'] },
  { area: 'Responsive UI', suites: ['responsive'] },
];

const only = process.env.SUITES?.split(',').map((s) => s.trim()).filter(Boolean);
const results: { area: string; suite: string; ok: boolean; checks: number; broken: number; notes: number; seconds: number }[] = [];

for (const { area, suites } of PLAN) {
  for (const suite of suites) {
    if (only && !only.includes(suite)) continue;
    const started = Date.now();
    process.stdout.write(`\n=== ${area} — verify:${suite}\n`);
    const run = spawnSync('npx', ['tsx', `scripts/verify-${suite}.ts`], {
      encoding: 'utf8',
      shell: true,
      // Older suites read AURA_URL; newer ones VERIFY_BASE_URL — the same app.
      env: { ...process.env, AURA_URL: process.env.AURA_URL ?? process.env.VERIFY_BASE_URL },
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const lines = out.split('\n').filter((l) => !l.startsWith('{"level"'));
    const checks = lines.filter((l) => /^\s+(ok|PASS)\s/.test(l)).length;
    const broken = lines.filter((l) => /BROKEN/.test(l)).length;
    const notes = lines.filter((l) => /^\s+note\s|not exercised|unavailable/i.test(l)).length;
    for (const l of lines.filter((x) => /BROKEN|^\s+note\s/.test(x))) process.stdout.write(`${l}\n`);
    process.stdout.write(`${lines.filter(Boolean).slice(-1)[0] ?? ''}\n`);
    results.push({ area, suite, ok: run.status === 0, checks, broken, notes, seconds: Math.round((Date.now() - started) / 1000) });
  }
}

console.log('\n\nSprint 9 test plan — summary');
console.log('area | suite | result | checks | broken | notes | s');
for (const r of results) {
  console.log(`${r.area} | verify:${r.suite} | ${r.ok ? 'pass' : 'FAIL'} | ${r.checks} | ${r.broken} | ${r.notes} | ${r.seconds}`);
}
const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} suites passed, ${results.reduce((n, r) => n + r.checks, 0)} checks.` +
    (failed.length ? ` FAILED: ${failed.map((r) => r.suite).join(', ')}` : ''),
);
process.exit(failed.length ? 1 : 0);
