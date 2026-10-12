/**
 * Visual / asset generation context, against the real database and the
 * running app (lib/visual-brief.ts).
 *
 *   Requirements  derived from the recommendation: when an image is needed,
 *                 its subject, product, palette and the channel's shape; what
 *                 is missing identified
 *   Structured    the image prompt is written from the visual brief (Google
 *                 stubbed at the network, so what is sent can be checked);
 *                 its fallback still uses the brief
 *   Failure       a failed image run ends with its reason; the post can still
 *                 be edited; regenerating makes the image in the brief's shape
 *   Page          the draft page shows the visual brief
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:visual-context
 */
import { deflateSync } from 'node:zlib';

import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { briefText } from '@/lib/content-brief';
import { getContentBrief } from '@/server/content/content-brief.service';
import { generateDraft } from '@/server/content/generator';
import { updateDraftBody } from '@/server/content/content.service';
import {
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
} from '@/server/jobs/job.service';
import { runJob } from '@/server/jobs/runners';
import { generateImagePrompt } from '@/server/media/image-prompt.service';
import { visualBriefForDraft } from '@/server/media/visual-brief.service';
import { runDetection } from '@/server/opportunities/detection.service';
import { suggestFromOpportunities } from '@/server/recommendations/autosuggest.service';
import { getCreation } from '@/server/recommendations/creation.service';
import { decideRecommendation } from '@/server/recommendations/recommendation.service';
import { collectSignals } from '@/server/signals/signal.service';
import { SAMPLE_BODIES } from '../tests/fixtures/format-bodies';

