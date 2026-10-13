/**
 * The unified review experience, against the real database and the running
 * app (lib/review-item.ts). The AI is stubbed where a step writes.
 *
 *   One shape   content, image, recommendation, goal, audience, channel,
 *               evidence, quality flags, reviewer feedback and actions
 *   Edit        field-by-field, saved; older edits never overwrite newer work
 *   Decide      submit, approve (with confirmation), reject with a reason,
 *               schedule — by the right roles
 *   Regenerate  replaces the text, keeps the previous version
 *   Outreach    the same screen and actions; LinkedIn limits enforced
 *   Queue       everything waiting, across modules, in one list
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:unified-review
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { REVIEW_DIMENSIONS } from '@/lib/content-review';
import { REVIEW_ACTIONS, type ReviewItem } from '@/lib/review-item';
import { runReviewAction } from '@/server/review/review-actions.service';

const BASE = (
  process.env.VERIFY_BASE_URL ??
  process.env.AURA_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-unified-${STAMP}!`;
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
      email: `zzverify-unified-${label}-${STAMP}@example.test`,
      name: `Dana ${label}`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      emailVerified: new Date(),
    },
  });
}

/** Run with the AI provider stubbed: the writer returns `body`, the reviewer passes. */
async function withStub<T>(body: unknown, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const saved = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.GEMINI_API_KEY = 'stub-key-for-this-check';
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

/** With no AI configured, outreach drafting uses its deterministic template. */
async function withoutAi<T>(run: () => Promise<T>): Promise<T> {
  const saved = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_GEMINI_API_KEY: process.env.GOOGLE_GEMINI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  for (const k of Object.keys(saved)) delete process.env[k];
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v !== undefined) process.env[k] = v;
  }
}

const POST = {
  caption: 'Single-origin coffee, roasted in small batches every week.',
  cta: 'Start your subscription on our site.',
  hashtags: ['coffee', 'specialtycoffee', 'homebrewing'],
  altText: '',
};

