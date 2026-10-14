/**
 * WhatsApp load test (Phase 8). Measures the real pipeline — signed webhook →
 * Postgres queue → worker → Aura services → reply — under many people at once.
 *
 * Setup (seeded straight into the database, removed afterwards):
 *   LOAD_COMPANIES workspaces (default 50), each with campaigns and drafts
 *   LOAD_LINKED    linked WhatsApp users (default 800), all four roles
 *   LOAD_NEW       never-seen numbers (default 200) — the sign-in path
 *
 * Traffic: linked users send "show my active campaigns", "What content is
 * awaiting approval?", "menu"; new numbers send "Hi" twice. LOAD_DUPES (10%)
 * of webhooks are delivered twice, as Meta does. LOAD_CONCURRENCY requests in
 * flight at once (default 200). The app must point at the Meta stub
 * (WHATSAPP_GRAPH_BASE_URL) — never at Meta.
 *
 * Checks: every message stored once and answered exactly once; each person's
 * messages answered in order; every reply names only that person's own
 * workspace; nothing dead-lettered. Reports latency percentiles and drain time.
 *
 * Run: LOAD_BASE_URL=http://localhost:3002 npx tsx scripts/load/whatsapp-load.ts
 */
import { db } from '@/lib/db';
import { encrypt, keyedHash } from '@/lib/crypto';
import { signPayload } from '@/lib/whatsapp';

const BASE = (process.env.LOAD_BASE_URL ?? 'http://localhost:3002').replace(/\/$/, '');
const STUB = (process.env.STUB_URL ?? 'http://localhost:4010').replace(/\/$/, '');
const SECRET = process.env.WHATSAPP_APP_SECRET ?? '';
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
const CRON = process.env.CRON_SECRET ?? '';
const COMPANIES = Number(process.env.LOAD_COMPANIES ?? 50);
const LINKED = Number(process.env.LOAD_LINKED ?? 800);
const NEW = Number(process.env.LOAD_NEW ?? 200);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 200);
const DUPES = Number(process.env.LOAD_DUPES ?? 0.1);
const STAMP = Date.now();
const ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!);
};
const number = (i: number) => `1555${String(STAMP).slice(-3)}${String(i).padStart(5, '0')}`;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? 'ok    ' : 'BROKEN'}  ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function seed() {
  const companies = Array.from({ length: COMPANIES }, (_, i) => ({ id: `zzload_co_${STAMP}_${i}`, name: `zzload Co${i}-${STAMP}`, slug: `zzload-${STAMP}-${i}` }));
  await db.company.createMany({ data: companies });
  await db.campaign.createMany({
    data: companies.flatMap((c, i) => [
      { companyId: c.id, name: `Campaign A of ${c.name}`, status: 'ACTIVE' as const },
      { companyId: c.id, name: `Campaign B of ${c.name}`, status: i % 2 ? ('PAUSED' as const) : ('ACTIVE' as const) },
    ]),
  });
  await db.contentDraft.createMany({
    data: companies.flatMap((c) =>
      ['PENDING_APPROVAL', 'DRAFT', 'APPROVED'].map((status) => ({
        companyId: c.id,
        type: 'LINKEDIN_POST' as const,
        status: status as 'DRAFT',
        title: `Post of ${c.name}`,
        body: { hook: `Hello from ${c.name}`, paragraphs: ['a', 'b', 'c'], cta: '', hashtags: [] },
      })),
    ),
  });
  const users = Array.from({ length: LINKED }, (_, i) => ({ id: `zzload_u_${STAMP}_${i}`, email: `zzload-${STAMP}-${i}@example.test` }));
  await db.user.createMany({ data: users });
  await db.companyMember.createMany({
    data: users.map((u, i) => ({ userId: u.id, companyId: companies[i % COMPANIES]!.id, role: ROLES[i % ROLES.length]! })),
  });
  const now = new Date();
  const convs = users.map((u, i) => {
    const waId = number(i);
    return { id: `zzload_cv_${STAMP}_${i}`, waIdHash: keyedHash(waId, 'whatsapp-wa-id'), waIdEncrypted: encrypt(waId), waIdLast4: waId.slice(-4), lastInboundAt: now, profileName: `Load ${i}` };
  });
  await db.whatsAppConversation.createMany({ data: convs });
  await db.whatsAppAccountLink.createMany({
    data: users.map((u, i) => ({
      conversationId: convs[i]!.id,
      userId: u.id,
      activeCompanyId: companies[i % COMPANIES]!.id,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    })),
  });
  return { companies, users };
}

