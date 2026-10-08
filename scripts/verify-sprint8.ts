/**
 * Sprint 8 end-to-end: Opportunity → Recommendation → Aura Home, on a real
 * workspace, against the running app — through the real services where it is
 * internal, and through the real pages and APIs where a person acts.
 *
 *   Empty state               a bare workspace: Aura says what it needs, writes nothing
 *   Business Context          the profile is filled in; Aura reads it
 *   Signals                   every source collected and normalised
 *   Opportunity               detected, with evidence
 *   Recommendation Engine     suggestions written from the opportunities
 *   Recommendation Validation every one quality-checked; none blocked
 *   Prioritization            ranked, banded, explained
 *   Aura Suggests             the page shows them; presented is recorded
 *   Aura Home                 What matters now + the top suggestions
 *   Accept / Edit / Skip / Reject   through the API, as a person would
 *   Recommendation History    every answer, with timestamps and its opportunity
 *   Ready for Sprint 9        the accepted ones hand over a valid content request
 *
 * With GEMINI_API_KEY set (node --env-file=.env), it also writes one
 * recommendation with the live model and checks it passes validation.
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:sprint8
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { executionBrief } from '@/lib/recommendations';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import { runDetection } from '@/server/opportunities/detection.service';
import { suggestFromOpportunities } from '@/server/recommendations/autosuggest.service';
import { generateRecommendation } from '@/server/recommendations/engine.service';
import { qualityFor } from '@/server/recommendations/quality.service';
import { surfaceRecommendations } from '@/server/recommendations/ranking.service';
import { getReadiness } from '@/server/recommendations/readiness.service';
import { collectSignals } from '@/server/signals/signal.service';

const BASE = (
  process.env.VERIFY_BASE_URL ??
  process.env.AURA_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-sprint8-${STAMP}!`;
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
    return { status: res.status, json, text };
  }
  /** A page's visible text (no scripts, no tags). */
  async page(path: string) {
    const r = await this.req('GET', path);
    return {
      status: r.status,
      text: r.text
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#x27;|&rsquo;/g, '’')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' '),
      broken: r.text.includes('Something failed while building this view'),
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

async function main() {
  const email = `zzverify-sprint8-${STAMP}@example.test`;
  const user = await db.user.create({
    data: {
      email,
      name: 'Dana Sprint',
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      emailVerified: new Date(),
    },
  });
  const company = await db.company.create({
    data: {
      name: 'zzverify sprint8 Roastery',
      slug: `zzverify-sprint8-${STAMP}`,
      industry: 'Coffee',
    },
  });
  await db.companyMember.create({
    data: { userId: user.id, companyId: company.id, role: 'OWNER' },
  });
  const companyId = company.id;
  const me = new Client();

  try {
    check(
      'a real user signs in to the running app',
      (await me.signIn(email)) === email,
    );

    // ------------------------------------------------------------------ Empty
    console.log('\n0. Empty state — before Aura knows anything');
    const empty = await getReadiness(companyId);
    const run0 = await suggestFromOpportunities(companyId, {
      templatesOnly: true,
    });
    const emptyPage = await me.page('/dashboard/suggestions');
    check(
      'Aura says what it needs, writes nothing, and the page explains it',
      empty.state === 'blocked' &&
        run0.created.length === 0 &&
        Boolean(run0.notReady) &&
        emptyPage.status === 200 &&
        emptyPage.text.includes(
          'What Aura needs before it can suggest anything',
        ),
      `${empty.primary?.scenario} / ${run0.notReady}`,
    );

    // ------------------------------------------------------- Business Context
    console.log('\n1. Business Context');
    await db.company.update({
      where: { id: companyId },
      data: {
        website: 'https://roastery.example',
        preferences: {
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
        } as Prisma.InputJsonObject,
      },
    });
    const ctx = await getBusinessContext(companyId);
    check(
      'the profile is read: what it does, audience, goals, channels',
      Boolean(
        ctx?.identity.description &&
        ctx.audience.stated &&
        ctx.objectives.goals,
      ) && ctx!.channels.preferred.includes('LinkedIn'),
    );

    // ---------------------------------------------------------------- Signals
    console.log('\n2. Signals');
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
    const bySource = await db.signal.groupBy({
      by: ['source'],
      where: { companyId },
      _count: true,
    });
    const sources = bySource.map((s) => s.source);
    check(
      'trends, competitors, results and the business profile become signals',
      ['TRENDS', 'COMPETITORS', 'ANALYTICS', 'BUSINESS_CONTEXT'].every((s) =>
        sources.includes(s as never),
      ),
      sources.join(', '),
    );

    // ------------------------------------------------------------ Opportunity
    console.log('\n3. Opportunity');
    await runDetection(companyId);
    const opps = await db.opportunity.findMany({
      where: { companyId },
      include: { signals: true },
    });
    check(
      'opportunities are detected, each with evidence linked to its signals',
      opps.length >= 3 &&
        opps.every(
          (o) => o.signals.length > 0 && o.signals.some((s) => s.signalId),
        ),
      `${opps.length} opportunities`,
    );

    // ------------------------------------------------- Recommendation Engine
    console.log('\n4. Recommendation Engine');
    const run = await suggestFromOpportunities(companyId, {
      templatesOnly: true,
    });
    const recs = await db.recommendation.findMany({
      where: { companyId },
      include: { evidence: true },
    });
    check(
      'Aura writes suggestions from the opportunities, on its own',
      run.created.length >= 4 && recs.length === run.created.length,
      `${run.created.length} made, ${run.skipped.length} skipped`,
    );
    check(
      'each is linked to its opportunity and carries its evidence',
      recs.every(
        (r) =>
          opps.some((o) => o.id === r.opportunityId) && r.evidence.length > 0,
      ),
    );

    // --------------------------------------------- Recommendation Validation
    console.log('\n5. Recommendation Validation');
    const quality = await qualityFor(
      companyId,
      recs.map((r) => r.id),
    );
    check(
      'every suggestion is quality-checked; none of Aura’s own is blocked',
      recs.every((r) => quality.has(r.id)) &&
        recs.every((r) => quality.get(r.id)!.verdict !== 'blocked'),
      recs.map((r) => quality.get(r.id)!.verdict).join(', '),
    );
    check(
      'each follows the schema and has traceable evidence',
      recs.every((r) =>
        quality
          .get(r.id)!
          .checks.every(
            (c) =>
              !(
                ['schema', 'evidence'].includes(c.check) && c.status === 'fail'
              ),
          ),
      ),
    );

    // ---------------------------------------------------------- Prioritization
    console.log('\n6. Prioritization');
    const ranked = await surfaceRecommendations(companyId);
    check(
      'ranked 1…n, each with a band and a reason',
      ranked.length === recs.length &&
        ranked.every(
          (r, i) =>
            r.rank === i + 1 &&
            ['now', 'next', 'later'].includes(r.band) &&
            r.explanation.length > 10,
        ),
      ranked.map((r) => `${r.rank}:${r.band}`).join(' '),
    );

    // ----------------------------------------------------------- Aura Suggests
    console.log('\n7. Aura Suggests');
    const sugg = await me.page('/dashboard/suggestions');
    const top = recs.find((r) => r.id === ranked[0]!.id)!;
    check(
      'the page shows the suggestions, top one included, with Why / Expected outcome / Based on',
      sugg.status === 200 &&
        !sugg.broken &&
        sugg.text.includes(top.title) &&
        sugg.text.includes('Expected outcome') &&
        sugg.text.includes('Based on'),
    );
    const presented = await me.req('POST', '/api/recommendations/presented', {
      ids: recs.map((r) => r.id),
      surface: 'suggestions',
    });
    check(
      'showing them records them as presented',
      presented.status === 200 &&
        (presented.json as { presented: string[] }).presented.length ===
          recs.length,
      JSON.stringify(presented.json).slice(0, 120),
    );

    // --------------------------------------------------------------- Aura Home
    console.log('\n8. Aura Home');
    const home = await me.page('/dashboard');
    check(
      'Home leads with What matters now, then Aura Suggests, opportunities and results',
      home.status === 200 &&
        !home.broken &&
        [
          'What matters now',
          'Aura Suggests',
          'Active opportunities',
          'Results',
          'Recent activity',
        ].every((h) => home.text.includes(h)),
    );
    check('the top suggestion is on Home', home.text.includes(top.title));

    // ---------------------------------------------- Accept / Edit / Skip / Reject
    console.log('\n9. The user answers — accept, edit, skip, reject');
    const content = recs.filter(
      (r) => executionBrief(r).module === 'content-studio',
    );
    const [toAccept, toEdit] = content;
    const others = recs.filter(
      (r) => r.id !== toAccept?.id && r.id !== toEdit?.id,
    );
    const [toSkip, toReject] = others;
    check(
      'there are suggestions to answer each way',
      Boolean(toAccept && toEdit && toSkip && toReject),
    );
    const answers = await Promise.all([
      me.req('POST', `/api/recommendations/${toAccept!.id}/decision`, {
        decision: 'ACCEPTED',
        expectedStatus: 'PRESENTED',
      }),
      me.req('PATCH', `/api/recommendations/${toEdit!.id}`, {
        changes: { title: 'Our own take on the coffee price rise' },
        expectedStatus: 'PRESENTED',
      }),
      me.req('POST', `/api/recommendations/${toSkip!.id}/decision`, {
        decision: 'SKIPPED',
        expectedStatus: 'PRESENTED',
      }),
      me.req('POST', `/api/recommendations/${toReject!.id}/decision`, {
        decision: 'REJECTED',
        note: 'Not our style.',
        expectedStatus: 'PRESENTED',
      }),
    ]);
    check(
      'accept, edit, skip and reject all succeed',
      answers.every((a) => a.status === 200),
      answers.map((a) => a.status).join(','),
    );
    const after = await db.recommendation.findMany({
      where: {
        id: { in: [toAccept!.id, toEdit!.id, toSkip!.id, toReject!.id] },
      },
    });
    const st = (id: string) => after.find((r) => r.id === id)!.status;
    check(
      'statuses: ACCEPTED, EDITED, SKIPPED, REJECTED',
      st(toAccept!.id) === 'ACCEPTED' &&
        st(toEdit!.id) === 'EDITED' &&
        st(toSkip!.id) === 'SKIPPED' &&
        st(toReject!.id) === 'REJECTED',
    );
    const oppStatus = async (id: string) =>
      (await db.opportunity.findUniqueOrThrow({ where: { id } })).status;
    check(
      'their opportunities follow: accepted, accepted, still open, rejected',
      (await oppStatus(toAccept!.opportunityId)) === 'ACCEPTED' &&
        (await oppStatus(toEdit!.opportunityId)) === 'ACCEPTED' &&
        (await oppStatus(toSkip!.opportunityId)) === 'RECOMMENDED' &&
        (await oppStatus(toReject!.opportunityId)) === 'REJECTED',
    );
    const again = await me.req(
      'POST',
      `/api/recommendations/${toAccept!.id}/decision`,
      { decision: 'ACCEPTED' },
    );
    check(
      'pressing Accept twice changes nothing',
      again.status === 200 &&
        (again.json as { changed: boolean }).changed === false,
    );

    // ------------------------------------------------- Recommendation History
    console.log('\n10. Recommendation History');
    const hist = await me.req('GET', '/api/recommendations/history');
    const entries = (
      hist.json as {
        entries: {
          id: string;
          outcome: string;
          decidedAt: string | null;
          decidedBy: string | null;
          opportunity: { id: string };
        }[];
      }
    ).entries;
    const outcomeOf = (id: string) => entries.find((e) => e.id === id)?.outcome;
    check(
      'every answer is in the history, told apart',
      outcomeOf(toAccept!.id) === 'accepted' &&
        outcomeOf(toEdit!.id) === 'edited' &&
        outcomeOf(toSkip!.id) === 'skipped' &&
        outcomeOf(toReject!.id) === 'rejected',
      JSON.stringify(entries.map((e) => e.outcome)),
    );
    check(
      'with timestamps, who decided, and the opportunity it came from',
      entries.every((e) => e.decidedAt && e.decidedBy === 'Dana') &&
        entries.every(
          (e) =>
            recs.find((r) => r.id === e.id)?.opportunityId === e.opportunity.id,
        ),
    );
    const histPage = await me.page('/dashboard/suggestions/history');
    check(
      'the history page shows them',
      histPage.status === 200 &&
        !histPage.broken &&
        histPage.text.includes('Turned down') &&
        histPage.text.includes('Skipped'),
    );
    const rerun = await suggestFromOpportunities(companyId, {
      templatesOnly: true,
    });
    check(
      'history prevents repetition: the skipped one is not suggested again',
      !rerun.created.some((c) => c.opportunityId === toSkip!.opportunityId),
    );

    // --------------------------------------------------- Ready for Sprint 9
    console.log('\n11. Ready for Sprint 9 creation');
    for (const r of [toAccept!, toEdit!]) {
      const h = await me.req('GET', `/api/recommendations/${r.id}/handoff`);
      const body = h.json as {
        handoff: {
          readiness: string;
          recommendationId: string;
          missing: { field: string }[];
        };
        contentRequest: {
          type: string;
          recommendationId: string;
          source: { brief: string };
        } | null;
      };
      check(
        `${r.id === toAccept!.id ? 'accepted' : 'edited'}: the handoff is ready and carries a valid Content Studio request`,
        h.status === 200 &&
          body.handoff.readiness !== 'blocked' &&
          body.handoff.recommendationId === r.id &&
          body.contentRequest?.recommendationId === r.id &&
          (body.contentRequest?.source.brief.length ?? 0) > 50,
        `${body.handoff?.readiness} · missing ${body.handoff?.missing.map((m) => m.field).join(',')}`,
      );
    }
    const skippedHandoff = await me.req(
      'GET',
      `/api/recommendations/${toSkip!.id}/handoff`,
    );
    check(
      'a skipped one is not handed over',
      (skippedHandoff.json as { handoff: { readiness: string } }).handoff
        .readiness === 'blocked',
    );
    const ctxRes = await me.req(
      'GET',
      `/api/recommendations/${toAccept!.id}/context`,
    );
    const cs = await me.page(
      (ctxRes.json as { context: { primary: { href: string } } }).context
        .primary.href,
    );
    check(
      'opening Content Studio from it: the brief is filled in, with the context panel',
      cs.status === 200 && cs.text.includes('Context from Aura’s suggestion'),
    );

    // ------------------------------------------------------- AI quality (live)
    if (process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY) {
      console.log(
        '\n12. AI quality — one recommendation written by the live model',
      );
      const target = opps.find(
        (o) =>
          ['DETECTED', 'REVIEWED'].includes(o.status) &&
          !recs.some((r) => r.opportunityId === o.id),
      );
      if (target) {
        const g = await generateRecommendation({
          companyId,
          opportunityId: target.id,
          actorId: null,
        });
        const q = g.recommendationId
          ? (await qualityFor(companyId, [g.recommendationId])).get(
              g.recommendationId,
            )
          : null;
        console.log(
          `   model run: ${g.status} · written by ${g.writtenBy} · quality ${q?.verdict ?? 'n/a'}${g.aiRejected ? ' · model text rejected: ' + g.aiRejected.join('; ') : ''}`,
        );
        check(
          'the model’s version passes validation (or is replaced by the template, with the reason)',
          g.status !== 'rejected'
            ? q?.verdict !== 'blocked'
            : g.reasons.length > 0,
          `${g.status} · ${g.writtenBy} · ${q?.verdict ?? ''} ${g.aiRejected?.join('; ') ?? ''}`,
        );
      } else {
        const g = await generateRecommendation({
          companyId,
          opportunityId: toSkip!.opportunityId,
          actorId: null,
        });
        const q = g.recommendationId
          ? (await qualityFor(companyId, [g.recommendationId])).get(
              g.recommendationId,
            )
          : null;
        console.log(
          `   model run: ${g.status} · written by ${g.writtenBy} · quality ${q?.verdict ?? 'n/a'}${g.aiRejected ? ' · model text rejected: ' + g.aiRejected.join('; ') : ''}`,
        );
        check(
          'the model’s version passes validation (or is replaced by the template, with the reason)',
          g.status !== 'rejected'
            ? q?.verdict !== 'blocked'
            : g.reasons.length > 0,
          `${g.status} · ${g.writtenBy} · ${q?.verdict ?? ''} ${g.aiRejected?.join('; ') ?? ''}`,
        );
      }
    } else {
      console.log(
        '\n12. AI quality — skipped (no model key in the environment)',
      );
    }
  } finally {
    await db.company
      .delete({ where: { id: companyId } })
      .catch(() => undefined);
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    check(
      'cleanup: throwaway workspace and user removed',
      (await db.recommendation.count({ where: { companyId } })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nThe whole Sprint 8 flow works end to end.'
      : `\n${failures} check(s) BROKEN.`,
  );
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
