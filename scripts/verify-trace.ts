/**
 * Recommendation → content traceability, against the real database and the
 * running app (lib/trace.ts, server/trace). The chain is built for real —
 * signals, detection, a suggestion, acceptance, a brief — and only the AI is
 * stubbed.
 *
 *   Recorded   the asset stores its recommendation, opportunity, signals,
 *              brief and business-context revision when it is generated
 *   Approved   the reviewed and approved versions and the approval id
 *   Resolved   why it exists, traced back; flat rows for analytics
 *   Versions   the chain holds across edits and re-approval, and outlives a
 *              deleted recommendation
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:trace
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { approvalOf } from '@/lib/approval';
import { briefText } from '@/lib/content-brief';
import { REVIEW_DIMENSIONS } from '@/lib/content-review';
import { traceOf, type ContentTrace } from '@/lib/trace';
import { getContentBrief } from '@/server/content/content-brief.service';
import { generateDraft } from '@/server/content/generator';
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
const PASSWORD = `Zz-trace-${STAMP}!`;
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
      email: `zzverify-trace-${label}-${STAMP}@example.test`,
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

/** The AI stubbed at the network: the writer returns `body`; the reviewer passes. */
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
      : prompt.includes('"hook": string') || prompt.startsWith('TASK: Revise')
        ? body
        : {};
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
  hook: 'Specialty coffee prices are climbing as harvests shrink.',
  paragraphs: [
    'We roast single-origin coffee in small batches.',
    'Our subscriptions keep good beans on your shelf.',
    'How do you brew at home?',
  ],
  cta: 'Start your coffee subscription on our site.',
  hashtags: ['coffee', 'specialtycoffee', 'homebrewing'],
};