const BASE = (
  process.env.VERIFY_BASE_URL ??
  process.env.AURA_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-visual-${STAMP}!`;
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
      email: `zzverify-visual-${label}-${STAMP}@example.test`,
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

/** A real PNG of the given size (solid colour), so validation reads true dimensions. */
function png(width: number, height: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x6b)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Stub every Google call at the network: text (the art director) and image
 * (the picture). `image` decides what the image endpoint does.
 */
function stubGoogle(opts: { image: 'ok' | 'fail'; text: 'ok' | 'fail' }) {
  const sent: { url: string; prompt: string }[] = [];
  const realFetch = globalThis.fetch;
  const saved = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_AI_API_KEY: process.env.GOOGLE_AI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.GEMINI_API_KEY = 'stub-key-for-this-check';
  process.env.GOOGLE_AI_API_KEY = 'stub-key-for-this-check';
  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const u = String(url);
    if (!u.includes('generativelanguage.googleapis.com'))
      return realFetch(url, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      contents?: { parts: { text: string }[] }[];
      instances?: { prompt: string }[];
    };
    const prompt =
      body.contents?.[0]?.parts[0]?.text ?? body.instances?.[0]?.prompt ?? '';
    sent.push({ url: u, prompt });
    const image = u.includes('-image') || u.includes(':predict');
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (image) {
      if (opts.image === 'fail') {
        return json(503, {
          error: {
            code: 503,
            message: 'The image model is overloaded. Try again later.',
          },
        });
      }
      const data = png(1024, 1280).toString('base64');
      return u.includes(':predict')
        ? json(200, {
            predictions: [{ bytesBase64Encoded: data, mimeType: 'image/png' }],
          })
        : json(200, {
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: 'image/png', data } }],
                },
              },
            ],
          });
    }
    if (opts.text === 'fail')
      return json(500, { error: { code: 500, message: 'down' } });
    return json(200, {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  subject: 'A roaster weighing beans at a sunlit counter',
                  prompt:
                    'A warm, sunlit roastery counter with a roaster weighing single-origin beans into a bag, brown and cream tones, shallow depth of field, honest and calm mood, no text.',
                  negativePrompt: 'text, logo, watermark',
                }),
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    });
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

/** Run an image job the way POST /api/jobs/:id/run does. */
async function runImageJob(jobId: string) {
  const job = await claimJob(jobId);
  if (!job) return db.generationJob.findUnique({ where: { id: jobId } });
  try {
    await completeJob(job.id, (await runJob(job)) as Record<string, never>);
  } catch (err) {
    await failJob(job.id, err);
  }
  return db.generationJob.findUnique({ where: { id: jobId } });
}

async function main() {
  const owner = await person('owner');
  const company = await db.company.create({
    data: {
      name: 'zzverify visual Roastery',
      slug: `zzverify-visual-${STAMP}`,
      industry: 'Coffee',
      website: 'https://www.roastery.example',
      preferences: {
        ...PROFILE,
        business: {
          ...PROFILE.business,
          offerings: 'Single-origin coffee subscriptions',
        },
        brand: { primaryColor: '#6B3E26', accentColor: '#F2E3C6' },
      } as Prisma.InputJsonObject,
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

    // ---------------------------------------------------------- Requirements
    console.log('\n1. Visual requirements, from the recommendation');
    const ig = await getContentBrief(companyId, rec.id, {
      type: 'IMAGE_POST',
      platform: 'INSTAGRAM',
    });
    const v = ig!.visual!;
    check(
      'an image post for Instagram: image required, 4:5 at 1024×1280',
      v.need === 'required' &&
        v.format.aspectRatio === '4:5' &&
        v.format.width === 1024 &&
        v.format.height === 1280,
      JSON.stringify(v.format),
    );
    check(
      'subject is the recommendation’s key message; product from the business; palette from the brand',
      v.subject?.value === ig!.keyMessage?.value &&
        v.product?.value === 'Single-origin coffee subscriptions' &&
        v.brand.palette.join().toLowerCase() === '#6b3e26,#f2e3c6',
      JSON.stringify({
        subject: v.subject,
        product: v.product,
        palette: v.brand.palette,
      }),
    );
    const email = (await getContentBrief(companyId, rec.id, { type: 'EMAIL' }))!
      .visual!;
    const kit = (await getContentBrief(companyId, rec.id, {
      type: 'CAMPAIGN_COPY',
    }))!.visual!;
    check(
      'an email header is landscape and optional; campaign copy takes no image',
      email.need === 'recommended' &&
        email.format.aspectRatio === '16:9' &&
        kit.need === 'none',
    );
    check(
      'what is missing is identified (here: no brand voice yet)',
      v.missing.some((m) => m.field === 'mood' && m.fix?.href) &&
        v.readiness === 'ready_with_gaps',
      JSON.stringify(v.missing.map((m) => m.field)),
    );

    // A draft written from it (model stubbed), which keeps the brief.
    const stubText = stubModelForWriting();
    let draftId: string;
    try {
      const d = await generateDraft({
        companyId,
        userId: owner.id,
        type: 'IMAGE_POST',
        platform: 'INSTAGRAM',
        source: { kind: 'BRIEF', brief: briefText(ig!) },
        variations: 1,
        recommendation: {
          id: rec.id,
          title: rec.title,
          provenance: creation?.provenance ?? null,
          brief: ig,
        },
      });
      draftId = d.id;
    } finally {
      stubText.restore();
    }
    const draft = (await db.contentDraft.findUnique({
      where: { id: draftId },
    }))!;
    check(
      'the draft keeps its visual brief',
      Boolean(
        (draft.aiMetadata as { brief?: { visual?: unknown } }).brief?.visual,
      ),
    );

    // -------------------------------------------------------- Structured input
    console.log('\n2. Image generation receives structured context');
    let s = stubGoogle({ image: 'ok', text: 'ok' });
    let prompt;
    try {
      prompt = await generateImagePrompt({
        draft,
        userId: owner.id,
        platform: 'INSTAGRAM',
        style: 'professional',
      });
    } finally {
      s.restore();
    }
    const art = s.sent.find((x) => !x.url.includes('-image'))?.prompt ?? '';
    check(
      'the art director is briefed with the visual brief: idea, product, setting, palette, shape, rules',
      art.includes('VISUAL BRIEF') &&
        art.includes(`The idea to carry: ${v.subject!.value}`) &&
        art.includes('Single-origin coffee subscriptions') &&
        art.includes('Consumer imagery') &&
        art.toLowerCase().includes('#6b3e26') &&
        art.includes('Format: 4:5 (1024×1280) for Instagram') &&
        art.includes('Hard rules'),
    );
    check(
      'the prompt result returns the visual brief, for the studio to show',
      prompt.visual?.subject?.value === v.subject!.value &&
        prompt.source === 'ai',
    );
    s = stubGoogle({ image: 'ok', text: 'fail' });
    let fallback;
    try {
      fallback = await generateImagePrompt({
        draft,
        userId: owner.id,
        platform: 'INSTAGRAM',
        style: 'professional',
      });
    } finally {
      s.restore();
    }
    check(
      'if the art director fails, the fallback still uses the brief’s subject and palette',
      fallback.source === 'heuristic' &&
        fallback.subject === v.subject!.value &&
        fallback.prompt.toLowerCase().includes('#6b3e26'),
      fallback.subject,
    );
    const linkedin = await visualBriefForDraft(draft, 'LINKEDIN');
    check(
      'the same image for LinkedIn takes LinkedIn’s shape, keeping the subject',
      linkedin.brief.format.aspectRatio === '1:1' &&
        linkedin.brief.subject?.value === v.subject!.value,
    );

    // ---------------------------------------------------- Failure, regeneration
    console.log(
      '\n3. A failed generation does not block editing or regenerating',
    );
    const inputs = {
      draftId,
      prompt: prompt.prompt,
      provider: 'GOOGLE' as const,
      style: 'professional' as const,
      variations: 1,
    };
    const first = await enqueueJob({
      companyId,
      userId: owner.id,
      kind: 'IMAGE_GENERATION',
      inputs,
      dedupeOn: { draftId },
    });
    s = stubGoogle({ image: 'fail', text: 'ok' });
    let failed;
    try {
      failed = await runImageJob(first.job.id);
    } finally {
      s.restore();
    }
    check(
      `the provider failing ends the run with its reason (${failed?.status})`,
      (failed?.status === 'FAILED' || failed?.status === 'QUEUED') &&
        /overloaded|503|Google/i.test(failed?.error ?? ''),
      failed?.error ?? '',
    );
    const edited = await updateDraftBody({
      companyId,
      userId: owner.id,
      draftId,
      body: {
        ...(draft.body as object),
        caption: 'Edited after the image failed — still my post.',
      },
    });
    check(
      'the post can still be edited',
      (edited.body as { caption?: string }).caption?.startsWith(
        'Edited after',
      ) === true,
    );
    const assetsBefore = await db.generatedAsset.count({
      where: { contentDraftId: draftId },
    });
    // Regenerate: a fresh run (or the queued retry) with the same brief.
    if (failed?.status === 'FAILED') {
      const again = await enqueueJob({
        companyId,
        userId: owner.id,
        kind: 'IMAGE_GENERATION',
        inputs,
        dedupeOn: { draftId },
      });
      check(
        'regenerating starts a new run (the failed one is not reattached)',
        again.job.id !== first.job.id && !again.reused,
      );
      s = stubGoogle({ image: 'ok', text: 'ok' });
      try {
        await runImageJob(again.job.id);
      } finally {
        s.restore();
      }
    } else {
      s = stubGoogle({ image: 'ok', text: 'ok' });
      try {
        await runImageJob(first.job.id);
      } finally {
        s.restore();
      }
    }
    const assets = await db.generatedAsset.findMany({
      where: { contentDraftId: draftId },
    });
    check(
      'and the regenerated image is made in the brief’s shape (4:5)',
      assets.length === assetsBefore + 1 && assets[0]?.aspectRatio === '4:5',
      JSON.stringify(assets.map((a) => [a.aspectRatio, a.width, a.height])),
    );
    const page = new Client();
    await page.signIn(owner.email);
    const view = await page.page(`/dashboard/content/${draftId}`);
    check(
      'the draft page shows the visual brief, what it shows and the shape',
      view.status === 200 &&
        view.text.includes('Visual brief') &&
        view.text.includes('Image required') &&
        view.text.includes('4:5 · 1024×1280 for Instagram'),
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
      ? `\n${failures} visual check(s) failed.`
      : '\nVisual / asset generation context works end to end.',
  );
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

/** For writing the draft: answer the writer with a valid image-post body. */
function stubModelForWriting() {
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
    const text = prompt.includes('"caption": string')
      ? JSON.stringify(SAMPLE_BODIES.IMAGE_POST)
      : '{}';
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch;
  return {
    restore() {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