async function main() {
  const owner = await person('owner');
  const member = await person('member');
  const viewer = await person('viewer');
  const outsider = await person('outsider');
  const company = await db.company.create({
    data: {
      name: 'zzverify unified Roastery',
      slug: `zzverify-unified-${STAMP}`,
      industry: 'Coffee',
      website: 'https://www.roastery.example',
      preferences: {
        business: {
          description:
            'We roast single-origin coffee in small batches every week and sell coffee subscriptions online.',
        },
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'Home brewers',
          goals: 'Grow coffee subscriptions',
        },
      } as Prisma.InputJsonObject,
    },
  });
  const other = await db.company.create({
    data: {
      name: 'zzverify unified Other',
      slug: `zzverify-unified-o-${STAMP}`,
    },
  });
  const companyId = company.id;
  await db.companyMember.createMany({
    data: [
      { userId: owner.id, companyId, role: 'OWNER' },
      { userId: member.id, companyId, role: 'MEMBER' },
      { userId: viewer.id, companyId, role: 'VIEWER' },
      { userId: outsider.id, companyId: other.id, role: 'OWNER' },
    ],
  });
  const brief = {
    recommendation: {
      id: 'rec-1',
      title: 'Show how the roast happens',
      type: 'post',
      status: 'ACCEPTED',
      accepted: true,
    },
    marketingGoal: {
      value: 'Grow coffee subscriptions',
      source: 'business_profile',
    },
    targetAudience: {
      value: 'Home brewers who buy beans online',
      source: 'business_profile',
    },
    channel: {
      name: 'Instagram',
      platform: 'INSTAGRAM',
      publishing: 'manual',
      source: 'person',
      requirements: [],
    },
    keyMessage: {
      value: 'Small batches, roasted every week',
      source: 'recommendation',
    },
    reason: {
      why: 'Followers ask how fresh the beans are',
      confidence: 'HIGH',
      confidenceReason: null,
    },
    evidence: [
      {
        label: 'Comments asking about roast dates',
        detail: '12 comments in two weeks',
        url: 'https://www.instagram.com/p/x',
        observedAt: new Date().toISOString(),
      },
    ],
    cta: { expected: true, guidance: null, destination: null },
    assetRequirements: { visual: { need: 'required' } },
  };
  const mkDraft = (title: string) =>
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
          source: { kind: 'BRIEF', brief: null },
          recommendation: {
            id: 'rec-1',
            title: 'Show how the roast happens',
            why: 'Followers ask how fresh the beans are',
            goal: 'Grow coffee subscriptions',
            audience: 'Home brewers',
            channel: 'Instagram',
            evidence: [],
            expectedOutcome: 'More subscription sign-ups',
          },
          brief,
          history: [],
        } as Prisma.InputJsonObject,
      },
    });
  const load = async (id: string) =>
    (await db.contentDraft.findUnique({ where: { id } }))!;

  try {
    const ownerC = new Client();
    await ownerC.signIn(owner.email);
    const memberC = new Client();
    await memberC.signIn(member.email);
    const viewerC = new Client();
    await viewerC.signIn(viewer.email);
    const outC = new Client();
    await outC.signIn(outsider.email);

    // ------------------------------------------------------------ One shape
    console.log('\n1. The complete asset, in one review screen');
    const d1 = await mkDraft('Roast day');
    const g = await ownerC.req('GET', `/api/review/content/${d1.id}`);
    const item = g.json?.item as ReviewItem | undefined;
    check(
      'content, image, recommendation, goal, audience, channel, evidence, flags and actions in one item',
      g.status === 200 &&
        item!.fields.map((f) => f.label).join('|') ===
          'Caption|Call to action|Hashtags|Image description (alt text)' &&
        item!.asset?.need === 'required' &&
        item!.context.recommendation?.title === 'Show how the roast happens' &&
        item!.context.goal === 'Grow coffee subscriptions' &&
        item!.context.audience === 'Home brewers who buy beans online' &&
        item!.context.channel === 'Instagram' &&
        item!.context.keyMessage === 'Small batches, roasted every week' &&
        item!.context.evidence[0]?.label ===
          'Comments asking about roast dates' &&
        item!.flags.some(
          (f) => f.label === 'Image' && /needs an image/.test(f.message),
        ) &&
        REVIEW_ACTIONS.every((k) => k in item!.actions),
      JSON.stringify(item ?? g.json).slice(0, 400),
    );
    const page = await ownerC.page(`/dashboard/review/content/${d1.id}`);
    check(
      'the screen shows it all, with Back, Edit, Regenerate, Reject and Approve',
      page.status === 200 &&
        [
          'Review queue',
          'Content',
          'Image',
          'Quality warnings',
          'Reviewer feedback',
          'What it’s for',
          'Grow coffee subscriptions',
          'Home brewers who buy beans online',
          'Comments asking about roast dates',
          'Small batches, roasted every week',
          'Back',
          'Edit',
          'Regenerate',
          'Reject',
          'Approve',
        ].every((t) => page.text.includes(t)),
      [
        'Review queue',
        'Quality warnings',
        'Reviewer feedback',
        'What it’s for',
        'Back',
        'Edit',
        'Regenerate',
        'Reject',
        'Approve',
      ]
        .filter((t) => !page.text.includes(t))
        .join(','),
    );

    // ------------------------------------------------------------- Editing
    console.log('\n2. Editing, with edits preserved');
    const before = await load(d1.id);
    const saved = await ownerC.req('POST', `/api/review/content/${d1.id}`, {
      action: 'save',
      edits: {
        caption:
          'Single-origin coffee, roasted in small batches every week. Taste the difference.',
        hashtags: '#coffee #roastday',
      },
      baseUpdatedAt: before.updatedAt.toISOString(),
    });
    const after = await load(d1.id);
    const ab = after.body as typeof POST;
    check(
      'a field-by-field edit is saved; untouched fields stay as they were',
      saved.status === 200 &&
        ab.caption.endsWith('Taste the difference.') &&
        ab.hashtags.join(',') === 'coffee,roastday' &&
        ab.cta === POST.cta,
      `${saved.status} ${JSON.stringify(saved.json)}`,
    );
    const stale = await ownerC.req('POST', `/api/review/content/${d1.id}`, {
      action: 'save',
      edits: { cta: 'Overwrite' },
      baseUpdatedAt: before.updatedAt.toISOString(),
    });
    check(
      'edits made on an older version never overwrite a newer one (409) — nothing is lost',
      stale.status === 409 &&
        /changed since you opened it/.test(String(stale.json?.error)) &&
        (await load(d1.id)).updatedAt.getTime() === after.updatedAt.getTime(),
      `${stale.status} ${stale.json?.error}`,
    );

    // ------------------------------------------------------------- Roles
    console.log('\n3. Approving and rejecting — by the right people');
    const memberApprove = await memberC.req(
      'POST',
      `/api/review/content/${d1.id}`,
      { action: 'approve' },
    );
    const viewerSave = await viewerC.req(
      'POST',
      `/api/review/content/${d1.id}`,
      { action: 'save', edits: { cta: 'x' } },
    );
    const outsiderGet = await outC.req('GET', `/api/review/content/${d1.id}`);
    const memberItem = (
      await memberC.req('GET', `/api/review/content/${d1.id}`)
    ).json?.item as ReviewItem;
    check(
      'a member cannot approve (403) but can submit; a viewer cannot edit (403); another workspace sees nothing (404)',
      memberApprove.status === 403 &&
        viewerSave.status === 403 &&
        outsiderGet.status === 404 &&
        memberItem.actions.approve.available === false &&
        memberItem.actions.submit.available === true,
      `${memberApprove.status} ${viewerSave.status} ${outsiderGet.status}`,
    );
    const submitted = await memberC.req(
      'POST',
      `/api/review/content/${d1.id}`,
      { action: 'submit' },
    );
    check(
      'the member submits it for approval',
      submitted.status === 200 &&
        (await load(d1.id)).status === 'PENDING_APPROVAL',
      `${submitted.status} ${submitted.json?.error}`,
    );
    const firstTry = await ownerC.req('POST', `/api/review/content/${d1.id}`, {
      action: 'approve',
    });
    const approved =
      firstTry.status === 200
        ? firstTry
        : await ownerC.req('POST', `/api/review/content/${d1.id}`, {
            action: 'approve',
            confirmed: true,
          });
    check(
      'the owner approves (confirming what was flagged when asked)',
      approved.status === 200 &&
        (await load(d1.id)).status === 'APPROVED' &&
        (firstTry.status === 200 ||
          /review|confirm|verified/i.test(String(firstTry.json?.error))),
      `${firstTry.status} ${firstTry.json?.error} → ${approved.status} ${approved.json?.error}`,
    );
    const when = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const sched = await ownerC.req('POST', `/api/review/content/${d1.id}`, {
      action: 'schedule',
      scheduledFor: when,
    });
    const past = await ownerC.req('POST', `/api/review/content/${d1.id}`, {
      action: 'schedule',
      scheduledFor: new Date(Date.now() - 3600_000).toISOString(),
    });
    check(
      'an approved post is scheduled; a time in the past is refused',
      sched.status === 200 &&
        (await load(d1.id)).scheduledFor?.toISOString() === when &&
        past.status === 422,
      `${sched.status} ${past.status}`,
    );

    const d2 = await mkDraft('Roast day v2');
    const rej = await ownerC.req('POST', `/api/review/content/${d2.id}`, {
      action: 'reject',
      reason: 'Show the roaster, not the beans',
    });
    const rejItem = (await ownerC.req('GET', `/api/review/content/${d2.id}`))
      .json?.item as ReviewItem;
    check(
      'rejecting records the reason, and the screen shows it',
      rej.status === 200 &&
        (await load(d2.id)).status === 'REJECTED' &&
        rejItem.flags.some(
          (f) =>
            f.label === 'Rejected' &&
            f.message === 'Show the roaster, not the beans',
        ) &&
        rejItem.actions.approve.available === false,
    );

    // --------------------------------------------------------- Regenerate
    console.log('\n4. Regenerating');
    const fresh = {
      ...POST,
      caption:
        'Every Monday we roast a small batch — this week, a washed Ethiopian.',
    };
    const regen = await withStub(fresh, () =>
      runReviewAction({
        kind: 'content',
        id: d2.id,
        companyId,
        userId: owner.id,
        role: 'OWNER',
        input: {
          action: 'regenerate',
          mode: 'instructions',
          instructions: 'Lead with the roast day',
        },
      }),
    );
    const d2a = await load(d2.id);
    const meta = d2a.aiMetadata as {
      history?: { before: string; body: typeof POST }[];
    };
    check(
      'a regeneration replaces the text, keeps the previous version for undo, and goes back to draft',
      regen.status === 'DRAFT' &&
        (d2a.body as typeof POST).caption === fresh.caption &&
        meta.history?.[0]?.before === 'custom' &&
        meta.history[0].body.caption === POST.caption,
      JSON.stringify({ regen, before: meta.history?.[0]?.before }),
    );

    // ------------------------------------------------------------ Outreach
    console.log('\n5. Outreach reviewed the same way');
    const lead = await db.lead.create({
      data: {
        companyId,
        name: 'Priya Shah',
        title: 'Owner',
        companyName: 'Corner Café',
        category: 'Cafés',
        fitScore: 82,
        fitRationale: 'Independent café that buys beans weekly',
      },
    });
    await db.leadSignal.create({
      data: {
        leadId: lead.id,
        signalType: 'NEWS',
        description: 'Corner Café opened a second location',
        sourceUrl: 'https://news.example/corner',
      },
    });
    const note = await db.outreachMessage.create({
      data: {
        leadId: lead.id,
        companyId,
        type: 'CONNECTION_NOTE',
        status: 'DRAFT',
        draftText: `Hi Priya — congrats on the second Corner Café. ${'We roast small batches weekly. '.repeat(12)}`,
      },
    });
    const og = await ownerC.req('GET', `/api/review/outreach/${note.id}`);
    const oi = og.json?.item as ReviewItem;
    check(
      'the same item shape: message, lead as audience, the signal as evidence, LinkedIn as channel, no scheduling',
      og.status === 200 &&
        oi.fields[0]?.key === 'draftText' &&
        oi.fields[0]?.maxLength === 300 &&
        oi.context.audience === 'Priya Shah, Owner at Corner Café' &&
        oi.context.evidence[0]?.label ===
          'Corner Café opened a second location' &&
        oi.context.channel === 'LinkedIn connection request' &&
        oi.actions.schedule.available === false &&
        oi.flags.some(
          (f) => f.severity === 'block' && /300 characters/.test(f.message),
        ),
      JSON.stringify(oi ?? og.json).slice(0, 300),
    );
    const tooLong = await ownerC.req(
      'POST',
      `/api/review/outreach/${note.id}`,
      { action: 'approve' },
    );
    const oldRoute = await ownerC.req(
      'POST',
      `/api/outreach/messages/${note.id}/status`,
      { action: 'approve' },
    );
    check(
      'a note over LinkedIn’s 300 characters cannot be approved — here or on the Outreach board',
      tooLong.status === 409 &&
        oldRoute.status === 409 &&
        (await db.outreachMessage.findUnique({ where: { id: note.id } }))!
          .status === 'DRAFT',
      `${tooLong.status} ${oldRoute.status}`,
    );
    const n1 = (await db.outreachMessage.findUnique({
      where: { id: note.id },
    }))!;
    const fixed = await ownerC.req('POST', `/api/review/outreach/${note.id}`, {
      action: 'save',
      edits: {
        draftText:
          'Hi Priya — congrats on the second Corner Café. We roast small batches weekly; happy to send a sample.',
      },
      baseUpdatedAt: n1.updatedAt.toISOString(),
    });
    const okApprove = await ownerC.req(
      'POST',
      `/api/review/outreach/${note.id}`,
      { action: 'approve' },
    );
    check(
      'edited to fit, it is approved',
      fixed.status === 200 &&
        okApprove.status === 200 &&
        (await db.outreachMessage.findUnique({ where: { id: note.id } }))!
          .status === 'APPROVED',
      `${fixed.status} ${okApprove.status} ${okApprove.json?.error}`,
    );
    const follow = await db.outreachMessage.create({
      data: {
        leadId: lead.id,
        companyId,
        type: 'FOLLOWUP',
        status: 'PENDING_APPROVAL',
        draftText: 'Thanks for connecting, Priya.',
      },
    });
    const re = await withoutAi(() =>
      runReviewAction({
        kind: 'outreach',
        id: follow.id,
        companyId,
        userId: owner.id,
        role: 'OWNER',
        input: { action: 'regenerate', mode: 'fresh' },
      }),
    );
    const f2 = (await db.outreachMessage.findUnique({
      where: { id: follow.id },
    }))!;
    const fh = (f2.aiMetadata as { history?: { text: string }[] }).history;
    check(
      'regenerating an outreach message replaces it in place, keeps the old text, and needs approving again',
      re.status === 'DRAFT' &&
        f2.draftText !== 'Thanks for connecting, Priya.' &&
        fh?.[0]?.text === 'Thanks for connecting, Priya.' &&
        (await db.outreachMessage.count({ where: { leadId: lead.id } })) === 2,
      JSON.stringify({ re, text: f2.draftText.slice(0, 60) }),
    );
    const sch = await ownerC.req('POST', `/api/review/outreach/${follow.id}`, {
      action: 'schedule',
      scheduledFor: when,
    });
    check(
      'outreach cannot be scheduled (409) — it is sent from the extension',
      sch.status === 409,
    );

    // --------------------------------------------------------------- Queue
    console.log('\n6. One queue for everything waiting on a person');
    const q = await ownerC.page('/dashboard/review');
    const qo = await ownerC.page('/dashboard/review?show=outreach');
    const draftPage = await ownerC.page(`/dashboard/content/${d2.id}`);
    const nav = await ownerC.page('/dashboard');
    check(
      'the queue lists content and outreach together, filters by module, and is linked from the draft page and the sidebar',
      q.status === 200 &&
        q.text.includes('Roast day v2') &&
        q.text.includes('Follow-up message to Priya Shah') &&
        !q.text.includes(
          'Connection note to Priya Shah',
        ) /* approved: no longer waiting */ &&
        qo.text.includes('Follow-up message to Priya Shah') &&
        !qo.text.includes('Roast day v2') &&
        draftPage.text.includes('Review & approve') &&
        nav.text.includes('Review & approve'),
    );
  } finally {
    await db.company
      .delete({ where: { id: companyId } })
      .catch(() => undefined);
    await db.company.delete({ where: { id: other.id } }).catch(() => undefined);
    for (const u of [owner, member, viewer, outsider])
      await db.user.delete({ where: { id: u.id } }).catch(() => undefined);
    console.log('  ok      cleanup: throwaway workspaces and users removed');
  }

  console.log(
    failures
      ? `\n${failures} review check(s) failed.`
      : '\nThe unified review works end to end.',
  );
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
