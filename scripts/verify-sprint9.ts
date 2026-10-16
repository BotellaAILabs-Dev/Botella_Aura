/**
 * Sprint 9 end to end, on one real workspace, against the running app — the
 * whole flow, through the real pages and APIs where a person acts:
 *
 *   Business Context → Opportunity → Recommendation → User Accepts →
 *   Content Brief → Context Assembly → Content Generation → Image Generation →
 *   Factual Validation → AI Quality Review → User Review → Edit / Regenerate →
 *   Approve → Ready for Execution
 *
 * plus the version history, the Campaign and Outreach creation handoffs (with
 * execution held), and that the pages render. Where the live model or the
 * image provider is not available, the step says so plainly and the flow
 * continues through the same service calls — nothing is reported as done
 * that was not done.
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:sprint9
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { creationProvenance } from '@/lib/recommendation-creation';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import { runDetection } from '@/server/opportunities/detection.service';
import { suggestFromOpportunities } from '@/server/recommendations/autosuggest.service';
import { getCreation, recordCreation } from '@/server/recommendations/creation.service';
import { collectSignals } from '@/server/signals/signal.service';
import { factCheckDraft } from '@/server/content/fact-check.service';
import { listReadyHandoffs } from '@/server/execution/execution.service';

const BASE = (process.env.VERIFY_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-sprint9-${STAMP}!`;
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

let failures = 0;
const notes: string[] = [];
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function note(raw: string) {
  const text = raw.replace(/\s+/g, ' ').trim();
  notes.push(text);
  console.log(`  note    ${text}`);
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
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: 'manual',
      headers: { Origin: BASE, cookie: this.cookie(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.keep(res);
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* page */
    }
    return { status: res.status, json, text };
  }
  async page(path: string) {
    const r = await this.req('GET', path);
    return { status: r.status, broken: r.text.includes('Something failed while building this view') || r.text.includes('Application error') };
  }
  async signIn(email: string) {
    const csrf = await this.req('GET', '/api/auth/csrf');
    const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: this.cookie() },
      body: new URLSearchParams({ csrfToken: csrf.json.csrfToken, email, password: PASSWORD, json: 'true' }),
    });
    this.keep(res);
    const s = await this.req('GET', '/api/auth/session');
    return s.json?.user?.email as string | undefined;
  }
}

