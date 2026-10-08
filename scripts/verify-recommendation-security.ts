/**
 * Recommendation Security & RLS — proven over HTTP against the running app.
 *
 * Two businesses. A has an owner, a member and a viewer; B has an owner and a
 * recommendation whose text carries a secret marker, with history. Then:
 *
 *   · signed out            every recommendation endpoint → 401
 *   · A reads B             every per-id endpoint (detail, context, handoff,
 *                           quality, history) → 404, no secret in any body;
 *                           every list (suggestions, surface, history,
 *                           readiness, pages) shows none of B
 *   · A changes B           decide, set status, edit, snooze, present,
 *                           recommend B's opportunity → refused; B unchanged
 *   · forged workspace      a cookie naming B is ignored
 *   · A's own roles         viewer reads but cannot change anything; member
 *                           may record views but not decide; owner may decide
 *   · history               A's history excludes B; B's owner sees B's
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:recommendation-security
 */
import bcrypt from 'bcryptjs';

import { db } from '@/lib/db';
import { ACTIVE_COMPANY_COOKIE } from '@/lib/cookies';
import { recordOpportunity } from '@/server/opportunities/opportunity.service';
import {
  createRecommendationFromOpportunity,
  decideRecommendation,
} from '@/server/recommendations/recommendation.service';

