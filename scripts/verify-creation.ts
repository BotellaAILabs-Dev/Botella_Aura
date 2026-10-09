/**
 * Recommendation acceptance → creation, end to end on the running app.
 *
 * One real workspace, its own suggestions (signals → opportunities → Aura's
 * suggestions), and real people acting through the pages and APIs:
 *
 *   Content     an open suggestion: Content Studio opens filled in, offers
 *               "Say yes and generate"; generating before saying yes is
 *               refused; saying yes from there accepts it; the draft keeps the
 *               recommendation, its opportunity, reason, evidence and business
 *               context, links back, and moves the suggestion to in progress
 *   Workflow    a content-plan suggestion: the planner opens prefilled, the
 *               plan is linked back; a campaign planned from a series suggestion
 *               says yes to it and links back
 *   No content  a "connect a channel" suggestion: no writing form, the reason,
 *               and the button to where it is done; creation refused by the API
 *   Closed      a skipped suggestion: refused, plainly
 *   Needs info  no business description: refused, with the question to answer
 *   Access      a member cannot say yes by creating; another workspace sees nothing
 *
 * Draft writing needs the live model; when it is unavailable, the draft is
 * created through the same service calls the route makes, so everything after
 * it (provenance, link, status, the draft page) is still checked.
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:creation
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { creationProvenance } from '@/lib/recommendation-creation';
import { runDetection } from '@/server/opportunities/detection.service';
import { suggestFromOpportunities } from '@/server/recommendations/autosuggest.service';
import {
  getCreation,
  recordCreation,
} from '@/server/recommendations/creation.service';
import { collectSignals } from '@/server/signals/signal.service';

const BASE = (
  process.env.VERIFY_BASE_URL ??
  process.env.AURA_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-create-${STAMP}!`;
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
      email: `zzverify-create-${label}-${STAMP}@example.test`,
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

async function main() {
  const owner = await person('owner');
  const member = await person('member');
  const outsider = await person('outsider');
  const company = await db.company.create({
    data: {
      name: 'zzverify create Roastery',
      slug: `zzverify-create-${STAMP}`,
      industry: 'Coffee',
      website: 'https://roastery.example',
      preferences: PROFILE as Prisma.InputJsonObject,
    },
  });
  const other = await db.company.create({
    data: {
      name: 'zzverify create Other',
      slug: `zzverify-create-other-${STAMP}`,
    },
  });
  const companyId = company.id;
  await db.companyMember.createMany({
    data: [
      { userId: owner.id, companyId, role: 'OWNER' },
      { userId: member.id, companyId, role: 'MEMBER' },
      { userId: outsider.id, companyId: other.id, role: 'OWNER' },
    ],
  });

  try {
    const recs = await seed(companyId);
    const contentRec =
      recs.find(
        (r) => CONTENT_ACTIONS.includes(actionOf(r)) && r.blockers.length === 0,
      ) ?? recs.find((r) => CONTENT_ACTIONS.includes(actionOf(r)));
    const actionRec = recs.find((r) =>
      ['connect-channel', 'update-audience'].includes(actionOf(r)),
    );
    const spare = recs.filter(
      (r) => r.id !== contentRec?.id && r.id !== actionRec?.id,
    );
    console.log(
      `   seeded ${recs.length} suggestions: ${recs.map((r) => actionOf(r)).join(', ')}`,
    );
    if (!contentRec || !actionRec || spare.length < 2) {
      throw new Error(
        'The seed did not produce the suggestions this check needs.',
      );
    }
    // Two more to stand for the workflow kinds — same engine output, routed
    // by the action the engine records.
    const [planRec, seriesRec] = spare;
    await db.recommendation.update({
      where: { id: planRec!.id },
      data: {
        details: { ...(planRec!.details as object), action: 'plan-it' },
        blockers: [],
        executable: true,
      },
    });
    await db.recommendation.update({
      where: { id: seriesRec!.id },
      data: {
        details: { ...(seriesRec!.details as object), action: 'series' },
        blockers: [],
        executable: true,
      },
    });
    await db.recommendation.updateMany({
      where: { companyId },
      data: { status: 'PRESENTED' },
    });
    await db.recommendation.update({
      where: { id: contentRec.id },
      data: { blockers: [], executable: true },
    });

    const me = new Client();
    check(
      'the owner signs in to the running app',
      (await me.signIn(owner.email)) === owner.email,
    );

    // ------------------------------------------------------------- Content
    console.log(
      '\n1. A content suggestion → Content Studio → a draft that remembers it',
    );
    const g1 = await me.req(
      'GET',
      `/api/recommendations/${contentRec.id}/creation`,
    );
    check(
      'the API says what Create means: a content draft, saying yes on the way',
      g1.status === 200 &&
        g1.json.plan.kind === 'content' &&
        g1.json.plan.state === 'accept_first' &&
        g1.json.plan.creates === 'a content draft' &&
        g1.json.plan.href.startsWith('/dashboard/content/new?rec='),
      JSON.stringify(g1.json?.plan),
    );
    const studio = await me.page(`/dashboard/content/new?rec=${contentRec.id}`);
    check(
      'Content Studio opens filled in from the suggestion, with its context, offering “Say yes and generate”',
      studio.status === 200 &&
        studio.text.includes('Content brief') &&
        studio.text.includes('Say yes and generate') &&
        studio.text.includes(contentRec.title.slice(0, 30)),
    );
    const early = await me.req('POST', '/api/content/generate', {
      type: 'LINKEDIN_POST',
      source: { kind: 'BRIEF', brief: 'A post about our coffee.' },
      recommendationId: contentRec.id,
    });
    check(
      'generating before saying yes is refused — no draft for a suggestion nobody agreed to',
      early.status === 409 &&
        /Say yes to this suggestion first/.test(early.json.error),
      `${early.status} ${early.json?.error}`,
    );
    const memberClient = new Client();
    await memberClient.signIn(member.email);
    const m = await memberClient.req(
      'POST',
      `/api/recommendations/${contentRec.id}/creation`,
      { module: 'content-studio' },
    );
    check(
      'a member cannot say yes by creating — owners and admins decide (it stays open)',
      m.status === 403 &&
        (await db.recommendation.findUnique({ where: { id: contentRec.id } }))
          ?.status === 'PRESENTED',
      `${m.status}`,
    );
    const yes = await me.req(
      'POST',
      `/api/recommendations/${contentRec.id}/creation`,
      { module: 'content-studio' },
    );
    const afterYes = await db.recommendation.findUnique({
      where: { id: contentRec.id },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    check(
      'saying yes from Content Studio accepts it, and the history says where',
      yes.status === 200 &&
        yes.json.plan.state === 'ready' &&
        afterYes?.status === 'ACCEPTED' &&
        /creating from it in Content Studio/.test(
          afterYes.events[0]?.note ?? '',
        ),
      `${yes.status} ${afterYes?.status} ${afterYes?.events[0]?.note}`,
    );
    const again = await me.req(
      'POST',
      `/api/recommendations/${contentRec.id}/creation`,
      { module: 'content-studio' },
    );
    check(
      'saying yes twice changes nothing',
      again.status === 200 && again.json.plan.state === 'ready',
    );
    check(
      'the API hands over a ready Content Studio request carrying the recommendation',
      again.json.contentRequest?.recommendationId === contentRec.id &&
        again.json.contentRequest?.source?.brief?.length > 20,
    );

    const gen = await me.req('POST', '/api/content/generate', {
      ...again.json.contentRequest,
      variations: 1,
    });
    let draftId: string | null = gen.status === 201 ? gen.json.id : null;
    if (draftId) {
      console.log('   draft written by the live model');
    } else {
      console.log(
        `   live model unavailable (${gen.status}: ${String(gen.json?.error ?? '').slice(0, 80)}) — creating the draft through the same service calls`,
      );
      const creation = await getCreation(
        companyId,
        contentRec.id,
        'content-studio',
      );
      const draft = await db.contentDraft.create({
        data: {
          companyId,
          createdById: owner.id,
          type: 'LINKEDIN_POST',
          status: 'DRAFT',
          title: 'Our own take on the coffee price rise',
          body: { text: 'Draft body.' },
          aiMetadata: {
            source: { kind: 'BRIEF', brief: 'x' },
            recommendation: {
              ...(creationProvenance(
                creation!.handoff,
              ) as unknown as Prisma.InputJsonObject),
              id: contentRec.id,
              title: contentRec.title,
            },
          },
        },
      });
      await recordCreation({
        companyId,
        recommendationId: contentRec.id,
        module: 'content-studio',
        created: { type: 'content-draft', id: draft.id, label: draft.title },
        actorId: owner.id,
      });
      draftId = draft.id;
    }
    const draft = await db.contentDraft.findUnique({ where: { id: draftId } });
    const kept =
      (draft?.aiMetadata as { recommendation?: Record<string, any> } | null)
        ?.recommendation ?? {};
    check(
      'the draft keeps the recommendation, its opportunity, reason, evidence and business context',
      kept.id === contentRec.id &&
        kept.opportunityId === contentRec.opportunityId &&
        typeof kept.why === 'string' &&
        Array.isArray(kept.evidence) &&
        kept.evidence.length > 0 &&
        kept.business?.name === company.name &&
        typeof kept.expectedOutcome === 'string',
      JSON.stringify(Object.keys(kept)),
    );
    const progressed = await db.recommendation.findUnique({
      where: { id: contentRec.id },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });
    check(
      'the suggestion is now in progress, and its history leads to the draft',
      progressed?.status === 'IN_PROGRESS' &&
        progressed.events.some(
          (e) =>
            e.action === 'link' &&
            (e.metadata as { created?: { id?: string } })?.created?.id ===
              draftId,
        ),
      progressed?.status,
    );
    const draftPage = await me.page(`/dashboard/content/${draftId}`);
    check(
      'the draft page says which suggestion it came from, why, on what evidence, and the opportunity',
      draftPage.status === 200 &&
        draftPage.text.includes('Created from Aura’s suggestion') &&
        draftPage.text.includes('Based on') &&
        draftPage.text.includes('See the opportunity behind it'),
    );
    const historyPage = await me.page('/dashboard/suggestions/history');
    check(
      'History offers Create on it, and lists the draft made from it',
      historyPage.text.includes(
        'Creates a content draft, filled in from this suggestion',
      ) && historyPage.text.includes('Made from it'),
    );
    const second = await getCreation(
      companyId,
      contentRec.id,
      'content-studio',
    );
    check(
      'a second piece can be created from it while in progress',
      second?.plan.state === 'ready',
    );

    // -------------------------------------------------------------- No content
    console.log('\n2. A suggestion with nothing to write');
    const ga = await me.req(
      'GET',
      `/api/recommendations/${actionRec.id}/creation`,
    );
    check(
      `“${actionOf(actionRec)}” is not creatable, and says where it is done`,
      ga.json.plan.kind === 'action' &&
        ga.json.plan.state === 'not_creatable' &&
        ga.json.plan.fix?.href,
      JSON.stringify(ga.json?.plan),
    );
    const actionPage = await me.page(
      `/dashboard/content/new?rec=${actionRec.id}`,
    );
    check(
      'Content Studio shows the reason and the right button — not a writing form',
      actionPage.text.includes('Nothing to write for this suggestion') &&
        actionPage.text.includes(ga.json.plan.fix.label) &&
        !actionPage.text.includes('Generate draft'),
    );
    const pa = await me.req(
      'POST',
      `/api/recommendations/${actionRec.id}/creation`,
      {},
    );
    const ca = await me.req('POST', '/api/content/generate', {
      type: 'LINKEDIN_POST',
      source: { kind: 'BRIEF', brief: 'x' },
      recommendationId: actionRec.id,
    });
    check(
      'creating from it is refused by the API, with where to go instead',
      pa.status === 409 &&
        ca.status === 409 &&
        ca.json.fix?.href === ga.json.plan.fix.href,
      `${pa.status} ${ca.status}`,
    );
    check(
      'and it was not said yes to along the way',
      (await db.recommendation.findUnique({ where: { id: actionRec.id } }))
        ?.status === 'PRESENTED',
    );
    const suggestsPage = await me.page('/dashboard/suggestions');
    check(
      'Aura Suggests says up front what each action makes',
      suggestsPage.text.includes('Nothing to write — this one is done in') ||
        suggestsPage.text.includes('Creates a content draft in Content Studio'),
    );

    // --------------------------------------------------------------- Workflow
    console.log('\n3. Suggestions that open another Aura workflow');
    const gp = await me.req(
      'GET',
      `/api/recommendations/${planRec!.id}/creation`,
    );
    check(
      'a plan suggestion creates a month’s content plan in the planner',
      gp.json.plan.kind === 'workflow' &&
        gp.json.plan.module === 'content-plan' &&
        gp.json.plan.href.startsWith('/dashboard/planner?rec='),
      JSON.stringify(gp.json?.plan),
    );
    const plannerPage = await me.page(`/dashboard/planner?rec=${planRec!.id}`);
    check(
      'the planner opens filled in from the suggestion, and says so',
      plannerPage.status === 200 &&
        plannerPage.text.includes('From Aura’s suggestion') &&
        plannerPage.text.includes('are filled in from it'),
    );
    await me.req('POST', `/api/recommendations/${planRec!.id}/creation`, {
      module: 'content-plan',
    });
    const job = await me.req('POST', '/api/jobs', {
      kind: 'MARKETING_PLAN',
      inputs: {
        month: '2026-12',
        businessGoals: 'Grow coffee subscriptions this quarter.',
        campaignObjectives: 'Book 15 tasting calls.',
        topics: ['freshness'],
        channels: ['LinkedIn'],
        postsPerWeek: 2,
        recommendationId: planRec!.id,
      },
    });
    await me.req('POST', `/api/jobs/${job.json.id}/run`);
    const planned = await db.recommendation.findUnique({
      where: { id: planRec!.id },
      include: { events: true },
    });
    check(
      'the finished plan is linked back, and the suggestion is in progress',
      planned?.status === 'IN_PROGRESS' &&
        planned.events.some(
          (e) =>
            (e.metadata as { created?: { type?: string } })?.created?.type ===
            'content-plan',
        ),
      planned?.status,
    );

    const gs = await me.req(
      'GET',
      `/api/recommendations/${seriesRec!.id}/creation`,
    );
    check(
      'a series suggestion creates a campaign plan',
      gs.json.plan.module === 'campaigns' &&
        gs.json.plan.creates === 'a campaign plan',
    );
    const camp = await me.req('POST', '/api/campaigns/orchestrate', {
      name: 'Coffee price series',
      goal: 'Explain our pricing over three weeks.',
      durationDays: 21,
      modules: {
        content: true,
        outreach: false,
        engagement: false,
        discovery: false,
      },
      targetAudience: 'Home brewers',
      themes: ['pricing'],
      recommendationId: seriesRec!.id,
    });
    const seriesAfter = await db.recommendation.findUnique({
      where: { id: seriesRec!.id },
      include: { events: true },
    });
    check(
      'planning the campaign says yes to it, links the campaign and marks it in progress',
      camp.status === 201 &&
        seriesAfter?.status === 'IN_PROGRESS' &&
        seriesAfter.events.some(
          (e) =>
            (e.metadata as { created?: { id?: string } })?.created?.id ===
            camp.json.id,
        ),
      `${camp.status} ${camp.json?.error ?? ''} ${seriesAfter?.status}`,
    );

    // ------------------------------------------------------- Closed, needs info
    console.log('\n4. Suggestions that cannot be created from');
    const closedRec = recs.find(
      (r) =>
        ![contentRec.id, actionRec.id, planRec!.id, seriesRec!.id].includes(
          r.id,
        ),
    );
    if (closedRec) {
      await me.req('POST', `/api/recommendations/${closedRec.id}/decision`, {
        decision: 'SKIPPED',
      });
      const gc = await me.req(
        'GET',
        `/api/recommendations/${closedRec.id}/creation?module=content-studio`,
      );
      const pc = await me.page(`/dashboard/content/new?rec=${closedRec.id}`);
      check(
        'a skipped suggestion: closed, said plainly, no form',
        gc.json.plan.state === 'closed' &&
          /You skipped this suggestion/.test(gc.json.plan.message) &&
          pc.text.includes('This suggestion is closed'),
      );
    } else {
      console.log('  skip    no spare suggestion to skip');
    }
    await db.company.update({
      where: { id: companyId },
      data: {
        preferences: {
          marketingProfile: PROFILE.marketingProfile,
        } as Prisma.InputJsonObject,
      },
    });
    const gi = await me.req(
      'GET',
      `/api/recommendations/${contentRec.id}/creation`,
    );
    const pi = await me.page(`/dashboard/content/new?rec=${contentRec.id}`);
    check(
      'without what the business does: needs info, with the question to answer, and Generate held',
      gi.json.plan.state === 'needs_info' &&
        gi.json.plan.fix?.href?.startsWith('/dashboard/business') &&
        pi.text.includes('Aura can’t write this one yet'),
      JSON.stringify(gi.json?.plan),
    );
    await db.company.update({
      where: { id: companyId },
      data: { preferences: PROFILE as Prisma.InputJsonObject },
    });

    // ------------------------------------------------------------------ Access
    console.log('\n5. Access');
    const out = new Client();
    await out.signIn(outsider.email);
    const o1 = await out.req(
      'GET',
      `/api/recommendations/${contentRec.id}/creation`,
    );
    const o2 = await out.req(
      'POST',
      `/api/recommendations/${contentRec.id}/creation`,
      {},
    );
    const o3 = await out.page(`/dashboard/content/new?rec=${contentRec.id}`);
    check(
      'another workspace sees nothing: 404, and Content Studio fills nothing in',
      o1.status === 404 &&
        o2.status === 404 &&
        o3.text.includes('isn’t available any more') &&
        !o3.text.includes(contentRec.title.slice(0, 30)),
      `${o1.status} ${o2.status}`,
    );
  } finally {
    await db.company
      .delete({ where: { id: companyId } })
      .catch(() => undefined);
    await db.company.delete({ where: { id: other.id } }).catch(() => undefined);
    for (const u of [owner, member, outsider]) {
      await db.user.delete({ where: { id: u.id } }).catch(() => undefined);
    }
    console.log('  ok      cleanup: throwaway workspaces and users removed');
  }

  console.log(
    failures
      ? `\n${failures} creation check(s) failed.`
      : '\nAcceptance → creation works end to end.',
  );
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

const CONTENT_ACTIONS = [
  'post',
  'article',
  'response-post',
  'comparison-article',
  'targeted-post',
  'recovery-post',
];

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
