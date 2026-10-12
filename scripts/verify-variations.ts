/**
 * Content generation variations, against the real database and the running
 * app (lib/content-variations.ts). The model is stubbed at the network, so
 * each variation's answer — including a changed fact — is controlled.
 *
 *   Requesting  shorter, longer, another tone, alternative CTA and headline,
 *               another channel: each added next to the original, the draft
 *               untouched; the writer told what to keep
 *   Guardrail   a changed fact is sent back and corrected; one that stays is
 *               kept but blocked with the fact named; CTA/headline change one
 *               field only
 *   Review      every version stored with its own check; choosing one moves
 *               the draft (and its network), keeps the left version's edits,
 *               and can be undone; the page shows each version
 *   Image       another image is requested from the visual brief
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:variations
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { briefText } from '@/lib/content-brief';
import type { DraftVersion } from '@/lib/content-variations';
import { getContentBrief } from '@/server/content/content-brief.service';
import { updateDraftBody } from '@/server/content/content.service';
import {
  generateDraft,
  switchVariation,
  undoDraft,
} from '@/server/content/generator';
import {
  createVariation,
  imageVariationRequest,
  VariationError,
} from '@/server/content/variations.service';
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
const PASSWORD = `Zz-variations-${STAMP}!`;
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
      email: `zzverify-variations-${label}-${STAMP}@example.test`,
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

/** The post the draft starts as: facts the variations must keep. */
const POST = {
  hook: 'Coffee prices rose 15% this year — here is why your bag is still $18.50.',
  paragraphs: [
    'Harvests shrank across our origins, so green coffee costs more.',
    'We absorb part of the rise so a 250g bag stays at $18.50.',
    'The full breakdown is at https://www.roastery.example/prices.',
  ],
  cta: 'Read the breakdown on our site.',
  hashtags: ['coffee'],
};

/**
 * Stub the model at the network. `answer` gets the prompt and returns the
 * JSON text; every prompt is recorded.
 */
function stubModel(answer: (prompt: string) => unknown) {
  const sent: string[] = [];
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
    const prompt =
      (
        JSON.parse(String(init?.body ?? '{}')) as {
          contents?: { parts: { text: string }[] }[];
        }
      ).contents?.[0]?.parts[0]?.text ?? '';
    sent.push(prompt);
    const out = answer(prompt);
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
  answer: (prompt: string) => unknown,
  run: () => Promise<T>,
) {
  const s = stubModel(answer);
  try {
    return { result: await run(), sent: s.sent };
  } finally {
    s.restore();
  }
}

const rewrite = (patch: Partial<typeof POST>) => ({ ...POST, ...patch });

