import type { WhatsAppJob } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { WhatsAppConfig } from '@/lib/whatsapp';
import { FALLBACK_TEXT, handleInbound } from '@/server/whatsapp/handler';
import { retryDueMessages, sendContent } from '@/server/whatsapp/whatsapp.service';
import { advanceProcessing } from '@/server/content/processing.service';

/**
 * The WhatsApp work queue, in Postgres (no paid queue service).
 *
 * The webhook stores each message with a QUEUED job and returns at once; it
 * then kicks `drainConversation` for that conversation (via waitUntil on
 * Vercel). A sweep (`sweepQueue`, cron) picks up anything a kick missed.
 *
 *   Ordering   a worker leases the CONVERSATION (a timestamp, compare-and-
 *              swap), then handles its jobs oldest first, one at a time — one
 *              person's messages are answered in the order they were sent,
 *              while different people are handled in parallel by separate
 *              invocations. A lease expires on its own if a worker dies.
 *   Retries    a failed job backs off and blocks the jobs behind it (order is
 *              kept); after MAX_JOB_ATTEMPTS it is DEAD — the dead-letter
 *              state, kept with its error — the person gets an apology, and
 *              the conversation moves on.
 *   Recovery   a job left RUNNING by a worker that died is retried by the next
 *              worker to lease the conversation (the attempt counts).
 */

export const LEASE_MS = 90_000;
export const MAX_JOB_ATTEMPTS = 4;
const JOB_BACKOFF_MS = [15_000, 60_000, 5 * 60_000];
/** A RUNNING job older than this belongs to a worker that died. */
export const STALE_RUNNING_MS = 2 * 60_000;
/** Stop starting new jobs when less than this much of the budget is left. */
const MIN_REMAINING_MS = 20_000;

const jobBackoff = (attempts: number) =>
  JOB_BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), JOB_BACKOFF_MS.length - 1)]!;

export type Handler = typeof handleInbound;

export interface DrainResult {
  /** Whether this worker got the conversation (false: another has it). */
  leased: boolean;
  done: number;
  retried: number;
  dead: number;
}