interface Sent {
  wamid: string;
  from: string;
  text: string;
  /** Index of the user (linked) or -1-index (new). */
  who: number;
  order: number;
}

function webhook(s: Sent) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, contacts: [{ wa_id: s.from, profile: { name: 'Load' } }], messages: [{ from: s.from, id: s.wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: s.text } }] } }] }],
  });
}

async function main() {
  if (!SECRET || !PHONE_ID || !CRON) {
    console.error('Set WHATSAPP_APP_SECRET, WHATSAPP_PHONE_NUMBER_ID and CRON_SECRET (the values the app runs with).');
    process.exit(2);
  }
  const stub = await fetch(`${STUB}/stats`).catch(() => null);
  if (!stub?.ok) {
    console.error(`The Meta stub is not running at ${STUB} (npx tsx scripts/load/meta-stub.ts).`);
    process.exit(2);
  }
  await fetch(`${STUB}/reset`, { method: 'POST' });

  console.log(`Seeding ${COMPANIES} workspaces, ${LINKED} linked users…`);
  const t0 = Date.now();
  const { companies } = await seed();
  console.log(`  seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Each person's messages in order; people interleaved.
  const scripts: Sent[][] = [];
  for (let i = 0; i < LINKED; i++) {
    scripts.push(['show my active campaigns', 'What content is awaiting approval?', 'menu'].map((text, order) => ({ wamid: `wamid.LOAD${STAMP}.${i}.${order}`, from: number(i), text, who: i, order })));
  }
  for (let j = 0; j < NEW; j++) {
    scripts.push(['Hi', 'Hi again'].map((text, order) => ({ wamid: `wamid.LOAD${STAMP}.n${j}.${order}`, from: number(LINKED + j), text, who: -1 - j, order })));
  }
  const queue: { s: Sent; dupe: boolean }[] = [];
  const maxLen = Math.max(...scripts.map((x) => x.length));
  for (let k = 0; k < maxLen; k++) for (const sc of scripts) if (sc[k]) queue.push({ s: sc[k]!, dupe: false });
  const unique = queue.length;
  for (let k = 0; k < Math.round(unique * DUPES); k++) queue.push({ s: queue[Math.floor(Math.random() * unique)]!.s, dupe: true });

  console.log(`Sending ${queue.length} webhooks (${unique} messages + ${queue.length - unique} redeliveries) from ${scripts.length} people, ${CONCURRENCY} at a time…`);
  const latencies: number[] = [];
  const statuses: Record<number, number> = {};
  let next = 0;
  const sendStart = Date.now();
  // Per person, a message is sent only after their previous one was
  // acknowledged — as a phone would — so order is meaningful.
  const ackedUpTo = new Map<string, number>();
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= queue.length) return;
      const { s, dupe } = queue[i]!;
      while (!dupe && (ackedUpTo.get(s.from) ?? -1) < s.order - 1) await new Promise((r) => setTimeout(r, 5));
      const raw = webhook(s);
      const t = performance.now();
      const res = await fetch(`${BASE}/api/webhooks/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signPayload(raw, SECRET) },
        body: raw,
      }).catch(() => null);
      latencies.push(performance.now() - t);
      statuses[res?.status ?? 0] = (statuses[res?.status ?? 0] ?? 0) + 1;
      await res?.text().catch(() => '');
      if (!dupe) ackedUpTo.set(s.from, Math.max(ackedUpTo.get(s.from) ?? -1, s.order));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const sendSecs = (Date.now() - sendStart) / 1000;

  console.log('Waiting for the queue to drain (running the sweep as cron would)…');
  const convIds = (await db.whatsAppConversation.findMany({ where: { waIdHash: { in: scripts.map((sc) => keyedHash(sc[0]!.from, 'whatsapp-wa-id')) } }, select: { id: true } })).map((c) => c.id);
  const drainStart = Date.now();
  let lastSweep = 0;
  for (;;) {
    const [open, pendingSends] = await Promise.all([
      db.whatsAppJob.count({ where: { conversationId: { in: convIds }, status: { in: ['QUEUED', 'RUNNING'] } } }),
      db.whatsAppMessage.count({ where: { conversationId: { in: convIds }, direction: 'OUTBOUND', status: 'PENDING' } }),
    ]);
    if (open === 0 && pendingSends === 0) break;
    if (Date.now() - drainStart > 15 * 60_000) {
      console.log(`  gave up waiting: ${open} jobs, ${pendingSends} sends still open`);
      break;
    }
    if (Date.now() - lastSweep > 15_000) {
      lastSweep = Date.now();
      await fetch(`${BASE}/api/cron/whatsapp`, { headers: { authorization: `Bearer ${CRON}` } }).catch(() => null);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const allDoneSecs = (Date.now() - sendStart) / 1000;

  // ---- What actually happened, from the database and the stub -----------
  const inbound = await db.whatsAppMessage.findMany({ where: { conversationId: { in: convIds }, direction: 'INBOUND' }, select: { id: true, wamid: true, conversationId: true, createdAt: true } });
  const outbound = await db.whatsAppMessage.findMany({ where: { conversationId: { in: convIds }, direction: 'OUTBOUND' }, select: { replyToId: true, status: true, body: true, payload: true, conversationId: true, createdAt: true } });
  const jobs = await db.whatsAppJob.findMany({ where: { conversationId: { in: convIds } }, select: { status: true, createdAt: true, startedAt: true, finishedAt: true, attempts: true, messageId: true } });
  const stubStats = (await (await fetch(`${STUB}/stats`)).json()) as Record<string, number>;

  const repliesPer = new Map<string, number>();
  for (const o of outbound) if (o.replyToId) repliesPer.set(o.replyToId, (repliesPer.get(o.replyToId) ?? 0) + 1);
  const unanswered = inbound.filter((m) => !repliesPer.has(m.id)).length;
  const twice = [...repliesPer.values()].filter((n) => n > 1).length;

  // Order: each person's messages finished in the order they were sent.
  const msgOrder = new Map(inbound.map((m) => [m.id, Number(m.wamid!.split('.').pop())]));
  const byConv = new Map<string, { order: number; finished: number }[]>();
  const convOf = new Map(inbound.map((m) => [m.id, m.conversationId]));
  for (const j of jobs) {
    if (!j.finishedAt) continue;
    const c = convOf.get(j.messageId)!;
    (byConv.get(c) ?? byConv.set(c, []).get(c)!).push({ order: msgOrder.get(j.messageId)!, finished: j.finishedAt.getTime() });
  }
  const outOfOrder = [...byConv.values()].filter((xs) => {
    const s = [...xs].sort((a, b) => a.order - b.order);
    return s.some((x, i) => i > 0 && x.finished < s[i - 1]!.finished);
  }).length;

  // Isolation: each linked person's campaign reply names their workspace only.
  const linkedConvCompany = new Map<string, string>();
  const links = await db.whatsAppAccountLink.findMany({ where: { conversationId: { in: convIds } }, select: { conversationId: true, activeCompanyId: true } });
  const nameOf = new Map(companies.map((c) => [c.id, c.name]));
  for (const l of links) if (l.activeCompanyId) linkedConvCompany.set(l.conversationId, nameOf.get(l.activeCompanyId)!);
  let leaked = 0;
  let campaignReplies = 0;
  for (const o of outbound) {
    const own = linkedConvCompany.get(o.conversationId);
    const body = o.body ?? '';
    if (!own || !body.includes('*Campaigns*')) continue;
    campaignReplies++;
    const mentioned = companies.filter((c) => body.includes(c.name)).map((c) => c.name);
    if (mentioned.some((n) => n !== own)) leaked++;
  }

  const queueWait = jobs.filter((j) => j.startedAt).map((j) => j.startedAt!.getTime() - j.createdAt.getTime());
  const jobTime = jobs.filter((j) => j.startedAt && j.finishedAt).map((j) => j.finishedAt!.getTime() - j.startedAt!.getTime());
  const endToEnd = jobs.filter((j) => j.finishedAt).map((j) => j.finishedAt!.getTime() - j.createdAt.getTime());

  console.log('\nResults');
  console.log(`  people: ${scripts.length} (${LINKED} linked across ${COMPANIES} workspaces, ${NEW} new) · messages: ${unique} · webhooks: ${queue.length}`);
  console.log(`  webhook acknowledgement (ms): p50 ${pct(latencies, 50)} · p95 ${pct(latencies, 95)} · p99 ${pct(latencies, 99)} · max ${pct(latencies, 100)}`);
  console.log(`  webhooks/second while sending: ${(queue.length / sendSecs).toFixed(0)} (${sendSecs.toFixed(1)}s) · HTTP: ${JSON.stringify(statuses)}`);
  console.log(`  queue wait (ms): p50 ${pct(queueWait, 50)} · p95 ${pct(queueWait, 95)} · p99 ${pct(queueWait, 99)}`);
  console.log(`  job run time (ms): p50 ${pct(jobTime, 50)} · p95 ${pct(jobTime, 95)} · p99 ${pct(jobTime, 99)}`);
  console.log(`  message → answered (ms): p50 ${pct(endToEnd, 50)} · p95 ${pct(endToEnd, 95)} · p99 ${pct(endToEnd, 99)}`);
  console.log(`  everything answered and sent after: ${allDoneSecs.toFixed(1)}s (includes send retries after Meta’s simulated rate limits)`);
  console.log(`  Meta stub: ${stubStats.sends} sends, ${stubStats.rateLimited} rate-limited, max ${stubStats.maxInFlight} in flight`);
  console.log('');
  check('every webhook acknowledged with 200', (statuses[200] ?? 0) === queue.length, JSON.stringify(statuses));
  check(`each message stored once (${inbound.length} of ${unique})`, inbound.length === unique, `${inbound.length}`);
  check('every message answered', unanswered === 0, `${unanswered} unanswered`);
  check('no message answered twice (database)', twice === 0, `${twice}`);
  check('no message answered twice (what Meta received)', stubStats.inboundAnsweredMoreThanOnce === 0, `${stubStats.inboundAnsweredMoreThanOnce}`);
  check('each person’s messages answered in order', outOfOrder === 0, `${outOfOrder} conversations out of order`);
  check(`every campaign reply names only that person’s own workspace (${campaignReplies} checked)`, leaked === 0 && campaignReplies > 0, `${leaked} leaked`);
  check('nothing dead-lettered', jobs.every((j) => j.status === 'DONE'), JSON.stringify(jobs.reduce((a: Record<string, number>, j) => ((a[j.status] = (a[j.status] ?? 0) + 1), a), {})));
  check('no reply left unsent', outbound.every((o) => o.status !== 'PENDING' && o.status !== 'FAILED'), JSON.stringify(outbound.reduce((a: Record<string, number>, o) => ((a[o.status] = (a[o.status] ?? 0) + 1), a), {})));

  console.log('\nCleaning up…');
  await db.auditLog.deleteMany({ where: { companyId: { in: companies.map((c) => c.id) } } });
  for (let i = 0; i < convIds.length; i += 500) {
    const chunk = convIds.slice(i, i + 500);
    await db.auditLog.deleteMany({ where: { OR: chunk.map((id) => ({ metadata: { path: ['conversationId'], equals: id } })) } });
    await db.whatsAppConversation.deleteMany({ where: { id: { in: chunk } } });
  }
  await db.company.deleteMany({ where: { id: { in: companies.map((c) => c.id) } } });
  await db.user.deleteMany({ where: { email: { startsWith: `zzload-${STAMP}-` } } });
  console.log('  removed the load-test workspaces, users, conversations and audit entries');
  await db.$disconnect();
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll load checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
