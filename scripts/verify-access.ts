/**
 * Data-access security check: Business Context, signals, opportunities and
 * recommendations are isolated between businesses, and every API enforces
 * workspace membership and role.
 *
 * End to end, over HTTP, against a running app — real sign-ins, real cookies,
 * real route handlers. Creates two throwaway businesses:
 *
 *   A: an OWNER and a VIEWER         B: an OWNER
 *
 * with an opportunity (plus evidence and a recommendation) in each, then
 * tries every cross-business and wrong-role access and checks it is refused
 * without changing anything.
 *
 * Run (with the app running):  AURA_URL=http://localhost:3000 pnpm verify:access
 *
 * Everything it creates is deleted at the end, including on failure.
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { ACTIVE_COMPANY_COOKIE } from '@/lib/cookies';
import { recordOpportunity } from '@/server/opportunities/opportunity.service';
import { createRecommendationFromOpportunity } from '@/server/recommendations/recommendation.service';
import { collectSignals } from '@/server/signals/signal.service';

const BASE = (process.env.AURA_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);
const PASSWORD = `Zz-verify-${Date.now()}!`;

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A signed-in browser: a cookie jar and fetch. */
class Client {
  private jar = new Map<string, string>();
  constructor(readonly name: string) {}

  setCookie(name: string, value: string) {
    this.jar.set(name, value);
  }

  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        Origin: BASE,
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      this.jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
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
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: new URLSearchParams({
        csrfToken: token,
        email,
        password: PASSWORD,
        json: 'true',
      }),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      this.jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
    const session = await this.req('GET', '/api/auth/session');
    return (session.json as { user?: { email?: string } })?.user?.email;
  }
}

const DAY = 86_400_000;

async function seedBusiness(
  tag: string,
  members: [string, 'OWNER' | 'VIEWER'][],
) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const company = await db.company.create({
    data: {
      name: `zzverify access ${tag}`,
      slug: `zzverify-access-${tag.toLowerCase()}-${Date.now()}`,
      industry: `Industry${tag}`,
      preferences: {
        business: { description: `Secret plans of business ${tag}.` },
      },
    },
  });
  const users = [];
  for (const [who, role] of members) {
    const user = await db.user.create({
      data: {
        email: `zzverify-${who.toLowerCase()}-${Date.now()}@example.test`,
        name: `zz ${who}`,
        passwordHash,
        emailVerified: new Date(),
      },
    });
    await db.companyMember.create({
      data: { userId: user.id, companyId: company.id, role },
    });
    users.push(user);
  }
  const competitor = await db.competitorProfile.create({
    data: { companyId: company.id, name: `Rival of ${tag}` },
  });
  await db.competitorSnapshot.create({
    data: {
      competitorId: competitor.id,
      capturedAt: new Date(Date.now() - 2 * DAY),
      changesSummary: {
        hasChanges: true,
        pricing: `Business ${tag}'s rival cut prices`,
        news: [],
        skipped: [],
        model: 'x',
        capturedAt: new Date().toISOString(),
      } as Prisma.InputJsonObject,
    },
  });
  await collectSignals(company.id);
  const signal = await db.signal.findFirstOrThrow({
    where: { companyId: company.id },
  });
  const { opportunity } = await recordOpportunity(company.id, {
    type: 'COMPETITOR_MOVE',
    title: `Opportunity of business ${tag}`,
    summary: `Private to business ${tag}.`,
    source: 'COMPETITORS',
    detectedBy: 'rule:competitor-move',
    signals: [
      {
        kind: signal.kind,
        refId: signal.refId,
        label: signal.title,
        detail: signal.summary,
        signalId: signal.id,
      },
    ],
  });
  return { company, users, signal, opportunity };
}

