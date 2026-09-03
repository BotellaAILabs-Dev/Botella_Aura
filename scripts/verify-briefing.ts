/**
 * End-to-end verification of the autonomous weekly cycle.
 *
 * Runs the REAL autopilot and briefing assembly against the REAL database, and
 * checks the behaviours that matter most: it degrades honestly without API
 * keys, it never auto-approves, and it is idempotent per week so a retried
 * cron cannot double-spend.
 *
 * Run with:  pnpm verify:briefing
 */
try {
  process.loadEnvFile();
} catch {
  // .env is optional — vars may already be set in the shell.
}

import { db } from '@/lib/db';
import { runAutopilot, readAutopilotSettings } from '@/server/briefing/autopilot.service';
import {
  assembleBriefing,
  generateBriefing,
  getLatestBriefing,
  toBriefingView,
} from '@/server/briefing/briefing.service';
import { startOfIsoWeekUTC } from '@/server/competitors/report.service';
import { readBriefingPayload } from '@/lib/validations/briefing';

const ok = (label: string, detail = '') =>
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label: string, detail: string) => {
  console.error(`  FAIL  ${label} — ${detail}`);
  process.exitCode = 1;
};

async function main() {
  const company = await db.company.findFirst({ where: { slug: 'botella-demo' } });
  if (!company) throw new Error('demo data missing — run pnpm db:seed:demo');
  const weekStart = startOfIsoWeekUTC(new Date());
  console.log(`\nworkspace ${company.slug} · week of ${weekStart.toISOString().slice(0, 10)}\n`);

  // --- 1. settings --------------------------------------------------------
  console.log('1. Autopilot settings');
  const settings = readAutopilotSettings(company);
  settings.enabled
    ? ok('defaults to enabled', `${settings.postsPerWeek} posts/week, graphics ${settings.generateGraphics}`)
    : fail('settings', 'disabled by default');

  const off = readAutopilotSettings({ preferences: { autopilot: { enabled: false } } });
  !off.enabled ? ok('respects an explicit off switch') : fail('settings', 'ignored the off switch');

  const capped = readAutopilotSettings({ preferences: { autopilot: { postsPerWeek: 999 } } });
  capped.postsPerWeek <= 5
    ? ok('caps runaway config', `999 -> ${capped.postsPerWeek}`)
    : fail('settings', `uncapped: ${capped.postsPerWeek}`);

  // --- 2. assembly is pure ------------------------------------------------
  console.log('\n2. Assembly (no model calls, no writes)');
  const before = await db.contentDraft.count({ where: { companyId: company.id } });
  const payload = await assembleBriefing({
    companyId: company.id,
    weekStart,
    weekEnd: new Date(weekStart.getTime() + 7 * 86_400_000 - 1),
  });
  const after = await db.contentDraft.count({ where: { companyId: company.id } });
  before === after ? ok('assembling created no content') : fail('assembly', 'it wrote something');
  ok('headline', payload.headline);
  ok('sections', `calendar ${payload.calendar.length}, ready ${payload.readyContent.length}, competitors ${payload.competitorMoves.length}, recs ${payload.recommendations.length}, insights ${payload.insights.length}`);
  payload.coverage.skipped.length > 0
    ? ok('reports gaps honestly', payload.coverage.skipped.map((s) => s.source).join(', '))
    : ok('no gaps to report');

  // --- 3. schema tolerance ------------------------------------------------
  console.log('\n3. Payload tolerance');
  const older = readBriefingPayload({ headline: 'from an older build' });
  older.calendar.length === 0 && older.headline === 'from an older build'
    ? ok('a payload missing new fields still parses')
    : fail('tolerance', 'older payload did not survive');
  readBriefingPayload('nonsense').calendar.length === 0
    ? ok('garbage never throws')
    : fail('tolerance', 'threw on garbage');

  // --- 4. a real autopilot run --------------------------------------------
  console.log('\n4. Autopilot run (no API keys configured here)');
  const draftsBefore = await db.contentDraft.count({ where: { companyId: company.id } });
  const result = await runAutopilot({ companyId: company.id, userId: null, force: true });
  const draftsAfter = await db.contentDraft.count({ where: { companyId: company.id } });

  ok('completed without throwing', `ran=${result.ran}`);
  console.log(`        drafts ${draftsBefore} -> ${draftsAfter}, graphics ${result.activity.graphicsGenerated}`);
  for (const s of result.activity.skipped) console.log(`        skipped: ${s}`);
  result.activity.skipped.length > 0 || result.activity.draftsWritten > 0
    ? ok('either did work or explained why it could not')
    : fail('autopilot', 'silently did nothing');

  // --- 5. the approval gate -----------------------------------------------
  console.log('\n5. The approval gate');
  const approvedByAgent = await db.contentDraft.count({
    where: { companyId: company.id, status: { in: ['APPROVED', 'PUBLISHED'] }, createdById: null },
  });
  approvedByAgent === 0
    ? ok('nothing the agent produced is approved or published')
    : fail('APPROVAL GATE', `${approvedByAgent} agent items are already approved`);

  // --- 6. idempotency -----------------------------------------------------
  console.log('\n6. Idempotency (a retried cron must not double-spend)');
  const beforeRetry = await db.contentDraft.count({ where: { companyId: company.id } });
  const retry = await runAutopilot({ companyId: company.id, userId: null });
  const afterRetry = await db.contentDraft.count({ where: { companyId: company.id } });
  !retry.ran && beforeRetry === afterRetry
    ? ok('a second run in the same week wrote nothing', retry.reason ?? '')
    : fail('idempotency', `ran=${retry.ran}, drafts ${beforeRetry} -> ${afterRetry}`);

  // --- 7. persistence -----------------------------------------------------
  console.log('\n7. Briefing row');
  const row = await getLatestBriefing(company.id);
  if (!row) { fail('persistence', 'no briefing stored'); return; }
  const view = toBriefingView(row);
  view.isCurrentWeek ? ok('stored for the current week') : fail('persistence', 'wrong week');
  view.status === 'READY' ? ok('status READY') : fail('persistence', `status ${view.status}`);
  !view.read ? ok('starts unread') : fail('persistence', 'already marked read');

  const count = await db.workspaceBriefing.count({
    where: { companyId: company.id, weekStart },
  });
  count === 1 ? ok('exactly one briefing per week') : fail('persistence', `${count} rows for this week`);

  // Re-generating replaces rather than duplicating.
  await generateBriefing({ companyId: company.id, userId: null });
  const after2 = await db.workspaceBriefing.count({ where: { companyId: company.id, weekStart } });
  after2 === 1 ? ok('re-generating replaces, never duplicates') : fail('persistence', `${after2} rows`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error('\nVERIFICATION ERROR:', err);
    process.exitCode = 1;
    await db.$disconnect();
  });
