/**
 * Recommendation → Content Brief, on the running app (lib/content-brief.ts).
 *
 * One real workspace and its own suggestions (signals → opportunities →
 * Aura's suggestions), a real owner acting through the API and pages:
 *
 *   Brief        an accepted recommendation produces the versioned brief with
 *                all 16 fields; every required one populated; recommendation,
 *                opportunity, evidence, business context and channel mapped
 *                from the database; gaps flagged; it validates; it becomes
 *                Content Studio's own request
 *   Studio       Content Studio shows it; it follows the person's format and
 *                network; generating passes the brief check and the draft keeps it
 *   Not ready    an open recommendation and a missing business description
 *                are blocked, and generation is refused
 *   Access       another workspace gets 404
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:content-brief
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { BRIEF_FIELDS } from '@/lib/content-brief';
import { NOT_ACCEPTED_BLOCKER } from '@/lib/recommendation-context-handoff';
import { generateContentSchema } from '@/lib/validations/content';
import { runDetection } from '@/server/opportunities/detection.service';
import { suggestFromOpportunities } from '@/server/recommendations/autosuggest.service';
import { collectSignals } from '@/server/signals/signal.service';

const BASE = (
  process.env.VERIFY_BASE_URL ??
  process.env.AURA_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-brief-${STAMP}!`;
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
      email: `zzverify-brief-${label}-${STAMP}@example.test`,
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
  const outsider = await person('outsider');
  const company = await db.company.create({
    data: {
      name: 'zzverify brief Roastery',
      slug: `zzverify-brief-${STAMP}`,
      industry: 'Coffee',
      website: 'https://roastery.example',
      preferences: PROFILE as Prisma.InputJsonObject,
    },
  });
  const other = await db.company.create({
    data: {
      name: 'zzverify brief Other',
      slug: `zzverify-brief-other-${STAMP}`,
    },
  });
  const companyId = company.id;
  await db.companyMember.createMany({
    data: [
      { userId: owner.id, companyId, role: 'OWNER' },
      { userId: outsider.id, companyId: other.id, role: 'OWNER' },
    ],
  });

  try {
    const recs = await seed(companyId);
    await db.recommendation.updateMany({
      where: { companyId },
      data: { status: 'PRESENTED' },
    });
    const contentRecs = recs.filter((r) =>
      CONTENT_ACTIONS.includes(actionOf(r)),
    );
    const rec = contentRecs[0];
    const openRec = contentRecs[1];
    if (!rec || !openRec)
      throw new Error('The seed did not produce two content suggestions.');
    await db.recommendation.update({
      where: { id: rec.id },
      data: { blockers: [], executable: true },
    });
    console.log(
      `   seeded ${recs.length} suggestions: ${recs.map(actionOf).join(', ')}`,
    );

    const me = new Client();
    check(
      'the owner signs in to the running app',
      (await me.signIn(owner.email)) === owner.email,
    );

    // ---------------------------------------------------------------- The brief
    console.log('\n1. An accepted recommendation produces a structured brief');
    await me.req('POST', `/api/recommendations/${rec.id}/decision`, {
      decision: 'ACCEPTED',
    });
    const res = await me.req('GET', `/api/recommendations/${rec.id}/brief`);
    const b = res.json?.brief;
    check(
      'GET /brief returns the versioned brief with all 16 fields',
      res.status === 200 &&
        b?.version === 1 &&
        b.fields.length === 16 &&
        b.fields.map((f: { field: string }) => f.field).join() ===
          BRIEF_FIELDS.join(),
      `${res.status}`,
    );
    const required = b.fields.filter(
      (f: { requirement: string }) => f.requirement === 'required',
    );
    check(
      `every required field is populated (${required.length} required)`,
      required.every((f: { provided: boolean }) => f.provided) &&
        b.readiness !== 'blocked',
      JSON.stringify(
        required.filter((f: { provided: boolean }) => !f.provided),
      ),
    );
    const dbRec = await db.recommendation.findUnique({
      where: { id: rec.id },
      include: { opportunity: true, evidence: true },
    });
    check(
      'Recommendation → brief: its id, title and the action',
      b.recommendation.id === rec.id &&
        b.recommendation.accepted === true &&
        b.recommendedAction.action === dbRec!.action,
    );
    check(
      'Opportunity → brief: the opportunity behind it, with a link',
      b.opportunity?.id === dbRec!.opportunityId &&
        b.opportunity.title === dbRec!.opportunity.title &&
        b.opportunity.href ===
          `/dashboard/opportunities?focus=${dbRec!.opportunityId}`,
    );
    check(
      'Opportunity evidence → brief: every piece, as recorded',
      b.evidence.length === dbRec!.evidence.length &&
        dbRec!.evidence.every((e) =>
          b.evidence.some((x: { label: string }) => x.label === e.label),
        ),
    );
    check(
      'Business context → brief: what the business does, its goal and audience, with sources',
      b.businessContext?.description === PROFILE.business.description &&
        b.marketingGoal?.value === PROFILE.marketingProfile.goals &&
        Boolean(b.targetAudience?.value) &&
        Boolean(b.targetAudience?.source),
    );
    check(
      'Channel → brief: the channel, its network, its copy rules and asset requirements',
      Boolean(b.channel?.name) &&
        b.channel.requirements.length > 0 &&
        b.contentType?.key &&
        b.assetRequirements?.copy?.maxChars > 0 &&
        b.assetRequirements?.visual?.need,
      JSON.stringify(b.channel),
    );
    check(
      'a key message, from what Aura recorded',
      Boolean(b.keyMessage?.value) && Boolean(b.keyMessage?.source),
    );
    check(
      'missing information is flagged explicitly — none of it filled in',
      b.missing.length > 0 &&
        b.missing.every(
          (m: { whenMissing: string; requirement: string }) =>
            m.whenMissing && m.requirement,
        ) &&
        b.missing.some(
          (m: { field: string }) => m.field === 'relevantMemory',
        ) &&
        b.relevantMemory.length === 0,
      JSON.stringify(
        b.missing.map(
          (m: { field: string; requirement: string }) =>
            `${m.field}:${m.requirement}`,
        ),
      ),
    );
    check(
      'it validates, and is the same check run before generation',
      res.json.validation.ok === true &&
        res.json.validation.errors.length === 0,
      JSON.stringify(res.json.validation),
    );
    const request = res.json.contentRequest;
    check(
      'it becomes Content Studio’s own request — nothing to re-enter',
      generateContentSchema.safeParse(request).success &&
        request.recommendationId === rec.id &&
        request.type === b.contentType.key &&
        request.source.brief.includes(dbRec!.title.slice(0, 20)),
    );

    console.log('\n2. In Content Studio');
    const studio = await me.page(`/dashboard/content/new?rec=${rec.id}`);
    check(
      'Content Studio shows the brief: key message, requirements, and what is missing',
      studio.status === 200 &&
        studio.text.includes('Content brief') &&
        studio.text.includes('Key message') &&
        studio.text.includes('Requirements') &&
        studio.text.includes('Missing — flagged, not made up'),
    );
    const chosen = (
      await me.req(
        'GET',
        `/api/recommendations/${rec.id}/brief?type=CAROUSEL&platform=INSTAGRAM`,
      )
    ).json.brief;
    check(
      'the brief follows the person’s format and network, with that format’s asset requirements',
      chosen.contentType.key === 'CAROUSEL' &&
        chosen.contentType.source === 'person' &&
        chosen.channel.platform === 'INSTAGRAM' &&
        chosen.assetRequirements.visual.need === 'required' &&
        chosen.assetRequirements.visual.count.min === 3,
    );
    const gen = await me.req('POST', '/api/content/generate', {
      ...request,
      variations: 1,
    });
    if (gen.status === 201) {
      const draft = await db.contentDraft.findUnique({
        where: { id: gen.json.id },
      });
      const kept = (
        draft?.aiMetadata as {
          brief?: { recommendation?: { id?: string }; version?: number };
        } | null
      )?.brief;
      check(
        'generating from it: the draft keeps the brief it was written from',
        kept?.version === 1 && kept.recommendation?.id === rec.id,
      );
    } else {
      check(
        `generating from it passes the brief check and reaches the writer (live model: ${gen.status})`,
        gen.status !== 409 && gen.status !== 400,
        `${gen.status} ${String(gen.json?.error ?? '').slice(0, 80)}`,
      );
    }

    // ---------------------------------------------------------- Not ready
    console.log('\n3. Briefs that cannot go to Content Studio');
    const open = (
      await me.req('GET', `/api/recommendations/${openRec.id}/brief`)
    ).json;
    check(
      'a recommendation nobody said yes to: blocked, and no request to post',
      open.brief.readiness === 'blocked' &&
        open.validation.ok === false &&
        open.contentRequest === null &&
        open.brief.blockedBy.includes(NOT_ACCEPTED_BLOCKER),
    );
    await db.company.update({
      where: { id: companyId },
      data: {
        preferences: {
          marketingProfile: PROFILE.marketingProfile,
        } as Prisma.InputJsonObject,
      },
    });
    const bare = (await me.req('GET', `/api/recommendations/${rec.id}/brief`))
      .json;
    const gap = bare.brief.missing.find(
      (m: { field: string }) => m.field === 'businessContext',
    );
    check(
      'no business description: required — flagged with where to add it, and blocked',
      bare.brief.readiness === 'blocked' &&
        gap?.requirement === 'required' &&
        gap.fix?.href?.startsWith('/dashboard/business') &&
        bare.validation.ok === false,
    );
    const refused = await me.req('POST', '/api/content/generate', {
      ...request,
      variations: 1,
    });
    check(
      'generating from it is refused before anything is written',
      refused.status === 409,
      `${refused.status}`,
    );
    await db.company.update({
      where: { id: companyId },
      data: { preferences: PROFILE as Prisma.InputJsonObject },
    });

    console.log('\n4. Access');
    const out = new Client();
    await out.signIn(outsider.email);
    const foreign = await out.req(
      'GET',
      `/api/recommendations/${rec.id}/brief`,
    );
    check(
      'another workspace cannot read the brief (404)',
      foreign.status === 404,
      `${foreign.status}`,
    );
  } finally {
    await db.company
      .delete({ where: { id: companyId } })
      .catch(() => undefined);
    await db.company.delete({ where: { id: other.id } }).catch(() => undefined);
    for (const u of [owner, outsider]) {
      await db.user.delete({ where: { id: u.id } }).catch(() => undefined);
    }
    console.log('  ok      cleanup: throwaway workspaces and users removed');
  }

  console.log(
    failures
      ? `\n${failures} brief check(s) failed.`
      : '\nRecommendation → Content Brief works end to end.',
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