async function main() {
  const A = await seedBusiness('A', [
    ['ownerA', 'OWNER'],
    ['viewerA', 'VIEWER'],
  ]);
  const B = await seedBusiness('B', [['ownerB', 'OWNER']]);
  const recB = await createRecommendationFromOpportunity({
    companyId: B.company.id,
    opportunityId: B.opportunity.id,
    createdBy: 'verify',
    actorId: null,
  });

  try {
    const ownerA = new Client('ownerA');
    const viewerA = new Client('viewerA');
    const ownerB = new Client('ownerB');
    const anon = new Client('anonymous');
    check(
      'test users can sign in',
      (await ownerA.signIn(A.users[0]!.email)) === A.users[0]!.email &&
        (await viewerA.signIn(A.users[1]!.email)) === A.users[1]!.email &&
        (await ownerB.signIn(B.users[0]!.email)) === B.users[0]!.email,
    );

    const bOpp = B.opportunity.id;
    const bOppBefore = await db.opportunity.findUniqueOrThrow({
      where: { id: bOpp },
    });
    const leaks = (text: string) =>
      [
        B.company.id,
        B.company.name,
        'Secret plans of business B',
        bOpp,
        recB.id,
        B.signal.id,
      ].filter((s) => text.includes(s));

    console.log('\nUsers cannot access another business’s context');
    const ctx = await ownerA.req('GET', '/api/business-context');
    check(
      'own context is returned',
      ctx.status === 200 && ctx.text.includes('Secret plans of business A'),
      String(ctx.status),
    );
    check(
      '…and nothing of business B',
      leaks(ctx.text).length === 0,
      leaks(ctx.text).join(', '),
    );
    // A forged "active company" cookie naming business B.
    ownerA.setCookie(ACTIVE_COMPANY_COOKIE, B.company.id);
    const forged = await ownerA.req('GET', '/api/business-context');
    const forgedSnap = await ownerA.req(
      'GET',
      '/api/business-context/snapshot?view=full',
    );
    const forgedQ = await ownerA.req('GET', '/api/business-context/questions');
    check(
      'a forged workspace cookie still serves only their own business',
      forged.status === 200 &&
        forged.text.includes('Secret plans of business A') &&
        leaks(forged.text + forgedSnap.text + forgedQ.text).length === 0,
    );
    check(
      'snapshot is their own workspace’s',
      (forgedSnap.json as { snapshot?: { companyId?: string } })?.snapshot
        ?.companyId === A.company.id,
    );
    const patchB = await ownerA.req('PATCH', `/api/companies/${B.company.id}`, {
      name: 'Hijacked',
    });
    check(
      'cannot edit business B’s profile (403)',
      patchB.status === 403,
      String(patchB.status),
    );
    const bAfter = await db.company.findUniqueOrThrow({
      where: { id: B.company.id },
    });
    check('…and business B is unchanged', bAfter.name === B.company.name);

    console.log('\nOpportunities, signals and recommendations are isolated');
    const lists = await Promise.all([
      ownerA.req('GET', '/api/opportunities?limit=200'),
      ownerA.req('GET', '/api/signals'),
      ownerA.req('GET', '/api/advisor'),
    ]);
    check(
      'lists contain nothing of business B',
      lists.every((r) => r.status === 200) &&
        leaks(lists.map((r) => r.text).join('')).length === 0,
    );
    check(
      '…but do contain business A’s own opportunity',
      lists[0]!.text.includes(A.opportunity.id),
    );
    for (const [method, path, body] of [
      ['GET', `/api/opportunities/${bOpp}`, undefined],
      ['GET', `/api/opportunities/${bOpp}/handoff`, undefined],
      ['POST', `/api/opportunities/${bOpp}/status`, { status: 'REJECTED' }],
      ['POST', `/api/opportunities/${bOpp}/recommendations`, {}],
      [
        'POST',
        `/api/recommendations/${recB.id}/decision`,
        { decision: 'REJECTED' },
      ],
    ] as const) {
      const r = await ownerA.req(method, path, body);
      check(
        `${method} ${path.replace(bOpp, ':B-opp').replace(recB.id, ':B-rec')} → 404, no detail`,
        r.status === 404 && leaks(r.text).length === 0,
        `${r.status} ${r.text.slice(0, 120)}`,
      );
    }
    const recsOfB = await ownerA.req(
      'GET',
      `/api/opportunities/${bOpp}/recommendations`,
    );
    check(
      'listing business B’s recommendations returns none',
      recsOfB.status === 200 &&
        (recsOfB.json as { recommendations: unknown[] }).recommendations
          .length === 0,
    );
    const bOppAfter = await db.opportunity.findUniqueOrThrow({
      where: { id: bOpp },
    });
    const recBAfter = await db.recommendation.findUniqueOrThrow({
      where: { id: recB.id },
    });
    check(
      'business B’s opportunity and recommendation are unchanged',
      bOppAfter.status === bOppBefore.status &&
        bOppAfter.updatedAt.getTime() === bOppBefore.updatedAt.getTime() &&
        recBAfter.status === 'PROPOSED' &&
        (await db.recommendation.count({ where: { opportunityId: bOpp } })) ===
          1,
    );
    // Pages load data on the server too; same forged cookie still in place.
    const pages = await Promise.all([
      ownerA.req('GET', '/dashboard/opportunities'),
      ownerA.req('GET', `/dashboard/opportunities?focus=${bOpp}`),
      ownerA.req('GET', '/dashboard/business'),
    ]);
    check(
      'pages (Opportunities, About my business) show nothing of business B',
      pages.every((r) => r.status === 200) &&
        pages[0]!.text.includes('Opportunity of business A') &&
        leaks(pages.map((r) => r.text).join('')).filter((s) => s !== bOpp)
          .length === 0 &&
        !pages[1]!.text.includes('Opportunity of business B'),
      pages.map((r) => r.status).join(','),
    );
    const ownB = await ownerB.req('GET', `/api/opportunities/${bOpp}`);
    check('(control) business B’s owner can open it', ownB.status === 200);

    console.log('\nAPIs enforce user permissions (viewer of business A)');
    const aOpp = A.opportunity.id;
    const reads = await Promise.all([
      viewerA.req('GET', '/api/opportunities'),
      viewerA.req('GET', `/api/opportunities/${aOpp}`),
      viewerA.req('GET', '/api/business-context'),
    ]);
    check(
      'can read their own workspace',
      reads.every((r) => r.status === 200),
    );
    for (const [method, path, body] of [
      ['PATCH', '/api/business-context', { changes: {} }],
      [
        'POST',
        '/api/business-context/questions',
        { key: 'x', action: 'not_now' },
      ],
      ['POST', '/api/business-context/snapshot', {}],
      ['POST', `/api/opportunities/${aOpp}/status`, { status: 'REJECTED' }],
      ['POST', `/api/opportunities/${aOpp}/recommendations`, {}],
      ['POST', '/api/opportunities/detect?ai=0', undefined],
      ['POST', '/api/signals/refresh', undefined],
      ['PATCH', '/api/company/audience', {}],
    ] as const) {
      const r = await viewerA.req(method, path, body);
      check(
        `${method} ${path.replace(aOpp, ':opp')} → 403`,
        r.status === 403,
        String(r.status),
      );
    }
    const aOppAfter = await db.opportunity.findUniqueOrThrow({
      where: { id: aOpp },
    });
    check(
      '…and nothing changed',
      aOppAfter.status === 'DETECTED' &&
        (await db.recommendation.count({ where: { opportunityId: aOpp } })) ===
          0,
    );

    console.log('\nNot signed in');
    for (const path of [
      '/api/business-context',
      '/api/business-context/snapshot',
      '/api/opportunities',
      `/api/opportunities/${bOpp}`,
      `/api/opportunities/${bOpp}/handoff`,
      '/api/signals',
    ]) {
      const r = await anon.req('GET', path);
      check(
        `GET ${path.replace(bOpp, ':opp')} → 401`,
        r.status === 401 && leaks(r.text).length === 0,
        String(r.status),
      );
    }
    const anonPost = await anon.req(
      'POST',
      `/api/opportunities/${bOpp}/status`,
      {
        status: 'REJECTED',
      },
    );
    check(
      'POST without a session → 401',
      anonPost.status === 401,
      String(anonPost.status),
    );

    console.log('\nSensitive information');
    const everything = [ctx, ...lists, ...reads].map((r) => r.text).join('\n');
    const secrets = [
      'passwordHash',
      'accessToken',
      'refreshToken',
      'apiKey',
      'clientSecret',
      '$2a$',
      '$2b$',
    ].filter((s) => everything.includes(s));
    check(
      'no credentials or password hashes in any response',
      secrets.length === 0,
      secrets.join(', '),
    );
    const emails = [...A.users, ...B.users]
      .map((u) => u.email)
      .filter((e) => everything.includes(e));
    check(
      'no member email addresses in context or opportunity responses',
      emails.length === 0,
      emails.join(', '),
    );
  } finally {
    const ids = [A.company.id, B.company.id];
    await db.company.deleteMany({ where: { id: { in: ids } } });
    await db.user.deleteMany({
      where: { id: { in: [...A.users, ...B.users].map((u) => u.id) } },
    });
    check(
      'cleanup: throwaway businesses and users removed',
      (await db.company.count({ where: { id: { in: ids } } })) === 0,
    );
  }

  console.log(
    failures === 0
      ? '\nAll access checks passed.'
      : `\n${failures} check(s) BROKEN.`,
  );
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
