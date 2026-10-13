/**
 * The unified approval model, against the real database and the running app
 * (lib/approval.ts, server/approval/approval.service.ts).
 *
 *   Who        members submit; only owners and admins approve (every route);
 *              nothing is approved twice, even at the same moment
 *   Record     approver, time, version, fingerprint and the approved content;
 *              audited; campaign tasks follow
 *   Integrity  edits, image swaps and network changes reopen approved work;
 *              a change behind the approval is never scheduled, queued or
 *              published
 *   History    rejections and regenerations are kept, with earlier versions
 *   Outreach   the same model
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:approval
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import type { ApprovalRecord } from '@/lib/approval';
import { REVIEW_DIMENSIONS } from '@/lib/content-review';
import type { ReviewItem } from '@/lib/review-item';
import { contentHash } from '@/server/approval/approval.service';
import { markPublished } from '@/server/content/content.service';
import { refineDraft } from '@/server/content/generator';
import { reviewDraft } from '@/server/content/review.service';
import { getQueue } from '@/server/extension/queue.service';

const BASE = (
  process.env.VERIFY_BASE_URL ??
  process.env.AURA_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-approval-${STAMP}!`;
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

class Client {
  private jar = new Map<string, string>();
  private keep(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      this.jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
  }
  private cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        Origin: BASE,
        cookie: this.cookie(),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.keep(res);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* page */
    }
    return { status: res.status, json: json as Record<string, any>, text };
  }
  async page(path: string) {
    const r = await this.req('GET', path);
    return {
      status: r.status,
      text: r.text
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#x27;|&rsquo;/g, '’')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' '),
    };
  }
  async signIn(email: string) {
    const csrf = await this.req('GET', '/api/auth/csrf');
    const token = (csrf.json as { csrfToken: string }).csrfToken;
    const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        cookie: this.cookie(),
      },
      body: new URLSearchParams({
        csrfToken: token,
        email,
        password: PASSWORD,
        json: 'true',
      }),
    });
    this.keep(res);
    const s = await this.req('GET', '/api/auth/session');
    return (s.json as { user?: { email?: string } })?.user?.email;
  }
}

async function person(label: string) {
  return db.user.create({
    data: {
      email: `zzverify-approval-${label}-${STAMP}@example.test`,
      name: `Dana ${label}`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      emailVerified: new Date(),
    },
  });
}

/** The reviewer and writer stubbed at the network (the reviewer passes). */
async function withAi<T>(body: unknown, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const saved = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.GEMINI_API_KEY = 'stub';
  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (!String(url).includes('generativelanguage.googleapis.com'))
      return realFetch(url, init);
    const prompt =
      (
        JSON.parse(String(init?.body ?? '{}')) as {
          contents?: { parts: { text: string }[] }[];
        }
      ).contents?.[0]?.parts[0]?.text ?? '';
    const out = prompt.startsWith('TASK: Review this')
      ? {
          dimensions: REVIEW_DIMENSIONS.map((d) => ({
            dimension: d,
            score: 5,
            reason: 'fine',
          })),
          issues: [],
          summary: 'Ready.',
        }
      : body;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: JSON.stringify(out) }] },
            finishReason: 'STOP',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const POST = {
  caption: 'We roast single-origin coffee in small batches every week.',
  cta: 'Start your subscription on our site.',
  hashtags: ['coffee'],
  altText: '',
};
/** Same content, whatever order Postgres stored the keys in. */
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
        )
      : v;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const recordOf = (m: unknown) => (m as { approval?: ApprovalRecord }).approval!;

