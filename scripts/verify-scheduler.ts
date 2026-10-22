/**
 * The publishing scheduler, end to end against the REAL database — the real
 * scheduler, publication claims, execution lifecycle and routing — with only
 * LinkedIn's API replaced by a counter, so "published exactly once" can be
 * proven under concurrency. No network calls are made.
 *
 *   Scheduled execution   due posts publish; not-yet-due posts don't
 *   Timezone              09:00 in the workspace's zone is the instant used
 *   Approval              unapproved or changed-since-approval posts never go
 *   Duplicates            three overlapping runs → each post sent once
 *   Retry                 rate limit → automatic retry after backoff; other
 *                         failures wait for a person (Retry now)
 *   Time budget           a run past its budget defers, the next run catches up
 *   Cancel                a cancelled execution is never published
 *
 * Run: pnpm verify:scheduler   (database only — the app need not be running)
 */
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { zonedToUtc } from '@/lib/timezone';
import { contentHash } from '@/server/approval/approval.service';
import { prepareExecutionHandoff } from '@/server/execution/execution-handoff.service';
import { runScheduledPublishes } from '@/server/content/publish.service';
import { cancelExecution, retryExecution, runExecutionSweep } from '@/server/execution/execution-actions.service';

const STAMP = Date.now();
const DAY = 24 * 60 * 60_000;
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok      ${label}`);
  else {
    failures++;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- The fake LinkedIn: counts posts per marker, answers per mode -----------
const sent = new Map<string, number>();
const mode = new Map<string, 'ok' | '429' | '500'>();
let seq = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('api.linkedin.com/rest/posts')) {
    const body = String(init?.body ?? '');
    const marker = /MARK-[a-z0-9]+/.exec(body)?.[0] ?? 'unknown';
    sent.set(marker, (sent.get(marker) ?? 0) + 1);
    await new Promise((r) => setTimeout(r, 150)); // widen the race window
    const m = mode.get(marker) ?? 'ok';
    if (m === '429') return new Response('{"message":"Too many requests"}', { status: 429 });
    if (m === '500') return new Response('{"message":"Internal error"}', { status: 500 });
    return new Response('', { status: 201, headers: { 'x-restli-id': `urn:li:share:${++seq}` } });
  }
  if (/linkedin\.com/.test(url)) throw new Error(`unexpected LinkedIn call: ${url}`);
  return realFetch(input, init);
}) as typeof fetch;

async function main() {
  const user = await db.user.create({ data: { email: `zzverify-sched-${STAMP}@example.test` } });
  const company = await db.company.create({ data: { name: `zzverify Scheduler ${STAMP}`, slug: `zzverify-sched-${STAMP}`, timezone: 'Asia/Kolkata' } });
  await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'OWNER' } });
  const companyId = company.id;
  await db.linkedInConnection.create({
    data: { companyId, linkedInUserId: 'li_sched', displayName: 'Sam Scheduler', accessTokenEnc: encrypt('FAKE_TOKEN'), scope: 'openid profile email w_member_social', expiresAt: new Date(Date.now() + 30 * DAY), status: 'ACTIVE', connectedAt: new Date() },
  });

  /** An approved LinkedIn post (approval record + handoff), due at `at`. */
  async function post(marker: string, at: Date | null, status: 'APPROVED' | 'PENDING_APPROVAL' = 'APPROVED') {
    const d = await db.contentDraft.create({
      data: { companyId, type: 'LINKEDIN_POST', platform: 'LINKEDIN', status, title: marker, body: { hook: `${marker} — fresh bread.`, paragraphs: ['One.', 'Two.', 'Three.'], cta: 'Visit us.', hashtags: [] }, scheduledFor: at },
    });
    if (status === 'APPROVED') {
      const hash = await contentHash(d);
      await db.contentDraft.update({
        where: { id: d.id },
        data: { aiMetadata: { approval: { model: 1, version: 1, hash, approved: { by: user.id, via: 'person', at: new Date().toISOString(), version: 1, hash, snapshot: null }, rejected: null, events: [] } } as Prisma.InputJsonObject },
      });
      await prepareExecutionHandoff({ companyId, draftId: d.id, userId: user.id });
    }
    return d;
  }
  const execOf = (id: string) => db.execution.findUnique({ where: { contentDraftId_platform: { contentDraftId: id, platform: 'LINKEDIN' } }, include: { events: { orderBy: { at: 'asc' } } } });
  const mark = () => `MARK-${Math.random().toString(36).slice(2, 10)}`;

  try {
    // ------------------------------------------------------------- timezone
    console.log('\nScheduled execution & timezone (workspace: Asia/Kolkata)');
    const day = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
    const at = zonedToUtc(`${day}T09:00`, 'Asia/Kolkata').at;
    check('09:00 in Kolkata is 03:30 UTC', at.toISOString() === `${day}T03:30:00.000Z`, at.toISOString());
    const mTz = mark();
    const tzPost = await post(mTz, at);
    const tzExec = await execOf(tzPost.id);
    check('the approved post is Scheduled for that instant', tzExec?.status === 'SCHEDULED' && tzExec.scheduledFor?.getTime() === at.getTime(), tzExec?.status);
    await runScheduledPublishes(new Date(at.getTime() - 60_000));
    check('a minute before (08:59 Kolkata): not published', !sent.has(mTz) && (await execOf(tzPost.id))?.status === 'SCHEDULED');
    await runScheduledPublishes(new Date(at.getTime() + 1000));
    const tzDone = await execOf(tzPost.id);
    check('at 09:00 Kolkata: published once; execution Completed (Scheduled → Queued → Executing → Completed)', sent.get(mTz) === 1 && tzDone?.status === 'COMPLETED' && tzDone.events.map((e) => e.to).join(',').endsWith('SCHEDULED,QUEUED,EXECUTING,COMPLETED'), `${sent.get(mTz)} ${tzDone?.status} ${tzDone?.events.map((e) => e.to).join(',')}`);

    // ------------------------------------------------------------- approval
    console.log('\nApproval is respected');
    const past = new Date(Date.now() - 60_000);
    const mPend = mark();
    const mEdit = mark();
    const pend = await post(mPend, past, 'PENDING_APPROVAL');
    const edited = await post(mEdit, past);
    await db.contentDraft.update({ where: { id: edited.id }, data: { body: { hook: `${mEdit} — changed after approval.`, paragraphs: ['One.', 'Two.', 'Three.'], cta: 'Visit us.', hashtags: [] } } });
    await runScheduledPublishes();
    check('a post awaiting approval is never published by the scheduler', !sent.has(mPend) && (await db.contentDraft.findUnique({ where: { id: pend.id } }))?.status === 'PENDING_APPROVAL');
    check('a post changed after approval is refused (only what was approved goes out)', !sent.has(mEdit));

    // ------------------------------------------------------------- concurrency
    console.log('\nDuplicate prevention under concurrency');
    const marks = Array.from({ length: 5 }, mark);
    const posts = await Promise.all(marks.map((m) => post(m, new Date(Date.now() - 5 * 60_000))));
    const runs = await Promise.all([runScheduledPublishes(), runScheduledPublishes(), runScheduledPublishes()]);
    check('three overlapping runs: each of 5 due posts sent exactly once', marks.every((m) => sent.get(m) === 1), marks.map((m) => sent.get(m) ?? 0).join(','));
    check('…the runs reported 5 published in total', runs.reduce((n, r) => n + r.published, 0) === 5, JSON.stringify(runs));
    const pubs = await db.contentPublication.findMany({ where: { contentDraftId: { in: posts.map((p) => p.id) } } });
    check('one publication record per post, Published, attempt 1', pubs.length === 5 && pubs.every((p) => p.status === 'PUBLISHED' && p.attempts === 1 && p.url?.includes('urn:li:share')));
    const execs = await Promise.all(posts.map((p) => execOf(p.id)));
    check('every execution Completed after one attempt', execs.every((e) => e?.status === 'COMPLETED' && e.attemptCount === 1), execs.map((e) => `${e?.status}/${e?.attemptCount}`).join(' '));
    check('every draft marked Published', (await db.contentDraft.count({ where: { id: { in: posts.map((p) => p.id) }, status: 'PUBLISHED' } })) === 5);
    await runScheduledPublishes();
    check('a later run sends nothing again', marks.every((m) => sent.get(m) === 1));

    // ------------------------------------------------------------- retry
    console.log('\nRetry');
    const mRl = mark();
    mode.set(mRl, '429');
    const rl = await post(mRl, past);
    await runScheduledPublishes();
    let rlExec = await execOf(rl.id);
    check('LinkedIn rate-limits it → Failed (rate_limited), automatic retry scheduled', rlExec?.status === 'FAILED' && rlExec.errorCode === 'rate_limited' && Boolean(rlExec.nextAttemptAt) && sent.get(mRl) === 1, `${rlExec?.status} ${rlExec?.errorCode}: ${rlExec?.errorMessage}`);
    await runScheduledPublishes();
    check('the scheduler does not hammer it before the backoff', sent.get(mRl) === 1);
    mode.set(mRl, 'ok');
    await db.execution.update({ where: { id: rlExec!.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await runExecutionSweep();
    rlExec = await execOf(rl.id);
    check('after the backoff: retried once and published (attempt 2, Completed)', sent.get(mRl) === 2 && rlExec?.status === 'COMPLETED' && rlExec.attemptCount === 2, `${sent.get(mRl)} ${rlExec?.status} ${rlExec?.attemptCount}`);

    const mErr = mark();
    mode.set(mErr, '500');
    const err = await post(mErr, past);
    await runScheduledPublishes();
    await runScheduledPublishes();
    let errExec = await execOf(err.id);
    check('another failure → Failed with its error, never retried automatically', errExec?.status === 'FAILED' && !errExec.nextAttemptAt && Boolean(errExec.errorMessage) && sent.get(mErr) === 1, `${errExec?.status} ${sent.get(mErr)}`);
    mode.set(mErr, 'ok');
    await retryExecution({ companyId, userId: user.id, role: 'OWNER', id: errExec!.id });
    errExec = await execOf(err.id);
    check('a person’s Retry now publishes it (attempt 2)', sent.get(mErr) === 2 && errExec?.status === 'COMPLETED' && errExec.attemptCount === 2, `${sent.get(mErr)} ${errExec?.status}`);

    // ------------------------------------------------------------- budget
    console.log('\nTime budget');
    const budgetMarks = [mark(), mark(), mark()];
    await Promise.all(budgetMarks.map((m) => post(m, past)));
    const r1 = await runScheduledPublishes(new Date(), { deadline: new Date(Date.now() - 1) });
    check('past its budget, a run starts nothing and defers the rest', r1.deferred >= 3 && budgetMarks.every((m) => !sent.has(m)), JSON.stringify(r1));
    await runScheduledPublishes();
    check('the next run catches up (each sent once)', budgetMarks.every((m) => sent.get(m) === 1));

    // ------------------------------------------------------------- cancel
    console.log('\nCancel');
    const mCan = mark();
    const can = await post(mCan, new Date(Date.now() + DAY));
    const canExec = await execOf(can.id);
    await cancelExecution({ companyId, userId: user.id, role: 'OWNER', id: canExec!.id, reason: 'not needed' });
    await db.contentDraft.update({ where: { id: can.id }, data: { scheduledFor: past } }); // even if a time reappears
    await runScheduledPublishes();
    check('a cancelled execution is never published by the scheduler', !sent.has(mCan));
  } finally {
    globalThis.fetch = realFetch;
    await db.auditLog.deleteMany({ where: { OR: [{ companyId }, { userId: user.id }] } });
    await db.company.delete({ where: { id: companyId } });
    await db.user.delete({ where: { id: user.id } });
    console.log('\n  ok      cleanup: throwaway workspace removed');
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll scheduler checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  globalThis.fetch = realFetch;
  console.error(err);
  process.exit(1);
});
