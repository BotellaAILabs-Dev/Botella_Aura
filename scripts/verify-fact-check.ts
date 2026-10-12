/**
 * Factual validation, against the real database and the running app
 * (lib/fact-check.ts).
 *
 *   Checking   a draft's claims against the business profile, the
 *              recommendation's evidence, the business's documents and the
 *              brief: supported, contradicted, possibly outdated, unsupported
 *   Approval   a contradiction blocks approval; unverifiable claims need the
 *              approver to confirm, which is recorded; a fully supported
 *              piece approves directly; the page shows what needs review
 *   Current    the check follows a change to the business details
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:fact-check
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { updateDraftBody } from '@/server/content/content.service';
import { factCheckDraft } from '@/server/content/fact-check.service';
import { runDetection } from '@/server/opportunities/detection.service';
import { suggestFromOpportunities } from '@/server/recommendations/autosuggest.service';
import { collectSignals } from '@/server/signals/signal.service';

const BASE = (
  process.env.VERIFY_BASE_URL ??
  process.env.AURA_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-facts-${STAMP}!`;
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
      email: `zzverify-facts-${label}-${STAMP}@example.test`,
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

const DAY = 86_400_000;

async function main() {
  const owner = await person('owner');
  const company = await db.company.create({
    data: {
      name: 'zzverify facts Roastery',
      slug: `zzverify-facts-${STAMP}`,
      industry: 'Coffee',
      website: 'https://www.roastery.example',
      preferences: {
        ...PROFILE,
        business: {
          description:
            'We roast single-origin coffee in small batches and sell coffee subscriptions online.',
          offerings: 'Coffee subscriptions; a 250g bag of coffee costs $18.50',
        },
      } as Prisma.InputJsonObject,
    },
  });
  const companyId = company.id;
  await db.companyMember.create({
    data: { userId: owner.id, companyId, role: 'OWNER' },
  });
  const doc = await db.knowledgeChunk.create({
    data: {
      companyId,
      sourceType: 'UPLOAD',
      title: 'Sourcing notes',
      content:
        'We buy green coffee directly from farms in Ethiopia and Colombia.',
    },
  });

  const evidence = [
    {
      label: 'Green coffee prices rose 30% this year',
      detail: 'As harvests shrank across the main origins.',
      url: 'https://news.example/1',
      observedAt: new Date(Date.now() - 10 * DAY).toISOString(),
    },
    {
      label: 'Specialty coffee demand grew 12% in 2023',
      detail: 'Among home brewers.',
      url: null,
      observedAt: new Date(Date.now() - 420 * DAY).toISOString(),
    },
  ];
  const body = {
    hook: 'Why your coffee still costs $18.50 when prices are climbing.',
    paragraphs: [
      'We roast single-origin coffee in small batches.',
      'Green coffee prices rose 15% this year as harvests shrank.',
      'Demand for specialty coffee grew 12% in 2023 among home brewers.',
      'We are the only roaster in town with award-winning beans.',
    ],
    cta: 'Read the breakdown on our site.',
    hashtags: ['coffee'],
  };
  const draft = await db.contentDraft.create({
    data: {
      companyId,
      createdById: owner.id,
      type: 'LINKEDIN_POST',
      platform: 'LINKEDIN',
      status: 'PENDING_APPROVAL',
      title: 'Coffee prices',
      body,
      aiMetadata: {
        source: {
          kind: 'BRIEF',
          brief: 'Explain why our bag stays $18.50 while prices rise.',
        },
        knowledgeChunkIds: [doc.id],
        brief: { evidence },
      } as Prisma.InputJsonObject,
    },
  });

  try {
    // ------------------------------------------------------------- Checking
    console.log('\n1. Content is checked against the trusted context');
    const r = await factCheckDraft(draft);
    const claim = (start: string) =>
      r.claims.find((c) => c.text.startsWith(start));
    check(
      'checked against the business profile, evidence, own documents and the brief',
      ['business_profile', 'evidence', 'knowledge', 'brief'].every((k) =>
        r.checkedAgainst.some((x) => x.kind === k),
      ),
      JSON.stringify(r.checkedAgainst),
    );
    check(
      'a claim the business profile carries is supported',
      claim('We roast')?.status === 'supported',
      claim('We roast')?.reason,
    );
    check(
      'the price, carried by the profile, is supported',
      claim('Why your coffee')?.status === 'supported',
      claim('Why your coffee')?.reason,
    );
    check(
      'a contradiction is identified: 15% where the evidence says 30%',
      claim('Green coffee prices')?.status === 'contradicted' &&
        /30%/.test(claim('Green coffee prices')?.reason ?? ''),
      claim('Green coffee prices')?.reason,
    );
    check(
      'a claim backed only by evidence seen over a year ago is flagged as possibly outdated',
      claim('Demand for specialty')?.status === 'outdated',
      claim('Demand for specialty')?.reason,
    );
    check(
      'an unsupported business claim is flagged',
      claim('We are the only')?.status === 'unsupported',
      claim('We are the only')?.reason,
    );
    check(
      'the call to action is not treated as a claim',
      !claim('Read the breakdown'),
    );

    // ------------------------------------------------------------- Approval
    console.log('\n2. Unsupported claims are never approved as verified');
    const me = new Client();
    check(
      'the owner signs in to the running app',
      (await me.signIn(owner.email)) === owner.email,
    );
    const blocked = await me.req(
      'POST',
      `/api/content/drafts/${draft.id}/status`,
      { action: 'approve' },
    );
    check(
      'a contradiction blocks approval, naming the claim',
      blocked.status === 409 &&
        /contradicts what Aura knows/.test(blocked.json?.error ?? ''),
      `${blocked.status} ${blocked.json?.error}`,
    );
    // Fix the contradiction: the unsupported absolute is next.
    await updateDraftBody({
      companyId,
      userId: owner.id,
      draftId: draft.id,
      body: {
        ...body,
        paragraphs: body.paragraphs.map((p) => p.replace('15%', '30%')),
      },
    });
    await db.contentDraft.update({
      where: { id: draft.id },
      data: { status: 'PENDING_APPROVAL' },
    });
    const absolute = await me.req(
      'POST',
      `/api/content/drafts/${draft.id}/status`,
      {
        action: 'approve',
        factsReviewed: true,
      },
    );
    check(
      'an unsupported absolute (“the only… award-winning”) must be fixed — even with the approver vouching',
      absolute.status === 409 &&
        /Fix before approving/.test(absolute.json?.error ?? '') &&
        /only|award-winning/.test(absolute.json?.error ?? ''),
      `${absolute.status} ${absolute.json?.error}`,
    );
    // Replace it with a plain statement Aura cannot verify — one a person can vouch for.
    await updateDraftBody({
      companyId,
      userId: owner.id,
      draftId: draft.id,
      body: {
        ...body,
        paragraphs: [
          ...body.paragraphs.slice(0, 3).map((p) => p.replace('15%', '30%')),
          'We ship our coffee subscriptions across Europe.',
        ],
      },
    });
    await db.contentDraft.update({
      where: { id: draft.id },
      data: { status: 'PENDING_APPROVAL' },
    });
    const page = await me.page(`/dashboard/content/${draft.id}`);
    check(
      'the person sees the content needs review, and why, claim by claim',
      page.status === 200 &&
        page.text.includes('Fact check') &&
        page.text.includes('Needs fact review') &&
        page.text.includes('Unsupported') &&
        page.text.includes('Possibly outdated') &&
        page.text.includes('I’ve checked the') &&
        !page.text.includes('Fact-checked'),
    );
    const unconfirmed = await me.req(
      'POST',
      `/api/content/drafts/${draft.id}/status`,
      { action: 'approve' },
    );
    check(
      'with the contradiction fixed, unverifiable claims still need the approver to confirm',
      unconfirmed.status === 409 &&
        /could not be verified/.test(unconfirmed.json?.error ?? ''),
      `${unconfirmed.status} ${unconfirmed.json?.error}`,
    );
    const ok = await me.req('POST', `/api/content/drafts/${draft.id}/status`, {
      action: 'approve',
      factsReviewed: true,
    });
    const approved = await db.contentDraft.findUnique({
      where: { id: draft.id },
    });
    const fc = (
      approved?.aiMetadata as {
        factCheck?: {
          status?: string;
          reviewedBy?: string;
          unverified?: unknown[];
        };
      } | null
    )?.factCheck;
    check(
      'confirmed: approved, with who vouched for which claims recorded',
      ok.status === 200 &&
        approved?.status === 'APPROVED' &&
        fc?.status === 'needs_review' &&
        fc.reviewedBy === owner.id &&
        (fc.unverified?.length ?? 0) === 2,
      JSON.stringify(fc),
    );
    const audit = await db.auditLog.findFirst({
      where: { companyId, action: 'CONTENT_APPROVED' },
      orderBy: { createdAt: 'desc' },
    });
    check(
      'and the audit trail says the approver reviewed them',
      (audit?.metadata as { claimsReviewedByApprover?: number } | null)
        ?.claimsReviewedByApprover === 2,
      JSON.stringify(audit?.metadata),
    );

    // A piece whose every claim is supported approves straight away.
    const clean = await db.contentDraft.create({
      data: {
        companyId,
        createdById: owner.id,
        type: 'LINKEDIN_POST',
        platform: 'LINKEDIN',
        status: 'PENDING_APPROVAL',
        title: 'Our coffee',
        body: {
          hook: 'We roast single-origin coffee in small batches.',
          paragraphs: [
            'A 250g bag of coffee costs $18.50.',
            'We buy green coffee directly from farms in Ethiopia and Colombia.',
            'Pour yourself something good.',
          ],
          cta: 'Start your subscription.',
          hashtags: [],
        },
        aiMetadata: { knowledgeChunkIds: [doc.id] } as Prisma.InputJsonObject,
      },
    });
    const cleanReport = await factCheckDraft(clean);
    const direct = await me.req(
      'POST',
      `/api/content/drafts/${clean.id}/status`,
      { action: 'approve' },
    );
    check(
      'content whose claims all check out is “Fact-checked” and approves directly',
      cleanReport.status === 'verified' && direct.status === 200,
      `${cleanReport.status} ${JSON.stringify(cleanReport.claims.map((c) => c.status))} ${direct.status}`,
    );

    // ------------------------------------------------------------- Current
    console.log('\n3. Checked against the current context');
    await db.company.update({
      where: { id: companyId },
      data: {
        preferences: {
          ...PROFILE,
          business: {
            description: 'We roast coffee.',
            offerings: 'Coffee subscriptions',
          },
        } as Prisma.InputJsonObject,
      },
    });
    const again = await factCheckDraft(
      (await db.contentDraft.findUnique({ where: { id: clean.id } }))!,
    );
    check(
      'when the business details change, a price they no longer carry is flagged on the next check',
      again.claims.find((c) => c.text.startsWith('A 250g bag'))?.status ===
        'unsupported',
      JSON.stringify(again.claims.map((c) => [c.text.slice(0, 20), c.status])),
    );
  } finally {
    await db.company
      .delete({ where: { id: companyId } })
      .catch(() => undefined);
    await db.user.delete({ where: { id: owner.id } }).catch(() => undefined);
    console.log('  ok      cleanup: throwaway workspace and user removed');
  }

  console.log(
    failures
      ? `\n${failures} fact-check check(s) failed.`
      : '\nFactual validation works end to end.',
  );
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