async function main() {
  const owner = await person('owner');
  const company = await db.company.create({
    data: {
      name: 'zzverify variations Roastery',
      slug: `zzverify-variations-${STAMP}`,
      industry: 'Coffee',
      website: 'https://www.roastery.example',
      preferences: PROFILE as Prisma.InputJsonObject,
    },
  });
  const companyId = company.id;
  await db.companyMember.create({
    data: { userId: owner.id, companyId, role: 'OWNER' },
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

    const { result: created } = await withStub(
      (p) => (p.includes('"hook": string') ? POST : '{}'),
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
    const draftId = created.id;
    const load = async () =>
      (await db.contentDraft.findUnique({ where: { id: draftId } }))!;
    const versions = async () =>
      ((await load()).aiMetadata as { variations?: DraftVersion[] })
        .variations ?? [];

    // ------------------------------------------------------------- Requesting
    console.log('\n1. Requesting variations — each added next to the original');
    const shorter = await withStub(
      () =>
        rewrite({
          paragraphs: [
            'Harvests shrank, so coffee costs more.',
            'Your bag stays at $18.50.',
            'Details: https://www.roastery.example/prices.',
          ],
        }),
      async () =>
        createVariation({
          draft: await load(),
          userId: owner.id,
          kind: 'shorter',
        }),
    );
    const afterShorter = await load();
    check(
      'a shorter version is added; the draft in use is untouched',
      shorter.result.index === 1 &&
        JSON.stringify(afterShorter.body) === JSON.stringify(created.body) &&
        (await versions())[1]?.angle === 'Shorter',
    );
    const p = shorter.sent[0] ?? '';
    check(
      'the writer is told to keep the goal, audience, evidence, CTA destination, brand and facts',
      p.includes('KEEP EXACTLY') &&
        p.includes(`Goal: ${brief!.marketingGoal?.value}`) &&
        p.includes(`Audience: ${brief!.targetAudience?.value}`) &&
        p.includes('Evidence (the only claims allowed)') &&
        p.includes('https://www.roastery.example') &&
        p.includes('15%') &&
        p.includes('$18.50') &&
        p.includes('Do NOT change, round or invent'),
    );

    // Longer: invents a fact first, corrects it when told.
    const longer = await withStub(
      (prompt) =>
        prompt.includes('CHANGED OR INVENTED')
          ? rewrite({
              paragraphs: [
                ...POST.paragraphs,
                'Every farm we buy from is paid fairly.',
              ],
            })
          : rewrite({
              hook: 'Coffee prices rose 20% this year — here is why your bag is still $18.50.',
            }),
      async () =>
        createVariation({
          draft: await load(),
          userId: owner.id,
          kind: 'longer',
        }),
    );
    check(
      'a longer version that changed 15% to 20% is sent back and corrected — facts are kept',
      longer.result.version.facts?.corrected === true &&
        longer.result.version.facts.introduced.length === 0 &&
        longer.sent.some((x) =>
          x.includes('YOUR LAST VERSION CHANGED OR INVENTED THESE FACTS: 20%'),
        ),
      JSON.stringify(longer.result.version.facts),
    );

    // Tone: keeps inventing a price — kept, but blocked and named.
    const tone = await withStub(
      () =>
        rewrite({
          hook: 'Big news: bags now just $14.99!',
          paragraphs: POST.paragraphs,
        }),
      async () =>
        createVariation({
          draft: await load(),
          userId: owner.id,
          kind: 'tone',
          tone: 'playful',
        }),
    );
    const toneQ = tone.result.version.quality as {
      approvable: boolean;
      issues: { code: string; message: string }[];
    };
    check(
      'a version that still changes a fact is kept for review, blocked from approval, with the fact named',
      tone.result.version.angle === 'Playful tone' &&
        !toneQ.approvable &&
        toneQ.issues.some(
          (i) => i.code === 'facts-changed' && i.message.includes('$14.99'),
        ),
      JSON.stringify(tone.result.version.facts),
    );

    // Alternative CTA and headline: one field only.
    const cta = await withStub(
      () => ({ value: 'See where every penny of your $18.50 goes.' }),
      async () =>
        createVariation({ draft: await load(), userId: owner.id, kind: 'cta' }),
    );
    const ctaBody = cta.result.version.body as typeof POST;
    check(
      'an alternative CTA changes the CTA and nothing else',
      ctaBody.cta === 'See where every penny of your $18.50 goes.' &&
        JSON.stringify({ ...ctaBody, cta: POST.cta }) === JSON.stringify(POST),
    );
    const headline = await withStub(
      () => ({
        value: 'Why your coffee still costs $18.50 when prices rose 15%',
      }),
      async () =>
        createVariation({
          draft: await load(),
          userId: owner.id,
          kind: 'headline',
        }),
    );
    const hBody = headline.result.version.body as typeof POST;
    check(
      'an alternative headline changes the hook and nothing else',
      hBody.hook.startsWith('Why your coffee') &&
        JSON.stringify({ ...hBody, hook: POST.hook }) === JSON.stringify(POST),
    );

    // Channel-specific.
    const fb = await withStub(
      () =>
        rewrite({
          paragraphs: [
            'Harvests shrank, so coffee costs more — but your bag stays $18.50.',
            'We absorb part of the 15% rise.',
            'Details: https://www.roastery.example/prices',
          ],
          hashtags: [],
        }),
      async () =>
        createVariation({
          draft: await load(),
          userId: owner.id,
          kind: 'channel',
          platform: 'FACEBOOK',
        }),
    );
    check(
      'a version for Facebook is written to Facebook’s rules and remembers its network',
      fb.result.version.platform === 'FACEBOOK' &&
        fb.result.version.angle === 'For Facebook' &&
        (fb.sent[0] ?? '').includes('HOW THIS FORMAT WORKS ON FACEBOOK'),
    );

    // Not offered where it makes no sense.
    let refused = '';
    try {
      await createVariation({
        draft: await load(),
        userId: owner.id,
        kind: 'channel',
        platform: 'X',
      });
    } catch (err) {
      refused = err instanceof VariationError ? err.message : String(err);
    }
    check(
      'a channel the format cannot run on is refused, saying why',
      /Pick a channel this format runs on/.test(refused),
      refused,
    );

    // ---------------------------------------------------------------- Review
    console.log('\n2. Each version reviewed separately, and chosen (or not)');
    const all = await versions();
    check(
      `${all.length} versions are kept, each with its kind and its own check`,
      all.length === 7 &&
        all
          .slice(1)
          .every((v) => v.kind && v.createdAt && v.quality && v.facts),
      all.map((v) => v.angle).join(' | '),
    );
    // Hand-edit the version in use, then switch to the Facebook one.
    const edited = await updateDraftBody({
      companyId,
      userId: owner.id,
      draftId,
      body: { ...POST, cta: 'Read the breakdown — edited by hand.' },
    });
    await switchVariation({
      draft: edited,
      userId: owner.id,
      index: fb.result.index,
    });
    const switched = await load();
    const after = await versions();
    check(
      'choosing the Facebook version moves the draft there',
      switched.platform === 'FACEBOOK' &&
        (switched.body as typeof POST).paragraphs[0]!.includes(
          'your bag stays $18.50',
        ),
    );
    check(
      'the version left behind keeps its hand edit, to come back to',
      (after[0]!.body as typeof POST).cta ===
        'Read the breakdown — edited by hand.',
    );
    const undone = await undoDraft({ draft: switched, userId: owner.id });
    check(
      'choosing a version can be undone',
      (undone.body as typeof POST).cta ===
        'Read the breakdown — edited by hand.',
    );

    const page = new Client();
    await page.signIn(owner.email);
    const view = await page.page(`/dashboard/content/${draftId}`);
    check(
      'the draft page offers variations and shows each version to read on its own',
      view.status === 200 &&
        view.text.includes('Make a variation') &&
        view.text.includes('Alternative CTA') &&
        view.text.includes('Read this version') &&
        view.text.includes('Facts kept') &&
        view.text.includes('Changes facts from the original: $14.99'),
    );

    // ------------------------------------------------------------------ Image
    console.log('\n3. Image regeneration');
    const img = await withStub(
      () => ({
        subject: 'A roaster weighing beans',
        prompt:
          'A warm roastery counter with a roaster weighing single-origin beans, brown tones, no text.',
        negativePrompt: 'text',
      }),
      async () => imageVariationRequest(await load()),
    );
    check(
      'another image is requested from the visual brief (no image yet), in its shape',
      img.result.from === 'visual_brief' &&
        img.result.prompt.length >= 20 &&
        Boolean(img.result.aspectRatio),
      JSON.stringify(img.result).slice(0, 160),
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
      ? `\n${failures} variation check(s) failed.`
      : '\nContent variations work end to end.',
  );
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
