/**
 * The AI Reviewer, against the real database and the running app
 * (lib/content-review.ts). The model is stubbed at the network, so the
 * writer's and the reviewer's answers are controlled.
 *
 *   Review      generated content is reviewed on its own instructions, with a
 *               structured result (status, score, ten dimensions, issues)
 *   Untouched   the reviewer never changes the piece
 *   States      fail blocks submitting and names the failed checks; review
 *               required is marked and needs the approver to confirm
 *   Regenerate  with the review's feedback, then reviewed again
 *   Rules       a rule breach fails whatever the model says; with the model
 *               down nothing passes silently
 *   Stale       an edited piece is reviewed again before it moves on
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:review
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { briefText } from '@/lib/content-brief';
import {
  isReviewCurrent,
  REVIEW_DIMENSIONS,
  REVIEWER_SYSTEM,
  type ContentReview,
} from '@/lib/content-review';
import { getContentBrief } from '@/server/content/content-brief.service';
import { generateDraft, refineDraft } from '@/server/content/generator';
import { reviewDraft } from '@/server/content/review.service';
import { runDetection } from '@/server/opportunities/detection.service';
import { suggestFromOpportunities } from '@/server/recommendations/autosuggest.service';
import { getCreation } from '@/server/recommendations/creation.service';
import { decideRecommendation } from '@/server/recommendations/recommendation.service';
import { collectSignals } from '@/server/signals/signal.service';

const BASE = (
  process.env.VERIFY_BASE_URL ??
  process.env.AURA_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-review-${STAMP}!`;
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
      email: `zzverify-review-${label}-${STAMP}@example.test`,
      name: `Dana ${label}`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      emailVerified: new Date(),
    },
  });
}

const PROFILE = {
  business: {
    description:
      'We roast single-origin coffee in small batches and sell subscriptions online.',
  },
  marketingProfile: {
    marketMode: 'B2C',
    audience: 'Home brewers who buy beans online',
    channels: ['LinkedIn', 'Instagram'],
    goals: 'Grow coffee subscriptions',
  },
};

async function seed(companyId: string) {
  const item = (id: string, title: string, url: string) => ({
    id,
    title,
    url,
    source: 'news',
    sourceLabel: 'News',
    score: 10,
    publishedAt: ago(2).toISOString(),
    aiSummary: title,
    suggestedAngle: '',
  });
  await db.companyTrendConfig.create({
    data: { companyId, keywords: ['specialty coffee'] },
  });
  await db.trendDigest.create({
    data: {
      companyId,
      date: ago(1),
      payload: {
        items: [
          item(
            'n1',
            'Specialty coffee prices climb as harvests shrink',
            'https://a.example/1',
          ),
          item(
            'n2',
            'Why specialty coffee shops win on transparency',
            'https://a.example/2',
          ),
        ],
        summary: '',
        recommendations: [],
        hashtags: [],
        seasonal: [],
        competitorMentions: [],
      } as Prisma.InputJsonObject,
    },
  });
  const acme = await db.competitorProfile.create({
    data: { companyId, name: 'Acme Coffee' },
  });
  await db.competitorSnapshot.create({
    data: {
      competitorId: acme.id,
      capturedAt: ago(3),
      changesSummary: {
        hasChanges: true,
        pricing: 'Cut subscriptions by 20%',
        news: [],
        skipped: [],
        model: 'x',
        capturedAt: ago(3).toISOString(),
      } as Prisma.InputJsonObject,
    },
  });
  for (const [s, e, v] of [
    [14, 7, 500],
    [7, 0, 300],
  ] as const) {
    await db.analyticsReport.create({
      data: {
        companyId,
        periodStart: ago(s),
        periodEnd: ago(e),
        summary: 'p',
        metrics: { totalEngagement: v },
      },
    });
  }
  await collectSignals(companyId);
  await runDetection(companyId);
  await suggestFromOpportunities(companyId, { templatesOnly: true });
  return db.recommendation.findMany({
    where: { companyId },
    orderBy: { priorityScore: 'desc' },
  });
}

const actionOf = (r: { details: unknown }) =>
  (r.details as { action?: string } | null)?.action ?? '';

const POST = {
  hook: 'We roast single-origin coffee in small batches.',
  paragraphs: [
    'Coffee subscriptions bring that small-batch roast to your kitchen.',
    'Pick a roast, choose how often, and brew it your way.',
    'Which roast would you start with?',
  ],
  cta: 'Start your coffee subscription on our site.',
  hashtags: ['coffee', 'specialtycoffee', 'homebrewing'],
};

const scores = (s: number, over: Record<string, number> = {}) =>
  REVIEW_DIMENSIONS.map((d) => ({
    dimension: d,
    score: over[d] ?? s,
    reason: `${d}: looks ${over[d] ?? s}/5`,
  }));
const PASS = {
  dimensions: scores(5),
  issues: [],
  summary: 'On brief, on brand and ready for approval.',
};

interface Sent {
  prompt: string;
  system: string;
}

/** Stub the model at the network: the writer and the reviewer, told apart by their task. */
function stubModel(answer: (s: Sent) => unknown) {
  const sent: Sent[] = [];
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
    const req = JSON.parse(String(init?.body ?? '{}')) as {
      contents?: { parts: { text: string }[] }[];
      systemInstruction?: { parts: { text: string }[] };
    };
    const s: Sent = {
      prompt: req.contents?.[0]?.parts[0]?.text ?? '',
      system: req.systemInstruction?.parts[0]?.text ?? '',
    };
    sent.push(s);
    const out = answer(s);
    if (out instanceof Response) return out;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: typeof out === 'string' ? out : JSON.stringify(out) },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return {
    sent,
    restore() {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

async function withStub<T>(
  answer: (s: Sent) => unknown,
  run: () => Promise<T>,
) {
  const s = stubModel(answer);
  try {
    return { result: await run(), sent: s.sent };
  } finally {
    s.restore();
  }
}

const isReview = (s: Sent) => s.prompt.startsWith('TASK: Review this');
const reviewOf = (d: { aiMetadata: unknown }) =>
  (d.aiMetadata as { review?: ContentReview }).review;

async function main() {
  const owner = await person('owner');
  const viewer = await person('viewer');
  const outsider = await person('outsider');
  const company = await db.company.create({
    data: {
      name: 'zzverify review Roastery',
      slug: `zzverify-review-${STAMP}`,
      industry: 'Coffee',
      website: 'https://www.roastery.example',
      preferences: PROFILE as Prisma.InputJsonObject,
    },
  });
  const other = await db.company.create({
    data: {
      name: 'zzverify review Other',
      slug: `zzverify-review-other-${STAMP}`,
      industry: 'Coffee',
    },
  });
  const companyId = company.id;
  await db.companyMember.createMany({
    data: [
      { userId: owner.id, companyId, role: 'OWNER' },
      { userId: viewer.id, companyId, role: 'VIEWER' },
      { userId: outsider.id, companyId: other.id, role: 'OWNER' },
    ],
  });

  try {
    const recs = await seed(companyId);
    const rec = recs.find((r) =>
      ['post', 'response-post', 'recovery-post'].includes(actionOf(r)),
    );
    if (!rec) throw new Error('No content suggestion to write from.');
    await db.recommendation.update({
      where: { id: rec.id },
      data: { status: 'PRESENTED', blockers: [], executable: true },
    });
    await decideRecommendation({
      companyId,
      recommendationId: rec.id,
      decision: 'ACCEPTED',
      actorId: owner.id,
    });
    const creation = await getCreation(companyId, rec.id, 'content-studio');
    const brief = await getContentBrief(companyId, rec.id, {
      type: 'LINKEDIN_POST',
      platform: 'LINKEDIN',
    });

    // ------------------------------------------------------------ Generation
    console.log(
      '\n1. Generated content is reviewed, independently, before approval',
    );
    const gen = await withStub(
      (s) =>
        isReview(s) ? PASS : s.prompt.includes('"hook": string') ? POST : '{}',
      () =>
        generateDraft({
          companyId,
          userId: owner.id,
          type: 'LINKEDIN_POST',
          platform: 'LINKEDIN',
          source: { kind: 'BRIEF', brief: briefText(brief!) },
          variations: 1,
          recommendation: {
            id: rec.id,
            title: rec.title,
            provenance: creation?.provenance ?? null,
            brief,
          },
        }),
    );
    const draftId = gen.result.id;
    const load = async () =>
      (await db.contentDraft.findUnique({ where: { id: draftId } }))!;
    let d = await load();
    let r = reviewOf(d);
    check(
      'a new draft carries a structured review: status, score, all ten dimensions',
      r?.status === 'pass' &&
        r.trigger === 'generated' &&
        r.dimensions.length === 10 &&
        typeof r.score === 'number',
      JSON.stringify(r ?? null).slice(0, 400),
    );
    const reviewCall = gen.sent.find(isReview);
    // The writer (not the brand-voice analysis that may run first).
    const writerCall = gen.sent.find((s) =>
      s.system.includes('senior copywriter'),
    );
    check(
      'the reviewer runs on its own instructions — not the writer’s — and sees what the piece was for',
      Boolean(reviewCall) &&
        reviewCall!.system === REVIEWER_SYSTEM &&
        !reviewCall!.system.includes('senior copywriter') &&
        Boolean(writerCall?.system.includes('senior copywriter')) &&
        !reviewCall!.prompt.includes('HOW TO WRITE') &&
        reviewCall!.prompt.includes(
          `Key message: ${brief!.keyMessage?.value ?? ''}`,
        ) &&
        reviewCall!.prompt.includes(POST.hook),
    );
    check(
      'the review is of the body as written (stored with its fingerprint)',
      JSON.stringify(d.body) === JSON.stringify(gen.result.body) &&
        isReviewCurrent(r, d.body),
    );

    // -------------------------------------------------- Never modifies content
    console.log('\n2. The reviewer never modifies the piece');
    const before = await load();
    await withStub(
      () => ({
        ...PASS,
        body: { hook: 'REWRITTEN BY THE REVIEWER' },
        revised: 'A different post.',
      }),
      async () => reviewDraft(await load(), { trigger: 'manual' }),
    );
    d = await load();
    check(
      'a reviewer answer carrying copy changes nothing: body, title and status as they were',
      JSON.stringify(d.body) === JSON.stringify(before.body) &&
        d.title === before.title &&
        d.status === before.status &&
        !JSON.stringify(d.aiMetadata).includes('REWRITTEN BY THE REVIEWER'),
    );

    // --------------------------------------------------------------- Failing
    console.log(
      '\n3. A failed review blocks the approval workflow; failed checks are named',
    );
    await withStub(
      () => ({
        dimensions: scores(5, { audience_fit: 2 }),
        issues: [
          {
            dimension: 'audience_fit',
            severity: 'major',
            problem: 'Talks to cafés, but the audience is home brewers.',
            quote: 'brew it your way',
            fix: 'Speak to someone brewing at home.',
          },
        ],
        summary: 'Off-audience.',
      }),
      async () => reviewDraft(await load(), { trigger: 'manual' }),
    );
    d = await load();
    r = reviewOf(d)!;
    check(
      'status fail, the failing dimension named, the issue quoted from the piece',
      r.status === 'fail' &&
        r.failed.join() === 'audience_fit' &&
        r.issues[0]?.quote === 'brew it your way' &&
        r.issues[0]?.suggestion === 'Speak to someone brewing at home.',
      JSON.stringify({
        status: r.status,
        failed: r.failed,
        issue: r.issues[0],
      }),
    );
    const ownerC = new Client();
    await ownerC.signIn(owner.email);
    const submitFail = await ownerC.req(
      'POST',
      `/api/content/drafts/${draftId}/status`,
      { action: 'submit' },
    );
    check(
      'submitting is refused (409) with the failed check, and the draft stays a draft',
      submitFail.status === 409 &&
        /review failed on Audience fit/.test(String(submitFail.json?.error)) &&
        (await load()).status === 'DRAFT',
      `${submitFail.status} ${JSON.stringify(submitFail.json)}`,
    );
    const page = await ownerC.page(`/dashboard/content/${draftId}`);
    check(
      'the draft page shows the review: failed, each dimension, and the issue',
      page.status === 200 &&
        page.text.includes('Review failed') &&
        page.text.includes('Audience fit') &&
        page.text.includes('Recommendation alignment') &&
        page.text.includes('Talks to cafés') &&
        page.text.includes('Regenerate with review feedback'),
    );
    const queue = await ownerC.page('/dashboard/content');
    check('the queue marks it', queue.text.includes('Review failed'));

    // ----------------------------------------------------------- Regeneration
    console.log('\n4. Regeneration when the quality bar is not met');
    const better = {
      ...POST,
      paragraphs: [
        'Brewing at home? Coffee subscriptions bring that small-batch roast to your kitchen.',
        POST.paragraphs[1]!,
        POST.paragraphs[2]!,
      ],
    };
    const regen = await withStub(
      (s) => (isReview(s) ? PASS : better),
      async () =>
        refineDraft({
          draft: await load(),
          userId: owner.id,
          action: 'fix_review',
        }),
    );
    d = await load();
    r = reviewOf(d)!;
    const writerPrompt =
      regen.sent.find((s) => s.prompt.startsWith('TASK: Revise'))?.prompt ?? '';
    check(
      'the writer is given the review’s issues — from the stored review, not the request',
      writerPrompt.includes('An independent review found these problems') &&
        writerPrompt.includes(
          '[Audience fit] Talks to cafés, but the audience is home brewers.',
        ),
    );
    const meta = d.aiMetadata as {
      reviewHistory?: { status: string }[];
      history?: { before: string }[];
    };
    check(
      'the new version is reviewed again (pass), the failed review kept in history, the rewrite undoable',
      r.status === 'pass' &&
        r.trigger === 'regenerated' &&
        meta.reviewHistory?.[0]?.status === 'fail' &&
        meta.history?.[0]?.before === 'fix_review' &&
        (d.body as typeof better).paragraphs[0] === better.paragraphs[0],
      JSON.stringify({ before: meta.history?.[0]?.before, body: d.body }).slice(
        0,
        400,
      ),
    );
    let refused = false;
    try {
      await refineDraft({
        draft: await load(),
        userId: owner.id,
        action: 'fix_review',
      });
    } catch (e) {
      refused = (e as { status?: number }).status === 409;
    }
    check('regenerating from a review with nothing to fix is refused', refused);

    // ---------------------------------------------------------- Human review
    console.log(
      '\n5. Content that needs human review is marked, and needs the approver',
    );
    await withStub(
      () => ({
        dimensions: scores(5, { compliance: 1 }),
        issues: [
          {
            dimension: 'compliance',
            severity: 'blocker',
            problem: 'Could read as a health claim.',
            quote: null,
            fix: null,
          },
        ],
        summary: 'Check the compliance point.',
      }),
      async () => reviewDraft(await load(), { trigger: 'manual' }),
    );
    r = reviewOf(await load())!;
    check(
      'an AI compliance concern alone does not fail — it requires human review',
      r.status === 'review_required' &&
        r.failed.length === 0 &&
        r.humanReviewReasons.some((x) => x.startsWith('Compliance:')) &&
        r.issues.find((i) => i.dimension === 'compliance')?.severity ===
          'major',
      JSON.stringify({ status: r.status, reasons: r.humanReviewReasons }),
    );
    const submitted = await ownerC.req(
      'POST',
      `/api/content/drafts/${draftId}/status`,
      { action: 'submit' },
    );
    check(
      'it can be submitted (200)',
      submitted.status === 200 && (await load()).status === 'PENDING_APPROVAL',
      `${submitted.status} ${JSON.stringify(submitted.json)}`,
    );
    const p2 = await ownerC.page(`/dashboard/content/${draftId}`);
    check(
      'the page marks it “Needs human review”, with the reason and the approver’s confirmation',
      p2.text.includes('Needs human review') &&
        p2.text.includes('Could read as a health claim') &&
        p2.text.includes(
          'I’ve looked at what the review marked for human review',
        ),
    );
    const approveNo = await ownerC.req(
      'POST',
      `/api/content/drafts/${draftId}/status`,
      { action: 'approve', factsReviewed: true },
    );
    check(
      'approving without confirming is refused (409)',
      approveNo.status === 409 &&
        /needs a person's review/.test(String(approveNo.json?.error)),
      `${approveNo.status} ${JSON.stringify(approveNo.json)}`,
    );
    const approveYes = await ownerC.req(
      'POST',
      `/api/content/drafts/${draftId}/status`,
      { action: 'approve', factsReviewed: true, reviewAcknowledged: true },
    );
    d = await load();
    const audit = await db.auditLog.findFirst({
      where: { companyId, action: 'CONTENT_APPROVED' },
      orderBy: { createdAt: 'desc' },
    });
    const am = (audit?.metadata ?? {}) as Record<string, unknown>;
    check(
      'with the confirmation it is approved; who looked is stored, and the audit records the review',
      approveYes.status === 200 &&
        d.status === 'APPROVED' &&
        reviewOf(d)?.acknowledgedBy === owner.id &&
        am.review === 'review_required' &&
        am.reviewAcknowledgedByApprover === true,
      `${approveYes.status} ${JSON.stringify(approveYes.json)} ${JSON.stringify(am)}`,
    );

    // ------------------------------------------------------------- Rules
    console.log('\n6. Rules and the reviewer together');
    const long = await db.contentDraft.create({
      data: {
        companyId,
        createdById: owner.id,
        type: 'LINKEDIN_POST',
        platform: 'LINKEDIN',
        status: 'DRAFT',
        title: 'Too long',
        body: {
          ...POST,
          paragraphs: [
            ...POST.paragraphs,
            'We roast single-origin coffee in small batches. '.repeat(70),
          ],
        },
        aiMetadata: {
          source: {
            kind: 'BRIEF',
            brief: 'A post about our coffee subscriptions',
          },
        },
      },
    });
    const lr = await withStub(
      () => PASS,
      async () => reviewDraft(long, { trigger: 'manual' }),
    );
    check(
      'a rule breach (too long for LinkedIn) fails channel fit even when the reviewer scored it 5/5',
      lr.result.review.status === 'fail' &&
        lr.result.review.failed.includes('channel_fit') &&
        lr.result.review.issues.some(
          (i) => i.source === 'rules' && i.severity === 'blocker',
        ),
      JSON.stringify(lr.result.review.failed),
    );
    const down = await withStub(
      () =>
        new Response(
          JSON.stringify({ error: { code: 429, message: 'quota' } }),
          {
            status: 429,
          },
        ),
      async () => reviewDraft(long, { trigger: 'manual' }),
    );
    const dr = down.result.review;
    check(
      'with the AI provider down the rules still run, unassessed dimensions are marked, nothing passes silently',
      !dr.reviewer.ran &&
        dr.reviewer.unavailable === 'the AI provider is at its limit' &&
        dr.dimensions.find((x) => x.dimension === 'relevance')?.verdict ===
          'not_assessed' &&
        dr.dimensions.find((x) => x.dimension === 'channel_fit')?.verdict ===
          'fail' &&
        dr.status === 'fail',
      JSON.stringify(dr.reviewer),
    );

    // ------------------------------------------------------------- Stale
    console.log('\n7. A changed piece is reviewed again before it moves on');
    const edited = await ownerC.req('PATCH', `/api/content/drafts/${long.id}`, {
      body: POST,
    });
    const getR = await ownerC.req(
      'GET',
      `/api/content/drafts/${long.id}/review`,
    );
    check(
      'after an edit the stored review is out of date (API and page)',
      edited.status === 200 &&
        getR.status === 200 &&
        getR.json?.current === false &&
        getR.json?.review?.dimensions?.length === 10 &&
        (await ownerC.page(`/dashboard/content/${long.id}`)).text.includes(
          'Out of date',
        ),
      `${edited.status} ${getR.status} ${JSON.stringify(getR.json?.current)}`,
    );
    const sub2 = await ownerC.req(
      'POST',
      `/api/content/drafts/${long.id}/status`,
      {
        action: 'submit',
      },
    );
    const longNow = (await db.contentDraft.findUnique({
      where: { id: long.id },
    }))!;
    const lnr = reviewOf(longNow);
    check(
      'submitting runs a fresh review of the current body first',
      isReviewCurrent(lnr, longNow.body) &&
        lnr?.trigger === 'submitted' &&
        (sub2.status === 200 ||
          (sub2.status === 409 && lnr?.status === 'fail')),
      `${sub2.status} ${lnr?.status} ${lnr?.reviewer.unavailable ?? ''}`,
    );

    // --------------------------------------------------------- Access
    console.log('\n8. Access');
    const viewerC = new Client();
    await viewerC.signIn(viewer.email);
    const vPost = await viewerC.req(
      'POST',
      `/api/content/drafts/${draftId}/review`,
    );
    const vGet = await viewerC.req(
      'GET',
      `/api/content/drafts/${draftId}/review`,
    );
    const outC = new Client();
    await outC.signIn(outsider.email);
    const oGet = await outC.req('GET', `/api/content/drafts/${draftId}/review`);
    check(
      'a viewer can read the review but not run one (403); another workspace cannot see it (404)',
      vGet.status === 200 && vPost.status === 403 && oGet.status === 404,
      `${vGet.status} ${vPost.status} ${oGet.status}`,
    );
  } finally {
    await db.company
      .delete({ where: { id: companyId } })
      .catch(() => undefined);
    await db.company.delete({ where: { id: other.id } }).catch(() => undefined);
    for (const u of [owner, viewer, outsider]) {
      await db.user.delete({ where: { id: u.id } }).catch(() => undefined);
    }
    console.log('  ok      cleanup: throwaway workspaces and users removed');
  }

  console.log(
    failures
      ? `\n${failures} review check(s) failed.`
      : '\nThe AI Reviewer works end to end.',
  );
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