async function main() {
  const owner = await person('owner');
  const outsider = await person('outsider');
  const company = await db.company.create({
    data: {
      name: 'zzverify trace Roastery',
      slug: `zzverify-trace-${STAMP}`,
      industry: 'Coffee',
      website: 'https://www.roastery.example',
      preferences: PROFILE as Prisma.InputJsonObject,
    },
  });
  const other = await db.company.create({
    data: { name: 'zzverify trace Other', slug: `zzverify-trace-o-${STAMP}` },
  });
  const companyId = company.id;
  await db.companyMember.createMany({
    data: [
      { userId: owner.id, companyId, role: 'OWNER' },
      { userId: outsider.id, companyId: other.id, role: 'OWNER' },
    ],
  });
  const load = async (id: string) =>
    (await db.contentDraft.findUnique({ where: { id } }))!;

  try {
    // ---------------------------------------------------------- The chain
    console.log('\n1. The chain is recorded when the asset is generated');
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
    const draft = await withAi(POST, () =>
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
    const t0 = traceOf((await load(draft.id)).aiMetadata)!;
    const linkedSignals = await db.recommendationEvidence.findMany({
      where: { recommendationId: rec.id, signalId: { not: null } },
      select: { signalId: true },
    });
    check(
      'the asset stores its recommendation, opportunity, signals, brief and business-context revision',
      Boolean(t0) &&
        t0.recommendationId === rec.id &&
        t0.opportunityId === rec.opportunityId &&
        t0.signalIds.length > 0 &&
        linkedSignals.every((s) => t0.signalIds.includes(s.signalId!)) &&
        (t0.briefId ?? '').startsWith('brf_') &&
        Boolean(t0.businessContext.revision) &&
        t0.traceId.startsWith('trc_'),
      JSON.stringify(t0).slice(0, 300),
    );

    // --------------------------------------------- Reviewed and approved
    console.log('\n2. Reviewed and approved versions, with the approval');
    const ownerC = new Client();
    await ownerC.signIn(owner.email);
    const before = await load(draft.id);
    await ownerC.req('POST', `/api/review/content/${draft.id}`, {
      action: 'save',
      edits: {
        hook: 'Specialty coffee prices are climbing — here is how we keep yours steady.',
      },
      baseUpdatedAt: before.updatedAt.toISOString(),
    });
    await withAi(POST, async () =>
      reviewDraft(await load(draft.id), { trigger: 'manual' }),
    );
    await ownerC.req('POST', `/api/content/drafts/${draft.id}/status`, {
      action: 'submit',
    });
    const ap = await ownerC.req(
      'POST',
      `/api/content/drafts/${draft.id}/status`,
      { action: 'approve', factsReviewed: true, reviewAcknowledged: true },
    );
    const a = await load(draft.id);
    const t1 = traceOf(a.aiMetadata)!;
    const approval = approvalOf(a.aiMetadata)!;
    check(
      'the approved version (v2), the review it passed and the approval id are on the trace — the approval carries the same id',
      ap.status === 200 &&
        t1.approvedVersion === 2 &&
        t1.reviewedVersion === 2 &&
        (t1.reviewId ?? '').startsWith('rvw_') &&
        (t1.approvalId ?? '').startsWith('apv_') &&
        approval.approved?.id === t1.approvalId &&
        t1.recommendationId === rec.id,
      `${ap.status} ${ap.json?.error ?? ''} ${JSON.stringify(t1)}`,
    );
    const audit = await db.auditLog.findFirst({
      where: { companyId, action: 'CONTENT_APPROVED' },
      orderBy: { createdAt: 'desc' },
    });
    const at = (audit?.metadata as { trace?: Record<string, unknown> } | null)
      ?.trace;
    check(
      'the approval’s audit entry carries the chain ids',
      at?.approvalId === t1.approvalId &&
        at?.recommendationId === rec.id &&
        at?.opportunityId === rec.opportunityId &&
        at?.traceId === t1.traceId,
    );

    // --------------------------------------------------------- Resolved
    console.log('\n3. Tracing an approved asset back');
    const r = await ownerC.req('GET', `/api/content/drafts/${draft.id}/trace`);
    const tr = r.json?.trace as ContentTrace;
    const recRow = await db.recommendation.findUnique({
      where: { id: rec.id },
    });
    const oppRow = await db.opportunity.findUnique({
      where: { id: rec.opportunityId },
    });
    check(
      'why it was created, which recommendation, which opportunity, which signals and business context, and who approved which version',
      r.status === 200 &&
        tr.origin === 'recommendation' &&
        tr.why === recRow!.rationale &&
        tr.recommendation?.title === recRow!.title &&
        tr.recommendation?.decidedBy === 'Dana owner' &&
        tr.opportunity?.title === oppRow!.title &&
        tr.signals.length > 0 &&
        tr.businessContext.name === 'zzverify trace Roastery' &&
        Boolean(tr.brief?.keyMessage) &&
        tr.generated.version === 1 &&
        tr.reviewed?.version === 2 &&
        tr.approved?.version === 2 &&
        tr.approved.by === 'Dana owner' &&
        tr.approved.id === t1.approvalId &&
        tr.gaps.length === 0,
      `${r.status} ${JSON.stringify(tr).slice(0, 400)}`,
    );
    const rows = await ownerC.req('GET', '/api/analytics/traces');
    const row = (rows.json?.rows ?? []).find(
      (x: { assetId: string }) => x.assetId === draft.id,
    );
    check(
      'analytics get the ids in one flat row (and the snapshots to join performance on)',
      rows.status === 200 &&
        row?.traceId === t1.traceId &&
        row.recommendationId === rec.id &&
        row.opportunityId === rec.opportunityId &&
        row.approvalId === t1.approvalId &&
        row.approvedVersion === 2 &&
        row.signalIds.length > 0 &&
        Array.isArray(row.performanceSnapshotIds) &&
        row.briefId === t1.briefId,
      JSON.stringify(row).slice(0, 300),
    );

    // ------------------------------------------- Across versions
    console.log('\n4. Relationships hold across versions');
    const b2 = await load(draft.id);
    await ownerC.req('POST', `/api/review/content/${draft.id}`, {
      action: 'save',
      edits: { cta: 'Try a bag this week.' },
      baseUpdatedAt: b2.updatedAt.toISOString(),
    });
    const t2 = traceOf((await load(draft.id)).aiMetadata)!;
    check(
      'editing approved content keeps the chain, and the trace still names the version that WAS approved',
      t2.recommendationId === rec.id &&
        t2.opportunityId === rec.opportunityId &&
        t2.briefId === t0.briefId &&
        t2.traceId === t0.traceId &&
        t2.approvedVersion === 2,
    );
    await withAi(POST, async () =>
      reviewDraft(await load(draft.id), { trigger: 'manual' }),
    );
    await ownerC.req('POST', `/api/content/drafts/${draft.id}/status`, {
      action: 'submit',
    });
    await ownerC.req('POST', `/api/content/drafts/${draft.id}/status`, {
      action: 'approve',
      factsReviewed: true,
      reviewAcknowledged: true,
    });
    const t3 = traceOf((await load(draft.id)).aiMetadata)!;
    check(
      're-approving moves the trace to the new version with a new approval id',
      t3.approvedVersion === 3 &&
        t3.approvalId !== t1.approvalId &&
        t3.traceId === t0.traceId,
      JSON.stringify(t3),
    );

    // A recommendation removed later: the asset still knows where it came from.
    await db.recommendation.delete({ where: { id: rec.id } });
    const gone = (
      await ownerC.req('GET', `/api/content/drafts/${draft.id}/trace`)
    ).json?.trace as ContentTrace;
    check(
      'if the recommendation is deleted later, the asset still names it (from its own record) and says the live record is gone',
      gone.recommendation?.id === rec.id &&
        Boolean(gone.recommendation?.title) &&
        gone.gaps.includes('recommendation'),
      JSON.stringify({ rec: gone.recommendation, gaps: gone.gaps }),
    );

    // ---------------------------------------------------- Own brief
    const own = await withAi(POST, () =>
      generateDraft({
        companyId,
        userId: owner.id,
        type: 'LINKEDIN_POST',
        platform: 'LINKEDIN',
        source: { kind: 'BRIEF', brief: 'Tell people about our Monday roast' },
        variations: 1,
      }),
    );
    const ot = (await ownerC.req('GET', `/api/content/drafts/${own.id}/trace`))
      .json?.trace as ContentTrace;
    check(
      'an asset from a person’s own brief traces to that request and the business context',
      ot.origin === 'brief' &&
        ot.why === 'Requested: Tell people about our Monday roast' &&
        ot.ids.recommendationId === null &&
        ot.brief?.request === 'Tell people about our Monday roast',
    );

    const page = await ownerC.page(`/dashboard/review/content/${draft.id}`);
    const outC = new Client();
    await outC.signIn(outsider.email);
    const og = await outC.req('GET', `/api/content/drafts/${draft.id}/trace`);
    check(
      'the review screen shows why it exists; another workspace cannot read the trace (404)',
      page.status === 200 &&
        [
          'Why this exists',
          'Business context',
          'Signals',
          'Opportunity',
          'Recommendation',
          'Content brief',
          'Generated asset',
          'Reviewed version',
          'Approved version',
        ].every((x) => page.text.includes(x)) &&
        og.status === 404,
      `${page.status} ${og.status}`,
    );
  } finally {
    await db.company
      .delete({ where: { id: companyId } })
      .catch(() => undefined);
    await db.company.delete({ where: { id: other.id } }).catch(() => undefined);
    for (const u of [owner, outsider])
      await db.user.delete({ where: { id: u.id } }).catch(() => undefined);
    console.log('  ok      cleanup: throwaway workspaces and users removed');
  }

  console.log(
    failures
      ? `\n${failures} trace check(s) failed.`
      : '\nRecommendation → content traceability works end to end.',
  );
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
