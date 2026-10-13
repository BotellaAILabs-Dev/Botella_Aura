/**
 * Content compliance & policy checks, against the real database and the
 * running app (lib/compliance-policy.ts). The reviewer model is stubbed to
 * score 5/5, so only the rules decide.
 *
 *   Rules       defaults per business; configurable by owners and admins,
 *               validated and audited; the writer is given the same rules
 *   Failing     prohibited words, banned CTAs, missing disclaimers and
 *               misleading claims fail and block submitting
 *   Review      manual-review triggers flag a piece for a person, who must
 *               confirm before approval
 *   Current     a rules change makes reviews out of date; submitting
 *               re-checks under the rules in force
 *   Settings    the page, the tester, read-only for members, reset
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:compliance
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import type { CompliancePolicy } from '@/lib/compliance-policy';
import { REVIEW_DIMENSIONS, type ContentReview } from '@/lib/content-review';
import { loadWritingContext } from '@/server/content/quality.service';
import { reviewDraft } from '@/server/content/review.service';

const BASE = (
  process.env.VERIFY_BASE_URL ??
  process.env.AURA_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-compliance-${STAMP}!`;
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
      email: `zzverify-compliance-${label}-${STAMP}@example.test`,
      name: `Dana ${label}`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      emailVerified: new Date(),
    },
  });
}

const scores = REVIEW_DIMENSIONS.map((d) => ({
  dimension: d,
  score: 5,
  reason: `${d} fine`,
}));
const PASS = { dimensions: scores, issues: [], summary: 'Ready.' };

/** Stub the reviewer model at the network: it always scores 5/5, so only the rules decide. */
async function withPassingReviewer<T>(run: () => Promise<T>): Promise<T> {
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
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: JSON.stringify(PASS) }] },
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

const reviewOf = (d: { aiMetadata: unknown }) =>
  (d.aiMetadata as { review?: ContentReview }).review;