const BASE = (
  process.env.VERIFY_BASE_URL ??
  process.env.AURA_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-recsec-${STAMP}!`;
const SECRET = `SECRET-B-${STAMP}`;

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
  constructor(readonly name: string) {}
  setCookie(name: string, value: string) {
    this.jar.set(name, value);
  }
  private cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  private keep(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      this.jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
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
      /* not JSON */
    }
    return { status: res.status, json, text };
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

type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

async function seed(
  tag: string,
  members: [string, Role][],
  secret: string | null,
) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const company = await db.company.create({
    data: {
      name: `zzverify recsec ${tag}`,
      slug: `zzverify-recsec-${tag.toLowerCase()}-${STAMP}`,
      preferences: {
        business: { description: `Roasts coffee. ${secret ?? ''}` },
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'Home brewers',
          channels: ['LinkedIn'],
        },
      },
    },
  });
  const users: Record<string, { id: string; email: string }> = {};
  for (const [who, role] of members) {
    const email = `zzverify-recsec-${who.toLowerCase()}-${STAMP}@example.test`;
    const u = await db.user.create({
      data: {
        email,
        name: `zz ${who}`,
        passwordHash,
        emailVerified: new Date(),
      },
    });
    await db.companyMember.create({
      data: { userId: u.id, companyId: company.id, role },
    });
    users[who] = { id: u.id, email };
  }
  const { opportunity } = await recordOpportunity(company.id, {
    type: 'COMPETITOR_MOVE',
    title: `Respond to a rival ${secret ?? tag}`,
    summary: `A rival moved. ${secret ?? ''}`,
    rationale: 'A price move buyers will notice.',
    source: 'COMPETITORS',
    detectedBy: 'rule:competitor-move',
    signals: [
      {
        kind: 'COMPETITOR_SNAPSHOT',
        refId: `zz-${tag}-${STAMP}`,
        label: `Rival cut prices ${secret ?? ''}`,
        detail: 'Cut 20%.',
      },
    ],
    impact: 'high',
    effort: 'low',
    dedupeKey: `zz:recsec:${tag}:${STAMP}`,
    contextFields: [],
  });
  const rec = await createRecommendationFromOpportunity({
    companyId: company.id,
    opportunityId: opportunity.id,
    createdBy: 'engine',
    actorId: null,
    content: secret ? { title: `Answer the rival — ${secret}` } : undefined,
  } as never);
  if (secret)
    await db.recommendation.update({
      where: { id: rec.id },
      data: { title: `Answer the rival — ${secret}` },
    });
  return { company, users, opportunity, rec };
}

async function main() {
  const A = await seed(
    'A',
    [
      ['ownerA', 'OWNER'],
      ['memberA', 'MEMBER'],
      ['viewerA', 'VIEWER'],
    ],
    null,
  );
  const B = await seed('B', [['ownerB', 'OWNER']], SECRET);
  // B's recommendation has a history: shown, then accepted by B's owner.
  await decideRecommendation({
    companyId: B.company.id,
    recommendationId: B.rec.id,
    decision: 'ACCEPTED',
    actorId: B.users.ownerB!.id,
    note: `Approved ${SECRET}`,
  });
  // A second, still-open recommendation in B for write attempts.
  const { opportunity: bOpp2 } = await recordOpportunity(B.company.id, {
    type: 'COMPETITOR_MOVE',
    title: `Another rival move ${SECRET}`,
    summary: 'Moved again.',
    rationale: 'Worth answering.',
    source: 'COMPETITORS',
    detectedBy: 'rule:competitor-move',
    signals: [
      {
        kind: 'COMPETITOR_SNAPSHOT',
        refId: `zz-B2-${STAMP}`,
        label: 'Rival moved',
        detail: 'Again.',
      },
    ],
    impact: 'high',
    effort: 'low',
    dedupeKey: `zz:recsec:B2:${STAMP}`,
    contextFields: [],
  });
  const bOpen = await createRecommendationFromOpportunity({
    companyId: B.company.id,
    opportunityId: bOpp2.id,
    createdBy: 'engine',
    actorId: null,
  });
  const bOpenBefore = await db.recommendation.findUniqueOrThrow({
    where: { id: bOpen.id },
  });
  const bEventsBefore = await db.recommendationEvent.count({
    where: { recommendation: { companyId: B.company.id } },
  });
  const bRecsBefore = await db.recommendation.count({
    where: { companyId: B.company.id },
  });

  const anon = new Client('anonymous');
  const ownerA = new Client('ownerA');
  const memberA = new Client('memberA');
  const viewerA = new Client('viewerA');
  const ownerB = new Client('ownerB');

  try {
    check(
      'everyone signs in',
      (await ownerA.signIn(A.users.ownerA!.email)) === A.users.ownerA!.email &&
        (await memberA.signIn(A.users.memberA!.email)) ===
          A.users.memberA!.email &&
        (await viewerA.signIn(A.users.viewerA!.email)) ===
          A.users.viewerA!.email &&
        (await ownerB.signIn(B.users.ownerB!.email)) === B.users.ownerB!.email,
    );

    const perId = (id: string) => [
      `/api/recommendations/${id}`,
      `/api/recommendations/${id}/context`,
      `/api/recommendations/${id}/handoff`,
      `/api/recommendations/${id}/quality`,
      `/api/recommendations/${id}/history`,
    ];
    const lists = [
      '/api/recommendations',
      '/api/recommendations/surface',
      '/api/recommendations/history',
      '/api/recommendations/readiness',
    ];
    const writes = (id: string, opp: string): [string, string, unknown][] => [
      ['POST', `/api/recommendations/${id}/decision`, { decision: 'ACCEPTED' }],
      ['POST', `/api/recommendations/${id}/status`, { status: 'SKIPPED' }],
      [
        'PATCH',
        `/api/recommendations/${id}`,
        { changes: { title: 'Hijacked title' } },
      ],
      ['POST', `/api/recommendations/${id}/snooze`, { days: 7 }],
      ['POST', `/api/opportunities/${opp}/recommendations`, {}],
    ];

    console.log('\nSigned out');
    const anonResults = await Promise.all([
      ...[...perId(B.rec.id), ...lists].map((p) => anon.req('GET', p)),
      ...writes(B.rec.id, B.opportunity.id).map(([m, p, b]) =>
        anon.req(m, p, b),
      ),
      anon.req('POST', '/api/recommendations/presented', { ids: [B.rec.id] }),
      anon.req('POST', '/api/recommendations/generate'),
    ]);
    check(
      'every recommendation endpoint answers 401, revealing nothing',
      anonResults.every((r) => r.status === 401 && !r.text.includes(SECRET)),
      anonResults.map((r) => r.status).join(','),
    );

    console.log('\nBusiness A reading business B');
    const reads = await Promise.all(
      perId(B.rec.id).map((p) => ownerA.req('GET', p)),
    );
    check(
      'detail, context, handoff, quality and history of B’s recommendation → 404',
      reads.every((r) => r.status === 404),
      reads.map((r) => r.status).join(','),
    );
    check(
      'and no response contains anything of B',
      reads.every(
        (r) => !r.text.includes(SECRET) && !r.text.includes(B.company.id),
      ),
    );
    const listed = await Promise.all(lists.map((p) => ownerA.req('GET', p)));
    check(
      'A’s lists (recommendations, ranking, history, readiness) contain none of B',
      listed.every(
        (r) =>
          r.status === 200 &&
          !r.text.includes(SECRET) &&
          !r.text.includes(B.rec.id) &&
          !r.text.includes(bOpen.id),
      ),
      listed.map((r) => r.status).join(','),
    );
    const oppReads = await Promise.all([
      ownerA.req(
        'GET',
        `/api/opportunities/${B.opportunity.id}/recommendations`,
      ),
      ownerA.req('GET', `/api/opportunities/${B.opportunity.id}/handoff`),
    ]);
    check(
      'B’s opportunity → its recommendations and hand-off → 404',
      oppReads.every((r) => r.status === 404 && !r.text.includes(SECRET)),
      oppReads.map((r) => r.status).join(','),
    );
    const pages = await Promise.all(
      [
        '/dashboard',
        '/dashboard/suggestions',
        '/dashboard/suggestions/history',
      ].map((p) => ownerA.req('GET', p)),
    );
    check(
      'A’s pages (Home, Aura Suggests, history) show none of B',
      pages.every((r) => r.status === 200 && !r.text.includes(SECRET)),
      pages.map((r) => r.status).join(','),
    );

    console.log('\nBusiness A changing business B');
    const attempts = await Promise.all(
      writes(bOpen.id, bOpp2.id).map(([m, p, b]) => ownerA.req(m, p, b)),
    );
    check(
      'decide, set status, edit, snooze, recommend B’s opportunity → all refused (404)',
      attempts.every((r) => r.status === 404),
      attempts.map((r) => r.status).join(','),
    );
    const pres = await ownerA.req('POST', '/api/recommendations/presented', {
      ids: [bOpen.id],
    });
    check(
      'marking B’s recommendation as shown does nothing',
      pres.status === 200 &&
        (pres.json as { presented: string[] }).presented.length === 0 &&
        !(
          pres.json as { alreadyPresented: string[] }
        ).alreadyPresented.includes(bOpen.id),
      JSON.stringify(pres.json),
    );
    const bOpenAfter = await db.recommendation.findUniqueOrThrow({
      where: { id: bOpen.id },
    });
    check(
      'B’s recommendation is exactly as it was',
      bOpenAfter.status === bOpenBefore.status &&
        bOpenAfter.title === bOpenBefore.title &&
        bOpenAfter.snoozeCount === bOpenBefore.snoozeCount &&
        bOpenAfter.updatedAt.getTime() === bOpenBefore.updatedAt.getTime(),
    );
    check(
      'no history was added to B, and nothing was created in B',
      (await db.recommendationEvent.count({
        where: { recommendation: { companyId: B.company.id } },
      })) === bEventsBefore &&
        (await db.recommendation.count({
          where: { companyId: B.company.id },
        })) === bRecsBefore,
    );

    console.log('\nA forged workspace cookie');
    ownerA.setCookie(ACTIVE_COMPANY_COOKIE, B.company.id);
    const forged = await Promise.all([
      ownerA.req('GET', '/api/recommendations'),
      ownerA.req('GET', '/api/recommendations/history'),
      ownerA.req('GET', `/api/recommendations/${B.rec.id}`),
      ownerA.req('POST', `/api/recommendations/${bOpen.id}/decision`, {
        decision: 'REJECTED',
      }),
    ]);
    check(
      'a cookie naming B is ignored: still A’s data, B still 404',
      forged[0]!.status === 200 &&
        !forged[0]!.text.includes(SECRET) &&
        !forged[1]!.text.includes(SECRET) &&
        forged[2]!.status === 404 &&
        forged[3]!.status === 404,
      forged.map((r) => r.status).join(','),
    );

    console.log('\nRoles inside business A');
    const viewerRead = await viewerA.req(
      'GET',
      `/api/recommendations/${A.rec.id}`,
    );
    check(
      'a viewer can read the workspace’s recommendation',
      viewerRead.status === 200,
    );
    const viewerWrites = await Promise.all([
      ...writes(A.rec.id, A.opportunity.id).map(([m, p, b]) =>
        viewerA.req(m, p, b),
      ),
      viewerA.req('POST', '/api/recommendations/generate'),
    ]);
    check(
      'a viewer cannot decide, set status, edit, snooze, recommend or generate (403)',
      viewerWrites.every((r) => r.status === 403),
      viewerWrites.map((r) => r.status).join(','),
    );
    const viewerPresent = await viewerA.req(
      'POST',
      '/api/recommendations/presented',
      { ids: [A.rec.id] },
    );
    check(
      'a viewer seeing it records nothing',
      viewerPresent.status === 200 &&
        (viewerPresent.json as { recorded?: boolean }).recorded === false,
    );
    const memberWrites = await Promise.all([
      memberA.req('POST', `/api/recommendations/${A.rec.id}/decision`, {
        decision: 'ACCEPTED',
      }),
      memberA.req('PATCH', `/api/recommendations/${A.rec.id}`, {
        changes: { title: 'Member edit' },
      }),
      memberA.req('POST', `/api/recommendations/${A.rec.id}/status`, {
        status: 'SKIPPED',
      }),
    ]);
    check(
      'a member cannot decide, edit or set status (403)',
      memberWrites.every((r) => r.status === 403),
      memberWrites.map((r) => r.status).join(','),
    );
    const aUnchanged = await db.recommendation.findUniqueOrThrow({
      where: { id: A.rec.id },
    });
    check(
      'so A’s recommendation is still undecided and unedited',
      aUnchanged.status === 'GENERATED' && !aUnchanged.title.includes('edit'),
      `${aUnchanged.status} / ${aUnchanged.title}`,
    );
    const memberPresent = await memberA.req(
      'POST',
      '/api/recommendations/presented',
      { ids: [A.rec.id] },
    );
    check(
      'a member may record that they saw it',
      memberPresent.status === 200 &&
        (memberPresent.json as { presented: string[] }).presented.includes(
          A.rec.id,
        ),
      JSON.stringify(memberPresent.json),
    );
    ownerA.setCookie(ACTIVE_COMPANY_COOKIE, A.company.id);
    const ownerDecides = await ownerA.req(
      'POST',
      `/api/recommendations/${A.rec.id}/decision`,
      { decision: 'ACCEPTED' },
    );
    check(
      'the owner can decide (positive control)',
      ownerDecides.status === 200,
      String(ownerDecides.status),
    );

    console.log('\nHistory');
    const aHistory = await ownerA.req('GET', '/api/recommendations/history');
    const ids = (
      (aHistory.json as { entries: { id: string }[] }).entries ?? []
    ).map((e) => e.id);
    check(
      'A’s history has A’s decision and nothing of B',
      ids.includes(A.rec.id) &&
        !ids.includes(B.rec.id) &&
        !aHistory.text.includes(SECRET),
      JSON.stringify(ids),
    );
    const bHistory = await ownerB.req(
      'GET',
      `/api/recommendations/${B.rec.id}/history`,
    );
    check(
      'B’s owner sees B’s own history (including the note)',
      bHistory.status === 200 && bHistory.text.includes(`Approved ${SECRET}`),
      String(bHistory.status),
    );
  } finally {
    for (const c of [A.company.id, B.company.id])
      await db.company.delete({ where: { id: c } }).catch(() => undefined);
    const emails = [...Object.values(A.users), ...Object.values(B.users)].map(
      (u) => u.id,
    );
    await db.user.deleteMany({ where: { id: { in: emails } } });
    check(
      'cleanup: throwaway businesses and users removed',
      (await db.recommendation.count({
        where: { companyId: { in: [A.company.id, B.company.id] } },
      })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll recommendation security checks passed.'
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