const BODY = {
  hook: 'Coffee prices are climbing — here is how we keep your subscription honest.',
  paragraphs: [
    'Harvests are smaller this year, and green coffee costs more.',
    'We buy directly from the same farms every season, so we know what we pay and why.',
    'Your subscription price stays the same until spring.',
  ],
  cta: 'See this month’s beans.',
  hashtags: ['specialtycoffee'],
};

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const owner = await db.user.create({ data: { email: `zzverify-sprint9-${STAMP}@example.test`, name: 'Dana Sprint9', passwordHash: hash, emailVerified: new Date() } });
  const company = await db.company.create({ data: { name: 'zzverify sprint9 Roastery', slug: `zzverify-sprint9-${STAMP}`, industry: 'Coffee' } });
  await db.companyMember.create({ data: { userId: owner.id, companyId: company.id, role: 'OWNER' } });
  const companyId = company.id;
  const me = new Client();

  try {
    check('a real user signs in to the running app', (await me.signIn(owner.email)) === owner.email);

    // --------------------------------------------------------------- 1
    console.log('\n1. Business Context');
    await db.company.update({
      where: { id: companyId },
      data: {
        website: 'https://roastery.example',
        preferences: {
          business: { description: 'We roast single-origin coffee in small batches and sell subscriptions online.' },
          marketingProfile: { marketMode: 'B2C', audience: 'Home brewers who buy beans online', channels: ['LinkedIn', 'Instagram'], goals: 'Grow coffee subscriptions' },
        } as Prisma.InputJsonObject,
      },
    });
    const ctx = await getBusinessContext(companyId);
    check('the business context is read: what it does, audience, goals, channels', Boolean(ctx?.identity.description && ctx.audience.stated && ctx.objectives.goals));

    // --------------------------------------------------------------- 2
    console.log('\n2. Opportunity');
    const item = (id: string, title: string, url: string) => ({ id, title, url, source: 'news', sourceLabel: 'News', score: 10, publishedAt: ago(2).toISOString(), aiSummary: title, suggestedAngle: '' });
    await db.companyTrendConfig.create({ data: { companyId, keywords: ['specialty coffee'] } });
    await db.trendDigest.create({
      data: {
        companyId,
        date: ago(1),
        payload: {
          items: [item('n1', 'Specialty coffee prices climb as harvests shrink', 'https://a.example/1'), item('n2', 'Why specialty coffee shops win on transparency', 'https://a.example/2')],
          summary: '', recommendations: [], hashtags: [], seasonal: [], competitorMentions: [],
        } as Prisma.InputJsonObject,
      },
    });
    const acme = await db.competitorProfile.create({ data: { companyId, name: 'Acme Coffee' } });
    await db.competitorSnapshot.create({
      data: { competitorId: acme.id, capturedAt: ago(3), changesSummary: { hasChanges: true, pricing: 'Cut subscriptions by 20%', news: [], skipped: [], model: 'x', capturedAt: ago(3).toISOString() } as Prisma.InputJsonObject },
    });
    await collectSignals(companyId);
    await runDetection(companyId);
    const opps = await db.opportunity.findMany({ where: { companyId }, include: { signals: true } });
    check('opportunities are detected from the signals, each with evidence', opps.length >= 2 && opps.every((o) => o.signals.length > 0), `${opps.length}`);

    // --------------------------------------------------------------- 3
    console.log('\n3. Recommendation');
    await suggestFromOpportunities(companyId, { templatesOnly: true });
    const recs = await db.recommendation.findMany({ where: { companyId }, include: { evidence: true }, orderBy: { priorityScore: 'desc' } });
    const rec = recs.find((r) => r.contentType === 'LINKEDIN_POST' && ['CONTENT', 'COMPETITIVE_RESPONSE'].includes(r.type)) ?? recs.find((r) => r.contentType);
    check('Aura writes suggestions; one is a content suggestion with evidence', Boolean(rec && rec.evidence.length > 0), `${recs.length} suggestions`);
    if (!rec) throw new Error('No content suggestion to continue with.');

    // --------------------------------------------------------------- 4
    console.log('\n4. User accepts');
    const accept = await me.req('POST', `/api/recommendations/${rec.id}/decision`, { decision: 'ACCEPTED' });
    check('the owner says yes through the API', accept.status === 200 && (await db.recommendation.findUnique({ where: { id: rec.id } }))?.status === 'ACCEPTED', `HTTP ${accept.status}`);

    // --------------------------------------------------------------- 5
    console.log('\n5. Content Brief');
    const brief = await me.req('GET', `/api/recommendations/${rec.id}/brief`);
    check('a content brief is built from the suggestion', brief.status === 200 && JSON.stringify(brief.json).length > 200, `HTTP ${brief.status}`);

    // --------------------------------------------------------------- 6
    console.log('\n6. Context Assembly');
    const handoff = await me.req('GET', `/api/recommendations/${rec.id}/handoff`);
    const h = handoff.json.handoff ?? handoff.json;
    check(
      'the context handoff carries business, goal, audience, channel, reason, evidence — each with its source',
      handoff.status === 200 && h?.business?.name && h?.reason?.why && Array.isArray(h?.evidence) && h?.readiness !== 'blocked',
      `HTTP ${handoff.status} readiness ${h?.readiness}`,
    );
    const creation = await me.req('POST', `/api/recommendations/${rec.id}/creation`, { module: 'content-studio' });
    check('creation is ready, with a Content Studio request carrying the suggestion', creation.status === 200 && creation.json.contentRequest?.recommendationId === rec.id, `HTTP ${creation.status}`);

    // --------------------------------------------------------------- 7
    console.log('\n7. Content Generation');
    const gen = await me.req('POST', '/api/content/generate', { ...creation.json.contentRequest, variations: 1 });
    let draftId: string | null = gen.status === 201 ? gen.json.id : null;
    if (draftId) console.log('  …written by the live model');
    else {
      note(`live model unavailable for writing (${gen.status}: ${String(gen.json?.error ?? '').slice(0, 80)}) — the draft is created through the same service calls`);
      const c = await getCreation(companyId, rec.id, 'content-studio');
      const d = await db.contentDraft.create({
        data: {
          companyId, createdById: owner.id, type: 'LINKEDIN_POST', platform: 'LINKEDIN', status: 'DRAFT', title: 'Our own take on the coffee price rise', body: BODY,
          aiMetadata: { recommendation: { ...(creationProvenance(c!.handoff) as unknown as Prisma.InputJsonObject), id: rec.id, title: rec.title } } as Prisma.InputJsonObject,
        },
      });
      await recordCreation({ companyId, recommendationId: rec.id, module: 'content-studio', created: { type: 'content-draft', id: d.id, label: d.title }, actorId: owner.id });
      draftId = d.id;
    }
    const draft = await db.contentDraft.findUnique({ where: { id: draftId! } });
    const prov = (draft?.aiMetadata as any)?.recommendation;
    check('the draft keeps the suggestion, its opportunity and its reason', Boolean(prov && (prov.recommendationId ?? prov.id) === rec.id && prov.opportunityId === rec.opportunityId && prov.why));
    check('the suggestion is now in progress', (await db.recommendation.findUnique({ where: { id: rec.id } }))?.status === 'IN_PROGRESS');

    // --------------------------------------------------------------- 8
    console.log('\n8. Image Generation');
    const img = await me.req('POST', `/api/content/drafts/${draftId}/graphics`, {
      prompt: 'A bag of single-origin coffee beans on a wooden counter in morning light, shot on a 50mm lens.',
      variations: 1,
    });
    if (img.status === 200 || img.status === 201 || img.status === 202) {
      const jobId = img.json.jobId as string;
      await me.req('POST', `/api/jobs/${jobId}/run`);
      let job: Record<string, any> = {};
      for (let i = 0; i < 20; i++) {
        job = (await me.req('GET', `/api/jobs/${jobId}`)).json ?? {};
        if (['SUCCEEDED', 'FAILED', 'PARTIAL'].includes(job.status)) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (job.status === 'SUCCEEDED' || job.status === 'PARTIAL') {
        const assets = await db.generatedAsset.findMany({ where: { companyId, contentDraftId: draftId! } });
        check('a graphic is generated and stored for the draft', assets.length > 0, job.status);
        const attach = await me.req('POST', `/api/content/graphics/${assets[0]!.id}/attach`, { draftId, replace: true });
        check('…and attached to the post', attach.status === 200, `HTTP ${attach.status}`);
      } else {
        check('a failed image generation is visible and keeps the draft as it was', job.status === 'FAILED' && Boolean(job.error) && Boolean(await db.contentDraft.findUnique({ where: { id: draftId! } })), JSON.stringify(job).slice(0, 160));
        note(`image provider did not produce an image (${String(job.error ?? '').slice(0, 100)})`);
      }
    } else {
      check('image generation refuses plainly when it cannot run', img.status >= 400 && img.status < 500 && Boolean(img.json.error), `HTTP ${img.status}`);
      note(`image generation not available here (${img.status}: ${String(img.json.error ?? '').slice(0, 100)})`);
    }

    // --------------------------------------------------------------- 9
    console.log('\n9. Factual Validation');
    const fc = await factCheckDraft((await db.contentDraft.findUnique({ where: { id: draftId! } }))!);
    check('every claim is checked against the business and the evidence', ['supported', 'needs_review', 'contradicted', 'no_claims'].includes(fc.status) && Array.isArray(fc.claims), fc.status);

    // --------------------------------------------------------------- 10
    console.log('\n10. AI Quality Review');
    const review = await me.req('POST', `/api/content/drafts/${draftId}/review`);
    const rv = review.json.review ?? review.json;
    check('the AI reviewer scores the draft and says pass / needs a person / fail', review.status === 200 && ['pass', 'review_required', 'fail'].includes(rv?.status), `HTTP ${review.status} ${rv?.status}`);
    if (rv?.status === 'review_required' && /could not|unavailable/i.test(JSON.stringify(rv))) note('the AI reviewer could not run — the draft needs a person’s review instead of passing silently');

    // --------------------------------------------------------------- 11
    console.log('\n11. User Review');
    const item11 = await me.req('GET', `/api/review/content/${draftId}`);
    check('the review screen shows the piece, its review and its approval state', item11.status === 200 && Boolean(item11.json.item), `HTTP ${item11.status}`);
    const pagesOk = await Promise.all([me.page(`/dashboard/content/${draftId}`), me.page(`/dashboard/review`), me.page('/dashboard/suggestions')]);
    check('the draft page, review queue and suggestions render', pagesOk.every((p) => p.status === 200 && !p.broken), pagesOk.map((p) => p.status).join(','));

    // --------------------------------------------------------------- 12
    console.log('\n12. Edit / Regenerate');
    const before = await me.req('GET', `/api/review/content/${draftId}/versions`);
    const saved = await me.req('POST', `/api/review/content/${draftId}`, { action: 'save', edits: { hook: 'Coffee prices are rising. Your subscription price is not.' } });
    check('a person’s edit is saved', saved.status === 200, `HTTP ${saved.status} ${JSON.stringify(saved.json).slice(0, 120)}`);
    const regen = await me.req('POST', `/api/review/content/${draftId}`, { action: 'regenerate', mode: 'fresh' });
    if (regen.status === 200) console.log('  …regenerated by the live model');
    else {
      const still = await db.contentDraft.findUnique({ where: { id: draftId! } });
      check('a failed regeneration keeps the person’s edit and says why', JSON.stringify(still?.body).includes('Your subscription price is not') && Boolean(regen.json.error), `HTTP ${regen.status}`);
      note(`regeneration not available (${regen.status}: ${String(regen.json.error ?? '').slice(0, 80)})`);
    }
    const after = await me.req('GET', `/api/review/content/${draftId}/versions`);
    const nBefore = (before.json.versions ?? before.json.log?.versions ?? []).length;
    const nAfter = (after.json.versions ?? after.json.log?.versions ?? []).length;
    check('each change is a new numbered version in the history', nAfter > nBefore, `${nBefore} → ${nAfter}`);

    // --------------------------------------------------------------- 13
    console.log('\n13. Approve');
    let appr = await me.req('POST', `/api/review/content/${draftId}`, { action: 'approve', confirmed: true });
    if (appr.status === 409 && appr.json.code === 'review_failed') {
      note('the AI reviewer failed the draft — regenerating with its feedback, then approving');
      await me.req('POST', `/api/review/content/${draftId}`, { action: 'regenerate', mode: 'fix_review' });
      appr = await me.req('POST', `/api/review/content/${draftId}`, { action: 'approve', confirmed: true });
    }
    const approved = await db.contentDraft.findUnique({ where: { id: draftId! } });
    check('the owner approves it; the approval record names who, which version and what', approved?.status === 'APPROVED' && Boolean((approved.aiMetadata as any)?.approval?.approved?.hash), `HTTP ${appr.status} ${JSON.stringify(appr.json).slice(0, 160)}`);
    const twice = await me.req('POST', `/api/review/content/${draftId}`, { action: 'approve', confirmed: true });
    check('approving twice is refused, not repeated', twice.status === 409, `HTTP ${twice.status}`);

    // --------------------------------------------------------------- 14
    console.log('\n14. Ready for Execution');
    const ex1 = await me.req('GET', `/api/content/drafts/${draftId}/execution`);
    check(
      'no LinkedIn connected: the handoff is BLOCKED and says so — never a silent failure',
      ex1.status === 200 && ex1.json.status === 'blocked' && ex1.json.handoff?.readiness?.issues?.some((i: any) => i.code === 'missing_connection'),
      `${ex1.status} ${ex1.json.status}`,
    );
    await db.linkedInConnection.create({
      data: { companyId, connectedAt: new Date(), linkedInUserId: 'li_verify', displayName: 'Dana Sprint9', accessTokenEnc: encrypt('NOT_A_REAL_TOKEN'), scope: 'openid profile email w_member_social', expiresAt: new Date(Date.now() + 30 * DAY), status: 'ACTIVE' },
    });
    const ex2 = await me.req('GET', `/api/content/drafts/${draftId}/execution`);
    const ho = ex2.json.handoff;
    check('connected: READY FOR EXECUTION, with the full execution package', ex2.json.status === 'ready' && ho?.recommendationId === rec.id && ho?.opportunityId === rec.opportunityId && ho?.approval?.hash && ho?.account?.label === 'Dana Sprint9', `${ex2.json.status} ${JSON.stringify(ho?.readiness)}`);
    check('the package carries no token', !JSON.stringify(ho).includes('NOT_A_REAL_TOKEN'));
    check('Sprint 10 can pick it up from the execution queue', (await listReadyHandoffs({ companyId })).some((r) => r.contentDraftId === draftId));
    check('the handoff is audited', (await db.auditLog.count({ where: { companyId, action: 'EXECUTION_HANDOFF_READY' } })) > 0);

    // --------------------------------------------------------------- Campaign / Outreach handoffs
    console.log('\nCampaign & Outreach creation handoffs');
    // A series suggestion for this workspace (the engine writes one when the
    // signals call for it; made here from the same opportunity so the campaign
    // handoff always runs live).
    const series =
      recs.find((r) => r.type === 'CAMPAIGN' || (r.details as any)?.action === 'series') ??
      (await db.recommendation.create({
        data: {
          companyId, opportunityId: rec.opportunityId, type: 'CAMPAIGN', status: 'ACCEPTED', title: 'Run a four-week honest-pricing series',
          summary: 'A series on why prices move.', action: 'Plan a series of posts explaining coffee prices.', steps: ['Why prices rise', 'How we buy', 'What it means for you'],
          rationale: 'Buyers are comparing prices.', expectedOutcome: 'Subscribers trust the price.', confidence: 'MEDIUM', priority: 'MEDIUM', priorityScore: 60,
          channel: 'LinkedIn', contentType: 'LINKEDIN_POST', details: { action: 'series', angle: 'Honest pricing' } as Prisma.InputJsonObject,
          handoff: {} as Prisma.InputJsonObject, handoffVersion: 1, createdBy: 'verify',
        },
      }));
    {
      const camp = await me.req('POST', '/api/campaigns/orchestrate', { name: 'Coffee price series', goal: 'Grow coffee subscriptions with honest pricing', durationDays: 7, modules: { content: true, outreach: false, engagement: false, discovery: false }, targetAudience: '', themes: [], recommendationId: series.id });
      const saved2 = camp.json.id ? await db.campaign.findUnique({ where: { id: camp.json.id } }) : null;
      check('a campaign planned from a suggestion keeps its context and is held as a plan (execution blocked)', camp.status === 201 && saved2?.status === 'DRAFT' && saved2.creationContext != null, `HTTP ${camp.status} ${saved2?.status}`);
    }
    const outreachPage = await me.page(`/dashboard/outreach/new?rec=${rec.id}`);
    check('the outreach creation page renders for a suggestion (eligible or plainly not)', outreachPage.status === 200 && !outreachPage.broken, String(outreachPage.status));
  } finally {
    await db.auditLog.deleteMany({ where: { OR: [{ companyId }, { userId: owner.id }] } });
    await db.company.delete({ where: { id: companyId } });
    await db.user.delete({ where: { id: owner.id } });
    console.log('\n  ok      cleanup: throwaway user, workspace and everything in it removed');
    await db.$disconnect();
  }
  if (notes.length) console.log(`\nNot exercised live here:\n${notes.map((n) => `  - ${n}`).join('\n')}`);
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll Sprint 9 end-to-end checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