async function main() {
  const owner = await person('owner');
  const member = await person('member');
  const company = await db.company.create({
    data: {
      name: 'zzverify approval Roastery',
      slug: `zzverify-approval-${STAMP}`,
      industry: 'Coffee',
      preferences: {
        business: {
          description:
            'We roast single-origin coffee in small batches every week and sell coffee subscriptions online.',
        },
      } as Prisma.InputJsonObject,
    },
  });
  const companyId = company.id;
  await db.companyMember.createMany({
    data: [
      { userId: owner.id, companyId, role: 'OWNER' },
      { userId: member.id, companyId, role: 'MEMBER' },
    ],
  });
  const mk = (title: string) =>
    db.contentDraft.create({
      data: {
        companyId,
        createdById: owner.id,
        type: 'IMAGE_POST',
        platform: 'INSTAGRAM',
        status: 'DRAFT',
        title,
        body: POST,
        aiMetadata: {
          source: { kind: 'BRIEF', brief: 'Roast day' },
        } as Prisma.InputJsonObject,
      },
    });
  const load = async (id: string) =>
    (await db.contentDraft.findUnique({ where: { id } }))!;
  /** A passing review of the body as it stands, so approval tests the workflow, not the live model. */
  const pinReview = async (id: string) =>
    withAi(POST, async () =>
      reviewDraft(await load(id), { trigger: 'manual' }),
    );
  const imgPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const img = (n: string) =>
    db.generatedAsset.create({
      data: {
        companyId,
        provider: 'UPLOAD',
        model: 'upload',
        prompt: n,
        aspectRatio: '1:1',
        width: 1,
        height: 1,
        mimeType: 'image/png',
        fileSize: imgPng.byteLength,
        data: imgPng,
      },
    });

  try {
    const ownerC = new Client();
    await ownerC.signIn(owner.email);
    const memberC = new Client();
    await memberC.signIn(member.email);
    const status = (c: Client, id: string, body: Record<string, unknown>) =>
      c.req('POST', `/api/content/drafts/${id}/status`, body);
    const approve = (id: string) =>
      status(ownerC, id, {
        action: 'approve',
        factsReviewed: true,
        reviewAcknowledged: true,
      });

    const d = await mk('Roast day');
    const campaign = await db.campaign.create({
      data: { companyId, name: 'zzverify roast month' },
    });
    const task = await db.campaignTask.create({
      data: {
        companyId,
        campaignId: campaign.id,
        scheduledDate: new Date(),
        taskType: 'GENERATE_CONTENT',
        status: 'GENERATED',
        relatedContentDraftId: d.id,
      },
    });

    // ------------------------------------------------------------ Who approves
    console.log('\n1. Only the right people approve, and only once');
    await pinReview(d.id);
    const sub = await status(memberC, d.id, { action: 'submit' });
    const memberApprove = await status(memberC, d.id, {
      action: 'approve',
      factsReviewed: true,
      reviewAcknowledged: true,
    });
    const memberBulk = await memberC.req('POST', '/api/content/drafts/bulk', {
      ids: [d.id],
      action: 'approve',
    });
    check(
      'a member can submit, but cannot approve — on the status route or in bulk',
      sub.status === 200 &&
        memberApprove.status === 403 &&
        (memberBulk.json?.failed?.[0]?.error ?? '').includes(
          'Only owners and admins',
        ) &&
        (await load(d.id)).status === 'PENDING_APPROVAL',
      `${sub.status} ${memberApprove.status} ${JSON.stringify(memberBulk.json)}`,
    );
    const ok = await approve(d.id);
    const a = await load(d.id);
    const r = recordOf(a.aiMetadata);
    check(
      'the owner approves: the record holds the approver, the time, the version and exactly what was approved',
      ok.status === 200 &&
        a.status === 'APPROVED' &&
        r.approved?.by === owner.id &&
        r.approved.via === 'person' &&
        Boolean(r.approved.at) &&
        r.approved.version === r.version &&
        r.approved.hash === (await contentHash(a)) &&
        same((r.approved.snapshot as { body: unknown }).body, POST),
      `${ok.status} ${JSON.stringify(r.approved).slice(0, 200)}`,
    );
    const dup = await approve(d.id);
    check(
      'approving again is refused (409 “already approved”)',
      dup.status === 409 && /already approved/i.test(String(dup.json?.error)),
      `${dup.status} ${dup.json?.error}`,
    );
    const audit = await db.auditLog.findFirst({
      where: { companyId, action: 'CONTENT_APPROVED' },
      orderBy: { createdAt: 'desc' },
    });
    check(
      'the approval is audited with its version and fingerprint; the campaign task is now approved',
      (
        audit?.metadata as {
          approval?: { action?: string; hash?: string };
        } | null
      )?.approval?.action === 'approved' &&
        (await db.campaignTask.findUnique({ where: { id: task.id } }))!
          .status === 'APPROVED',
    );

    const race = await mk('Race');
    await pinReview(race.id);
    await status(ownerC, race.id, { action: 'submit' });
    const both = await Promise.all([approve(race.id), approve(race.id)]);
    check(
      'two approvals at the same moment: exactly one succeeds',
      both.filter((x) => x.status === 200).length === 1 &&
        both.filter((x) => x.status === 409).length === 1,
      both.map((x) => `${x.status} ${x.json?.error ?? ''}`).join(' | '),
    );

    // -------------------------------------------- Approved work cannot change
    console.log('\n2. Approved content cannot silently change');
    const edited = {
      ...POST,
      caption: 'We roast single-origin coffee in small batches every Monday.',
    };
    const patch = await ownerC.req('PATCH', `/api/content/drafts/${d.id}`, {
      body: edited,
    });
    const e = await load(d.id);
    const er = recordOf(e.aiMetadata);
    check(
      'editing approved content reopens it: back to draft, version moved on, the edit and the previous text kept, the approved version kept',
      patch.status === 200 &&
        e.status === 'DRAFT' &&
        er.version === r.version + 1 &&
        er.events[0]?.action === 'edited' &&
        same(er.events[0]?.previous, POST) &&
        same(e.body, edited) &&
        er.approved?.by === owner.id &&
        (await db.campaignTask.findUnique({ where: { id: task.id } }))!
          .status === 'GENERATED',
      `${patch.status} ${e.status} v${er.version} ${er.events[0]?.action}`,
    );

    const reapprove = async (id: string) => {
      await pinReview(id);
      await status(ownerC, id, { action: 'submit' });
      return approve(id);
    };
    await reapprove(d.id);
    const pic = await img('a');
    const att = await ownerC.req(
      'POST',
      `/api/content/graphics/${pic.id}/attach`,
      { draftId: d.id, replace: true },
    );
    const m = await load(d.id);
    check(
      'swapping the image on approved content reopens it (recorded as an image change)',
      att.status === 200 &&
        m.status === 'DRAFT' &&
        recordOf(m.aiMetadata).events[0]?.action === 'media_changed',
      `${att.status} ${m.status} ${recordOf(m.aiMetadata).events[0]?.action}`,
    );
    await reapprove(d.id);
    const retarget = await ownerC.req('PATCH', `/api/content/drafts/${d.id}`, {
      platform: 'FACEBOOK',
    });
    const t = await load(d.id);
    check(
      'moving approved content to another network reopens it',
      retarget.status === 200 &&
        t.status === 'DRAFT' &&
        recordOf(t.aiMetadata).events[0]?.action === 'retargeted' &&
        t.platform === 'FACEBOOK',
      `${retarget.status} ${t.status} ${recordOf(t.aiMetadata).events[0]?.action}`,
    );

    // A change that bypassed every path (a direct write) is caught on execution.
    await reapprove(d.id);
    await db.contentDraft.update({
      where: { id: d.id },
      data: { body: { ...edited, caption: 'Tampered after approval.' } },
    });
    const sched = await ownerC.req(
      'POST',
      `/api/content/drafts/${d.id}/schedule`,
      { scheduledFor: new Date(Date.now() + 86_400_000).toISOString() },
    );
    const queue = await getQueue(companyId);
    const item = (await ownerC.req('GET', `/api/review/content/${d.id}`)).json
      ?.item as ReviewItem | undefined;
    let publishBlocked = false;
    try {
      await markPublished({
        companyId,
        userId: owner.id,
        draftId: d.id,
        publishedUrl: null,
      });
    } catch (err) {
      publishBlocked =
        (err as { code?: string }).code === 'changed_after_approval';
    }
    check(
      'a change made behind the approval is caught: not scheduled (409), not queued to the extension, not published, and flagged',
      sched.status === 409 &&
        /changed after it was approved/.test(String(sched.json?.error)) &&
        !queue.some((q) => q.itemId === d.id) &&
        publishBlocked &&
        item?.approvalInfo?.intact === false &&
        Boolean(item?.flags.some((f) => f.label === 'Approval')),
      `${sched.status} queued=${queue.some((q) => q.itemId === d.id)} published-blocked=${publishBlocked} intact=${item?.approvalInfo?.intact}`,
    );

    // ---------------------------------------------- Rejection and history
    console.log(
      '\n3. Rejected content keeps its history; regenerations are recorded',
    );
    const rj = await mk('To reject');
    await pinReview(rj.id);
    await status(ownerC, rj.id, { action: 'submit' });
    const rejected = await status(ownerC, rj.id, {
      action: 'reject',
      reason: 'Show the roaster, not the beans',
    });
    const regen = {
      ...POST,
      caption: 'Meet our roaster: every batch, by hand.',
    };
    await withAi(regen, async () =>
      refineDraft({
        draft: await load(rj.id),
        userId: owner.id,
        action: 'regenerate',
      }),
    );
    const h = recordOf((await load(rj.id)).aiMetadata);
    check(
      'the rejection (who, why, when) survives a regeneration, which keeps the rejected text',
      rejected.status === 200 &&
        h.rejected?.by === owner.id &&
        h.rejected.reason === 'Show the roaster, not the beans' &&
        h.events[0]?.action === 'regenerated' &&
        same(h.events[0]?.previous, POST) &&
        h.events.some(
          (x) =>
            x.action === 'rejected' &&
            x.reason === 'Show the roaster, not the beans',
        ),
      JSON.stringify(h.events.map((x) => x.action)),
    );
    const page = await ownerC.page(
      `/review/content/${rj.id}`.replace('/review', '/dashboard/review'),
    );
    check(
      'the review screen shows the approval record: state, version, who rejected and why, and the history',
      page.status === 200 &&
        page.text.includes('Approval') &&
        page.text.includes('Version') &&
        page.text.includes('Show the roaster, not the beans') &&
        page.text.includes('Regenerated') &&
        page.text.includes('previous version kept'),
    );

    // ---------------------------------------------------------- Outreach
    console.log('\n4. Outreach follows the same model');
    const lead = await db.lead.create({
      data: { companyId, name: 'Priya Shah', companyName: 'Corner Café' },
    });
    const msg = await db.outreachMessage.create({
      data: {
        leadId: lead.id,
        companyId,
        type: 'FOLLOWUP',
        status: 'PENDING_APPROVAL',
        draftText: 'Hi Priya — happy to send a sample of this week’s roast.',
      },
    });
    const oa = await ownerC.req(
      'POST',
      `/api/outreach/messages/${msg.id}/status`,
      { action: 'approve' },
    );
    const ob = await ownerC.req(
      'POST',
      `/api/outreach/messages/${msg.id}/status`,
      { action: 'approve' },
    );
    const om = (await db.outreachMessage.findUnique({
      where: { id: msg.id },
    }))!;
    check(
      'approved once, with the approver recorded; a second approval is refused',
      oa.status === 200 &&
        ob.status === 409 &&
        recordOf(om.aiMetadata).approved?.by === owner.id &&
        recordOf(om.aiMetadata).approved?.snapshot === msg.draftText,
      `${oa.status} ${ob.status}`,
    );
    const oe = await ownerC.req('PATCH', `/api/outreach/messages/${msg.id}`, {
      draftText: 'Hi Priya — happy to send a sample.',
    });
    const om2 = (await db.outreachMessage.findUnique({
      where: { id: msg.id },
    }))!;
    check(
      'editing an approved message reopens it and keeps the approved text',
      oe.status === 200 &&
        om2.status === 'DRAFT' &&
        recordOf(om2.aiMetadata).events[0]?.action === 'edited' &&
        recordOf(om2.aiMetadata).events[0]?.previous === msg.draftText,
    );
    await db.outreachMessage.update({
      where: { id: msg.id },
      data: { status: 'APPROVED' },
    }); // a write that skipped approval
    check(
      'a message not exactly as approved is never handed to the extension',
      !(await getQueue(companyId)).some((q) => q.itemId === msg.id),
    );
  } finally {
    await db.company
      .delete({ where: { id: companyId } })
      .catch(() => undefined);
    for (const u of [owner, member])
      await db.user.delete({ where: { id: u.id } }).catch(() => undefined);
    console.log('  ok      cleanup: throwaway workspace and users removed');
  }

  console.log(
    failures
      ? `\n${failures} approval check(s) failed.`
      : '\nThe unified approval model works end to end.',
  );
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