async function main() {
  const owner = await person('owner');
  const member = await person('member');
  const company = await db.company.create({
    data: {
      name: 'zzverify compliance Oak & Barrel',
      slug: `zzverify-compliance-${STAMP}`,
      industry: 'Liquor store',
      website: 'https://www.oakbarrel.example',
      preferences: {
        business: {
          description:
            'Independent bottle shop selling small-producer bourbon, rye and natural wine, with Friday tastings. New small-batch rye from $29.',
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
  await db.competitorProfile.create({
    data: { companyId, name: 'Big Box Liquor' },
  });

  const draft = (caption: string, cta = '') =>
    db.contentDraft.create({
      data: {
        companyId,
        createdById: owner.id,
        type: 'IMAGE_POST',
        platform: 'INSTAGRAM',
        status: 'DRAFT',
        title: caption.slice(0, 40),
        body: {
          caption,
          cta,
          hashtags: ['bourbon', 'rye', 'tasting'],
          altText: '',
        },
        aiMetadata: { source: { kind: 'BRIEF', brief: 'Friday rye tasting' } },
      },
    });
  const load = async (id: string) =>
    (await db.contentDraft.findUnique({ where: { id } }))!;

  try {
    const ownerC = new Client();
    await ownerC.signIn(owner.email);
    const memberC = new Client();
    await memberC.signIn(member.email);

    // ------------------------------------------------------------ The rules
    console.log(
      '\n1. Compliance requirements are defined, with sensible defaults',
    );
    const g = await ownerC.req('GET', '/api/company/compliance');
    const defaults = g.json?.policy as CompliancePolicy | undefined;
    check(
      'a liquor store starts with the alcohol pack, a promotion disclaimer and the responsible-drinking line',
      g.status === 200 &&
        g.json?.alcohol === true &&
        g.json?.customised === false &&
        defaults?.packs.alcohol === 'auto' &&
        (defaults?.disclaimers.map((d) => d.text).join('|') ?? '') ===
          'Terms apply.|Please enjoy responsibly.',
      JSON.stringify(g.json).slice(0, 300),
    );

    console.log('\n2. Rules are configurable — by owners and admins');
    const custom: CompliancePolicy = {
      ...defaults!,
      prohibited: [
        {
          id: 'cheapest',
          phrase: 'cheapest',
          severity: 'block',
          reason: 'we compete on curation, not price',
        },
      ],
      manualReview: { ...defaults!.manualReview, prices: true },
      cta: {
        bannedPhrases: ['DM us'],
        allowedLinkDomains: [],
        requiredFor: ['IMAGE_POST'],
      },
    };
    const denied = await memberC.req('PUT', '/api/company/compliance', custom);
    const invalid = await ownerC.req('PUT', '/api/company/compliance', {
      ...custom,
      prohibited: [{ id: 'x', phrase: 'a' }],
    });
    const saved = await ownerC.req('PUT', '/api/company/compliance', custom);
    const audit = await db.auditLog.findFirst({
      where: { companyId, action: 'COMPANY_UPDATED' },
      orderBy: { createdAt: 'desc' },
    });
    check(
      'a member cannot change them (403); an invalid rule is refused (422); the owner saves (200, audited)',
      denied.status === 403 &&
        invalid.status === 422 &&
        saved.status === 200 &&
        saved.json?.customised === true &&
        (audit?.metadata as { section?: string } | null)?.section ===
          'compliancePolicy',
      `${denied.status} ${invalid.status} ${saved.status}`,
    );
    const w = await loadWritingContext(companyId);
    check(
      'the writer is given the same rules — not hardcoded in the prompt',
      w.system.includes('COMPLIANCE RULES FOR THIS BUSINESS') &&
        w.system.includes('“cheapest”') &&
        w.system.includes('“DM us”') &&
        w.system.includes('"Please enjoy responsibly."') &&
        w.system.includes('"Terms apply."'),
    );

    // ------------------------------------------------------------ Failing
    console.log('\n3. Failed checks stop content being marked ready');
    const bad = await draft(
      'The cheapest rye in town, 20% off this Friday. Risk-free: love it or swap it.',
      'DM us to book.',
    );
    const badReview = await withPassingReviewer(
      async () => (await reviewDraft(bad, { trigger: 'generated' })).review,
    );
    const badIds = (badReview.compliance?.findings ?? []).map((f) => f.ruleId);
    check(
      'prohibited words, a banned CTA, missing disclaimers and a misleading claim all fail — even with the reviewer at 5/5',
      badReview.status === 'fail' &&
        badReview.compliance?.status === 'fail' &&
        [
          'workspace.prohibited.cheapest',
          'workspace.cta.banned.dm-us',
          'workspace.disclaimer.promo-terms',
          'workspace.disclaimer.responsible-drinking',
          'general.risk-free',
        ].every((id) => badIds.includes(id)) &&
        badReview.failed.includes('compliance') &&
        badReview.failed.includes('cta'),
      `${badReview.status} ${badIds.join(',')} failed=${badReview.failed.join(',')}`,
    );
    const submitBad = await ownerC.req(
      'POST',
      `/api/content/drafts/${bad.id}/status`,
      {
        action: 'submit',
      },
    );
    check(
      'submitting is refused (409) and it stays a draft',
      submitBad.status === 409 &&
        /review failed/.test(String(submitBad.json?.error)) &&
        (await load(bad.id)).status === 'DRAFT',
      `${submitBad.status} ${submitBad.json?.error}`,
    );
    const page = await ownerC.page(`/dashboard/content/${bad.id}`);
    check(
      'the draft page shows the compliance findings and links to the rules',
      page.text.includes('Compliance:') &&
        page.text.includes(
          'Uses “cheapest” — we compete on curation, not price',
        ) &&
        page.text.includes(
          'Missing the required disclaimer “Please enjoy responsibly.”',
        ) &&
        page.text.includes('Compliance rules'),
    );

    // ------------------------------------------------------- Manual review
    console.log('\n4. Content requiring additional review is flagged');
    const flagged = await draft(
      'New small-batch rye from $29 — a different pour from Big Box Liquor. Please enjoy responsibly.',
      'Come taste it Friday.',
    );
    const fr = await withPassingReviewer(
      async () => (await reviewDraft(flagged, { trigger: 'generated' })).review,
    );
    const frIds = (fr.compliance?.findings ?? []).map((f) => f.ruleId);
    check(
      'naming a competitor and a price (workspace triggers) need a person — not a failure',
      fr.status === 'review_required' &&
        fr.compliance?.status === 'review' &&
        frIds.includes('workspace.review.competitor') &&
        frIds.includes('workspace.review.price') &&
        fr.failed.length === 0,
      `${fr.status} ${frIds.join(',')} failed=${fr.failed.join(',')}`,
    );
    const sub = await ownerC.req(
      'POST',
      `/api/content/drafts/${flagged.id}/status`,
      { action: 'submit' },
    );
    const noAck = await ownerC.req(
      'POST',
      `/api/content/drafts/${flagged.id}/status`,
      {
        action: 'approve',
        factsReviewed: true,
      },
    );
    const ack = await ownerC.req(
      'POST',
      `/api/content/drafts/${flagged.id}/status`,
      {
        action: 'approve',
        factsReviewed: true,
        reviewAcknowledged: true,
      },
    );
    check(
      'it can be submitted, but is only approved once a person confirms they checked it',
      sub.status === 200 &&
        noAck.status === 409 &&
        ack.status === 200 &&
        (await load(flagged.id)).status === 'APPROVED',
      `${sub.status} ${noAck.status} ${ack.status} ${noAck.json?.error}`,
    );

    // ------------------------------------------------------ Policy changes
    console.log('\n5. Checks run before approval under the rules in force');
    const clean = await draft(
      'Something new on the shelf. Please enjoy responsibly.',
      'Come taste it.',
    );
    const cr = await withPassingReviewer(
      async () => (await reviewDraft(clean, { trigger: 'generated' })).review,
    );
    check(
      'a clean piece passes compliance',
      cr.compliance?.status === 'pass',
      JSON.stringify(cr.compliance?.findings),
    );
    const tightened = await ownerC.req('PUT', '/api/company/compliance', {
      ...custom,
      prohibited: [
        ...custom.prohibited,
        {
          id: 'shelf',
          phrase: 'on the shelf',
          severity: 'block',
          reason: 'say “in store”',
        },
      ],
    });
    const stalePage = await ownerC.page(`/dashboard/content/${clean.id}`);
    const submitClean = await ownerC.req(
      'POST',
      `/api/content/drafts/${clean.id}/status`,
      { action: 'submit' },
    );
    const after = reviewOf(await load(clean.id));
    check(
      'after the rules change its review is out of date; submitting re-checks under the new rules and blocks it',
      tightened.status === 200 &&
        stalePage.text.includes('Out of date') &&
        submitClean.status === 409 &&
        after?.policyHash === tightened.json?.hash &&
        (after?.compliance?.findings ?? []).some(
          (f) => f.ruleId === 'workspace.prohibited.shelf',
        ),
      `${submitClean.status} ${after?.policyHash} vs ${tightened.json?.hash}`,
    );

    // ------------------------------------------------------- Settings page
    console.log('\n6. Settings → Compliance');
    const tested = await ownerC.req('POST', '/api/company/compliance', {
      action: 'test',
      type: 'IMAGE_POST',
      platform: 'INSTAGRAM',
      text: 'Giveaway! Win a bottle of rye. Terms apply. Please enjoy responsibly.',
    });
    const testIds = (
      (tested.json?.report?.findings ?? []) as { ruleId: string }[]
    ).map((f) => f.ruleId);
    check(
      'the tester checks copy without storing it — an Instagram giveaway needs the Meta wording',
      tested.status === 200 &&
        testIds.includes('channel.meta-giveaway-release') &&
        testIds.includes('workspace.review.giveaway'),
      testIds.join(','),
    );
    const sp = await ownerC.page('/dashboard/settings/compliance');
    const mp = await memberC.page('/dashboard/settings/compliance');
    const idx = await ownerC.page('/dashboard/settings');
    check(
      'the page shows every section to the owner; a member sees it read-only; Settings links to it',
      sp.status === 200 &&
        [
          'Built-in rule packs',
          'Words and claims you never use',
          'Required disclaimers',
          'Always send to a person',
          'Calls to action and links',
          'Try the rules',
          'Save rules',
        ].every((t) => sp.text.includes(t)) &&
        mp.text.includes('Only owners and admins can change these rules') &&
        !mp.text.includes('Save rules') &&
        idx.text.includes('Set your rules'),
    );
    const reset = await ownerC.req('POST', '/api/company/compliance', {
      action: 'reset',
    });
    check(
      'reset returns to the defaults',
      reset.status === 200 &&
        (reset.json?.policy?.prohibited?.length ?? -1) === 0 &&
        reset.json?.policy?.cta?.bannedPhrases?.length === 0,
    );
  } finally {
    await db.company
      .delete({ where: { id: companyId } })
      .catch(() => undefined);
    for (const u of [owner, member]) {
      await db.user.delete({ where: { id: u.id } }).catch(() => undefined);
    }
    console.log('  ok      cleanup: throwaway workspace and users removed');
  }

  console.log(
    failures
      ? `\n${failures} compliance check(s) failed.`
      : '\nContent compliance & policy checks work end to end.',
  );
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