async function lease(conversationId: string, now: Date): Promise<boolean> {
  const r = await db.whatsAppConversation.updateMany({
    where: {
      id: conversationId,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
  });
  return r.count === 1;
}

async function release(conversationId: string): Promise<void> {
  await db.whatsAppConversation.updateMany({
    where: { id: conversationId },
    data: { leaseUntil: null },
  });
}

/** The oldest unfinished job — the head of this conversation's queue. */
function headJob(conversationId: string) {
  return db.whatsAppJob.findFirst({
    where: { conversationId, status: { in: ['QUEUED', 'RUNNING'] } },
    orderBy: { createdAt: 'asc' },
  });
}

/** Run one job (already at the head, conversation leased). */
async function runJob(
  job: WhatsAppJob,
  args: { config: WhatsAppConfig; handler: Handler; fetchImpl?: typeof fetch; now: () => Date },
): Promise<'done' | 'retried' | 'dead' | 'skipped'> {
  const claim = await db.whatsAppJob.updateMany({
    where: { id: job.id, status: job.status, attempts: job.attempts },
    data: { status: 'RUNNING', attempts: job.attempts + 1, startedAt: args.now() },
  });
  if (claim.count !== 1) return 'skipped';
  const attempts = job.attempts + 1;
  try {
    await args.handler({ config: args.config, messageId: job.messageId, fetchImpl: args.fetchImpl });
    await db.whatsAppJob.update({
      where: { id: job.id },
      data: { status: 'DONE', finishedAt: args.now(), lastError: null },
    });
    return 'done';
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    if (attempts >= MAX_JOB_ATTEMPTS) {
      await db.whatsAppJob.update({
        where: { id: job.id },
        data: { status: 'DEAD', finishedAt: args.now(), lastError: error },
      });
      logger.error('whatsapp: job dead-lettered', { jobId: job.id, attempts, error });
      await apologise(job, args);
      return 'dead';
    }
    await db.whatsAppJob.update({
      where: { id: job.id },
      data: {
        status: 'QUEUED',
        runAfter: new Date(args.now().getTime() + jobBackoff(attempts)),
        lastError: error,
      },
    });
    logger.warn('whatsapp: job failed, will retry', { jobId: job.id, attempts, error });
    return 'retried';
  }
}

/** Tell the person, once, that their message could not be handled. Best effort. */
async function apologise(
  job: WhatsAppJob,
  args: { config: WhatsAppConfig; fetchImpl?: typeof fetch },
): Promise<void> {
  try {
    const message = await db.whatsAppMessage.findUnique({
      where: { id: job.messageId },
      include: { conversation: true },
    });
    if (!message) return;
    await sendContent({
      config: args.config,
      conversation: message.conversation,
      content: { kind: 'text', text: FALLBACK_TEXT },
      replyTo: { id: message.id, wamid: message.wamid },
      companyId: message.companyId,
      fetchImpl: args.fetchImpl,
    });
  } catch (err) {
    logger.warn('whatsapp: could not send the fallback reply', {
      jobId: job.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Handle a conversation's queued messages, in order, within a time budget.
 * Returns at once if another worker holds the conversation — it will see
 * the new job, because jobs are re-checked after the lease is released.
 */
export async function drainConversation(args: {
  config: WhatsAppConfig;
  conversationId: string;
  budgetMs?: number;
  handler?: Handler;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<DrainResult> {
  const now = args.now ?? (() => new Date());
  const handler = args.handler ?? handleInbound;
  const started = Date.now();
  const budget = args.budgetMs ?? 45_000;
  const timeLeft = () => budget - (Date.now() - started);
  const result: DrainResult = { leased: false, done: 0, retried: 0, dead: 0 };

  for (;;) {
    if (!(await lease(args.conversationId, now()))) return result;
    result.leased = true;
    try {
      while (timeLeft() > MIN_REMAINING_MS) {
        const job = await headJob(args.conversationId);
        if (!job) break;
        // RUNNING at the head while we hold the lease: its worker died.
        // Backing off: wait, and keep everything behind it waiting too.
        if (job.status === 'QUEUED' && job.runAfter > now()) break;
        // Renew the lease before each job (a job may take a while).
        await db.whatsAppConversation.updateMany({
          where: { id: args.conversationId },
          data: { leaseUntil: new Date(now().getTime() + LEASE_MS) },
        });
        const outcome = await runJob(job, { config: args.config, handler, fetchImpl: args.fetchImpl, now });
        if (outcome === 'done') result.done++;
        else if (outcome === 'dead') result.dead++;
        else if (outcome === 'retried') {
          result.retried++;
          break;
        }
      }
    } finally {
      await release(args.conversationId);
    }
    // A message queued while we were releasing found the lease held and left
    // it to us — look once more before going. Only the HEAD counts: a job
    // behind one that is backing off is not runnable yet (order is kept).
    const head = await headJob(args.conversationId);
    const runnable = head && !(head.status === 'QUEUED' && head.runAfter > now());
    if (!runnable || timeLeft() <= MIN_REMAINING_MS) return result;
  }
}

/**
 * How many conversations one server process works on at once. Above this,
 * drains wait their turn in memory (they are not dropped — and the sweep
 * would pick up anything a crash lost). Measured with 1,000 people at once
 * on one process (scripts/load/whatsapp-load.ts, docs/WHATSAPP-SCALABILITY.md):
 * uncapped, every job slowed to seconds fighting for database connections
 * (all answered and sent after 384 s); capped at 16 / 32 / 48: 142 s / 46 s /
 * 36 s. 48 was the best measured.
 */
const WORKER_CONCURRENCY = Math.max(1, Number(process.env.WHATSAPP_WORKER_CONCURRENCY ?? 48));
let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= WORKER_CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Kick several conversations (one webhook can carry messages from several people). */
export async function drainConversations(args: {
  config: WhatsAppConfig;
  conversationIds: string[];
  budgetMs?: number;
  handler?: Handler;
  fetchImpl?: typeof fetch;
}): Promise<DrainResult[]> {
  return Promise.all(
    args.conversationIds.map((conversationId) =>
      withSlot(() => drainConversation({ ...args, conversationId })).catch((err) => {
        logger.error('whatsapp: drain failed', {
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { leased: false, done: 0, retried: 0, dead: 0 };
      }),
    ),
  );
}

/**
 * The sweep: conversations with due work that no kick handled (a lost kick,
 * a back-off that has expired, a worker that died), then outgoing messages
 * whose retry is due.
 */
export async function sweepQueue(args: {
  config: WhatsAppConfig;
  budgetMs?: number;
  limit?: number;
  handler?: Handler;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<{
  conversations: number;
  done: number;
  retried: number;
  dead: number;
  sends: Awaited<ReturnType<typeof retryDueMessages>>;
  retention: Awaited<ReturnType<typeof applyRetention>>;
  /** Instagram posts still processing, checked (finished → the person is told on WhatsApp). */
  processing: Awaited<ReturnType<typeof advanceProcessing>> | null;
}> {
  const now = args.now ?? (() => new Date());
  const started = Date.now();
  const budget = args.budgetMs ?? 50_000;
  const due = await db.whatsAppJob.findMany({
    where: {
      OR: [
        { status: 'QUEUED', runAfter: { lte: now() } },
        { status: 'RUNNING', startedAt: { lt: new Date(now().getTime() - STALE_RUNNING_MS) } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: (args.limit ?? 25) * 4,
    select: { conversationId: true },
  });
  const ids = [...new Set(due.map((j) => j.conversationId))].slice(0, args.limit ?? 25);
  const totals = { conversations: 0, done: 0, retried: 0, dead: 0 };
  for (const conversationId of ids) {
    const left = budget - (Date.now() - started);
    if (left <= MIN_REMAINING_MS) break;
    const r = await drainConversation({ ...args, conversationId, budgetMs: left, now });
    if (r.leased) totals.conversations++;
    totals.done += r.done;
    totals.retried += r.retried;
    totals.dead += r.dead;
  }
  const sends = await retryDueMessages({ config: args.config, fetchImpl: args.fetchImpl, now: now() });
  const retention = await applyRetention(now());
  // Best effort: a publishing problem must not fail the WhatsApp sweep.
  const processing = await advanceProcessing({ now: now() }).catch((err) => {
    logger.warn('whatsapp sweep: could not check processing posts', { error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  return { ...totals, sends, retention, processing };
}

/** Days WhatsApp message text is kept (WHATSAPP_RETENTION_DAYS, default 90). */
export const retentionDays = () => Math.max(1, Number(process.env.WHATSAPP_RETENTION_DAYS ?? 90));

/**
 * Personal data is not kept for ever: message text older than the retention
 * period is deleted (with its jobs); a conversation nobody has linked and
 * nobody has written in for that long goes entirely, number included; spent
 * sign-in challenges too. Linked conversations stay (their session lives on
 * the link) — only their old messages go.
 */
export async function applyRetention(now: Date = new Date()): Promise<{ messages: number; conversations: number; challenges: number }> {
  const cutoff = new Date(now.getTime() - retentionDays() * 86_400_000);
  const messages = await db.whatsAppMessage.deleteMany({ where: { createdAt: { lt: cutoff } } });
  const conversations = await db.whatsAppConversation.deleteMany({
    where: { lastMessageAt: { lt: cutoff }, link: { is: null } },
  });
  const challenges = await db.whatsAppLinkChallenge.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return { messages: messages.count, conversations: conversations.count, challenges: challenges.count };
}
