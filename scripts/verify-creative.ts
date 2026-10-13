/**
 * Marketing creatives, against the real database and the running app
 * (lib/creative, server/media/creative). The AI is stubbed at the network —
 * the copy model and the image model — so the checks are repeatable.
 *
 *   Creative    a photo + copy + layout: one branded PNG at the right size,
 *               the photo briefed as commercial photography, the copy never
 *               inventing a date, venue or offer
 *   Failure     the image provider at its limit: still a creative, labelled
 *               as a brand background
 *   Studio      list, re-set text/layout on the same photo (no generation),
 *               refuse an unfittable headline, roles, a queued job
 *   Approval    attached, reviewed, nothing published
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:creative
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

import { db } from '@/lib/db';
import { creativeInputSchema } from '@/lib/creative/spec';
import { assetsThisMonth, readAssetBytes } from '@/server/media/asset.service';
import { generateCreative } from '@/server/media/creative/creative.service';
import { loadFonts } from '@/server/media/creative/fonts';
import { readImageDimensions } from '@/server/media/validate';

const BASE = (
  process.env.VERIFY_BASE_URL ??
  process.env.AURA_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-creative-${STAMP}!`;
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
      email: `zzverify-creative-${label}-${STAMP}@example.test`,
      name: `Dana ${label}`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      emailVerified: new Date(),
    },
  });
}

/** A photograph stand-in (rendered once): a PNG the stubbed image model returns. */
async function scenePng(): Promise<Buffer> {
  const { fonts } = loadFonts();
  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          width: 1024,
          height: 1024,
          backgroundImage:
            'linear-gradient(160deg, #c8a27a 0%, #6b4a32 55%, #2b1d14 100%)',
        },
        children: [
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                position: 'absolute',
                left: 300,
                top: 260,
                width: 420,
                height: 520,
                borderRadius: 40,
                backgroundColor: '#e9dccb',
              },
            },
          },
        ],
      },
    } as never,
    { width: 1024, height: 1024, fonts },
  );
  return Buffer.from(new Resvg(svg).render().asPng());
}

interface Sent {
  url: string;
  body: string;
}

/** Stub the AI at the network: the copy model and the image model, told apart by the request. */
async function withAi<T>(
  opts: { copy: unknown; image: 'ok' | 429 },
  run: () => Promise<T>,
) {
  const sent: Sent[] = [];
  const png = await scenePng();
  const realFetch = globalThis.fetch;
  const saved = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GOOGLE_AI_API_KEY: process.env.GOOGLE_AI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  process.env.GEMINI_API_KEY = 'stub';
  process.env.GOOGLE_AI_API_KEY = 'stub';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const u = String(url);
    if (!u.includes('generativelanguage.googleapis.com'))
      return realFetch(url, init);
    const body = String(init?.body ?? '');
    sent.push({ url: u, body });
    const isImage = body.includes('"IMAGE"') || u.includes(':predict');
    if (isImage && opts.image === 429) {
      return new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: 'Resource has been exhausted (e.g. check quota).',
            status: 'RESOURCE_EXHAUSTED',
          },
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
    }
    const parts = isImage
      ? [
          {
            inlineData: { mimeType: 'image/png', data: png.toString('base64') },
          },
        ]
      : [{ text: JSON.stringify(opts.copy) }];
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts }, finishReason: 'STOP' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    return { result: await run(), sent };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const COPY = {
  type: 'event',
  eventName: 'Annual Business Summit 2026',
  headline: 'Innovate. Connect. Grow.',
  subheadline: 'A day of strategy and connection.',
  cta: 'Register now',
  date: 'November 15',
  time: null,
  venue: 'Grand Hyatt, Mumbai',
  offer: 'Early bird 50% OFF',
  photoScene: 'a modern conference hall with an engaged audience',
};

const pngSize = (b: Buffer) => readImageDimensions(b, 'image/png');

async function main() {
  const owner = await person('owner');
  const viewer = await person('viewer');
  const outsider = await person('outsider');
  const company = await db.company.create({
    data: {
      name: 'zzverify Nova Consulting',
      slug: `zzverify-creative-${STAMP}`,
      industry: 'Management consulting',
      website: 'https://novagroup.example',
      preferences: {
        business: {
          description: 'Management consulting for mid-sized companies.',
        },
        marketingProfile: {
          marketMode: 'B2B',
          audience: 'Founders and CEOs',
          goals: 'Fill the annual summit',
        },
        brand: { primaryColor: '#0E3B43', accentColor: '#F2B134' },
      } as Prisma.InputJsonObject,
    },
  });
  const other = await db.company.create({
    data: {
      name: 'zzverify creative Other',
      slug: `zzverify-creative-o-${STAMP}`,
    },
  });
  const companyId = company.id;
  await db.companyMember.createMany({
    data: [
      { userId: owner.id, companyId, role: 'OWNER' },
      { userId: viewer.id, companyId, role: 'VIEWER' },
      { userId: outsider.id, companyId: other.id, role: 'OWNER' },
    ],
  });
  // A real logo on file.
  const logoPng = await scenePng();
  const logo = await db.generatedAsset.create({
    data: {
      companyId,
      provider: 'UPLOAD',
      model: 'upload',
      prompt: 'logo',
      aspectRatio: '1:1',
      width: 1024,
      height: 1024,
      mimeType: 'image/png',
      fileSize: logoPng.byteLength,
      data: logoPng,
    },
  });
  await db.company.update({
    where: { id: companyId },
    data: {
      preferences: {
        ...(company.preferences as object),
        brand: {
          primaryColor: '#0E3B43',
          accentColor: '#F2B134',
          logoAssetId: logo.id,
        },
      } as Prisma.InputJsonObject,
    },
  });
  const draft = await db.contentDraft.create({
    data: {
      companyId,
      createdById: owner.id,
      type: 'IMAGE_POST',
      platform: 'INSTAGRAM',
      status: 'DRAFT',
      title: 'Annual Business Summit 2026',
      body: {
        caption:
          'Our Annual Business Summit 2026 brings founders together for a day of strategy. Join us on November 15.',
        cta: 'Register today.',
        hashtags: ['summit'],
        altText: '',
      },
      aiMetadata: {
        source: {
          kind: 'BRIEF',
          brief:
            "Create a professional Instagram poster for our company's Annual Business Summit 2026 on November 15.",
        },
      } as Prisma.InputJsonObject,
    },
  });
  const load = async (id: string) =>
    (await db.generatedAsset.findUnique({ where: { id } }))!;

  try {
    // ------------------------------------------------------------ Full run
    console.log('\n1. A complete, branded creative: photo + copy + layout');
    const full = await withAi({ copy: COPY, image: 'ok' }, () =>
      generateCreative({
        draft,
        userId: owner.id,
        input: creativeInputSchema.parse({ aspectRatio: '4:5' }),
      }),
    );
    const r = full.result;
    const creative = await load(r.asset.id);
    const bytes = (await readAssetBytes(creative))!;
    check(
      'one PNG at Instagram portrait size (1080×1350), stored as a creative on the draft',
      creative.mimeType === 'image/png' &&
        JSON.stringify(pngSize(bytes)) ===
          JSON.stringify({ width: 1080, height: 1350 }) &&
        creative.contentDraftId === draft.id &&
        (creative.metadata as { kind?: string }).kind === 'creative',
    );
    const photo = r.spec.photo.assetId
      ? await load(r.spec.photo.assetId)
      : null;
    check(
      'the background is a real generated photograph (Google, photorealistic style), kept as its own asset',
      Boolean(photo) &&
        photo!.provider === 'GOOGLE' &&
        photo!.style === 'photo' &&
        creative.provider === 'GOOGLE' &&
        !r.spec.photo.fallback,
    );
    const imageCall = full.sent.find((s) => s.body.includes('"IMAGE"'));
    const copyCall = full.sent.find((s) => !s.body.includes('"IMAGE"'));
    check(
      'the photo is briefed as commercial photography with no text in it; the copy model is told never to invent',
      Boolean(
        imageCall &&
        /Photorealistic/.test(imageCall.body) &&
        /no text, letters, logos/.test(imageCall.body) &&
        /lower 40%|lower half|calm/.test(imageCall.body),
      ) && Boolean(copyCall && /NEVER invent facts/.test(copyCall.body)),
    );
    check(
      'the event’s name leads (from the request), the date is the person’s, invented venue and offer are dropped',
      r.spec.text.headline === 'Annual Business Summit 2026' &&
        r.spec.sources.headline === 'your request' &&
        r.spec.text.subheadline === 'Innovate. Connect. Grow.' &&
        r.spec.text.date === 'November 15' &&
        r.spec.text.venue === null &&
        r.spec.text.offer === null &&
        r.removed.some((x) => /venue/.test(x)) &&
        r.removed.some((x) => /offer/.test(x)),
      JSON.stringify({ text: r.spec.text, removed: r.removed }),
    );
    check(
      'the brand is applied: its colours and its logo',
      r.spec.brand.colors.primary === '#0E3B43' &&
        r.spec.brand.colors.accent === '#F2B134' &&
        r.spec.brand.logoAssetId === logo.id &&
        !r.warnings.some((w) => /logo/.test(w)),
      JSON.stringify(r.spec.brand),
    );

    // ------------------------------------------------------------- Failure
    console.log('\n2. When the image provider fails');
    const failed = await withAi({ copy: COPY, image: 429 }, () =>
      generateCreative({
        draft,
        userId: owner.id,
        input: creativeInputSchema.parse({
          aspectRatio: '1:1',
          layout: 'split',
        }),
      }),
    );
    const fb = failed.result;
    const fbAsset = await load(fb.asset.id);
    check(
      'the creative is still made, on the brand’s colours — and labelled as no AI photo, never as a photograph',
      fb.spec.photo.fallback &&
        fb.spec.photo.fallbackReason === 'the image provider is at its limit' &&
        fb.spec.photo.assetId === null &&
        fbAsset.provider === 'UPLOAD' &&
        fb.asset.creative?.fallback === true &&
        JSON.stringify(pngSize((await readAssetBytes(fbAsset))!)) ===
          JSON.stringify({ width: 1080, height: 1080 }),
      JSON.stringify(fb.spec.photo),
    );

    // ------------------------------------------------------------- The app
    console.log('\n3. In Content Studio');
    const ownerC = new Client();
    await ownerC.signIn(owner.email);
    const viewerC = new Client();
    await viewerC.signIn(viewer.email);
    const outC = new Client();
    await outC.signIn(outsider.email);

    const list = await ownerC.req(
      'GET',
      `/api/content/drafts/${draft.id}/creative`,
    );
    check(
      'the studio lists the creatives with their design, the photos to reuse, and the brand defaults',
      list.status === 200 &&
        list.json?.creatives?.length === 2 &&
        list.json.creatives[0].spec?.layout === 'split' &&
        list.json.photos.some(
          (p: { id: string }) => p.id === r.spec.photo.assetId,
        ) &&
        list.json.brand.colors.primary === '#0E3B43' &&
        list.json.brand.hasLogo === true,
      JSON.stringify(list.json).slice(0, 300),
    );

    const usedBefore = await assetsThisMonth(companyId);
    const edit = await ownerC.req(
      'POST',
      `/api/content/drafts/${draft.id}/creative/render`,
      {
        input: {
          aspectRatio: '9:16',
          layout: 'spotlight',
          fontPair: 'elegant',
          photo: 'reuse',
          photoAssetId: r.spec.photo.assetId,
          colors: {},
        },
        keepText: {
          type: 'event',
          text: {
            ...r.spec.text,
            headline: 'Annual Business Summit 2026 — Mumbai',
            time: '9:00 AM',
          },
          sources: r.spec.sources,
        },
      },
    );
    const edited = edit.json?.asset ? await load(edit.json.asset.id) : null;
    check(
      'editing the text re-sets the design on the SAME photo in seconds, at story size, without a new generation',
      edit.status === 201 &&
        edited !== null &&
        JSON.stringify(pngSize((await readAssetBytes(edited))!)) ===
          JSON.stringify({ width: 1080, height: 1920 }) &&
        edit.json.spec.photo.assetId === r.spec.photo.assetId &&
        edit.json.spec.text.time === '9:00 AM' &&
        (await assetsThisMonth(companyId)) === usedBefore,
      `${edit.status} ${JSON.stringify(edit.json).slice(0, 200)}`,
    );
    const tooLong = await ownerC.req(
      'POST',
      `/api/content/drafts/${draft.id}/creative/render`,
      {
        input: { aspectRatio: '1:1', photo: 'none', colors: {} },
        keepText: {
          type: 'event',
          text: {
            ...r.spec.text,
            headline:
              'Supercalifragilisticexpialidociouslyunbelievableextraordinary',
          },
          sources: {},
        },
      },
    );
    check(
      'a headline that cannot fit is refused with a reason (422) — never cropped',
      tooLong.status === 422 && /too long/.test(String(tooLong.json?.error)),
      `${tooLong.status} ${tooLong.json?.error}`,
    );

    const vr = await viewerC.req(
      'POST',
      `/api/content/drafts/${draft.id}/creative/render`,
      {
        input: { photo: 'none', colors: {} },
        keepText: { type: 'event', text: r.spec.text, sources: {} },
      },
    );
    const vg = await viewerC.req(
      'POST',
      `/api/content/drafts/${draft.id}/creative`,
      { input: { photo: 'none', colors: {} } },
    );
    const og = await outC.req(
      'GET',
      `/api/content/drafts/${draft.id}/creative`,
    );
    check(
      'a viewer cannot make creatives (403); another workspace cannot see them (404)',
      vr.status === 403 && vg.status === 403 && og.status === 404,
      `${vr.status} ${vg.status} ${og.status}`,
    );

    // A queued run through the job system (brand background — no photo is spent).
    const queued = await ownerC.req(
      'POST',
      `/api/content/drafts/${draft.id}/creative`,
      {
        input: {
          aspectRatio: '1:1',
          photo: 'none',
          headline: 'Annual Business Summit 2026',
          date: 'November 15',
          cta: 'Register now',
          colors: {},
        },
      },
    );
    let job: Record<string, any> | null = null;
    if (queued.json?.jobId) {
      await ownerC.req('POST', `/api/jobs/${queued.json.jobId}/run`);
      for (let i = 0; i < 40; i++) {
        const j = await ownerC.req('GET', `/api/jobs/${queued.json.jobId}`);
        if (j.json?.status === 'SUCCEEDED' || j.json?.status === 'FAILED') {
          job = j.json;
          break;
        }
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
    const jc = job?.result?.creative;
    check(
      'a creative queued through the app runs as a background job and comes back with what the person set, exactly',
      queued.status === 202 &&
        job?.status === 'SUCCEEDED' &&
        jc?.spec?.text?.headline === 'Annual Business Summit 2026' &&
        jc.spec.text.date === 'November 15' &&
        jc.spec.sources.date === 'you' &&
        jc.spec.photo.assetId === null,
      `${queued.status} ${job?.status} ${job?.error ?? ''} ${JSON.stringify(jc?.spec?.text ?? null)}`,
    );
    const graphics = await ownerC.req(
      'GET',
      `/api/content/drafts/${draft.id}/graphics`,
    );
    const file = await ownerC.req(
      'GET',
      `/api/content/graphics/${r.asset.id}/file`,
    );
    check(
      'the plain graphics panel is unaffected, and the creative is served as an image',
      graphics.status === 200 &&
        graphics.json?.activeJob === null &&
        file.status === 200,
      `${graphics.status} ${file.status}`,
    );

    // --------------------------------------------------------- Approval
    console.log('\n4. Still needs approval — nothing is published');
    const att = await ownerC.req(
      'POST',
      `/api/content/graphics/${r.asset.id}/attach`,
      {
        draftId: draft.id,
        replace: true,
        altText: 'Annual Business Summit 2026',
      },
    );
    const item = (await ownerC.req('GET', `/api/review/content/${draft.id}`))
      .json?.item as { asset?: { images: { url: string }[] } } | undefined;
    const d0 = (await db.contentDraft.findUnique({ where: { id: draft.id } }))!;
    check(
      'attached to the post, it shows in the review; the post is still a draft and nothing was published',
      att.status === 200 &&
        (item?.asset?.images.length ?? 0) === 1 &&
        d0.status === 'DRAFT' &&
        d0.publishedUrl === null,
      `${att.status} ${JSON.stringify(item?.asset ?? null)}`,
    );
    const page = await ownerC.page(`/dashboard/content/${draft.id}`);
    check(
      'the draft page has the Marketing creative studio',
      page.status === 200 && page.text.includes('Marketing creative'),
    );
  } finally {
    await db.company
      .delete({ where: { id: companyId } })
      .catch(() => undefined);
    await db.company.delete({ where: { id: other.id } }).catch(() => undefined);
    for (const u of [owner, viewer, outsider])
      await db.user.delete({ where: { id: u.id } }).catch(() => undefined);
    console.log('  ok      cleanup: throwaway workspaces and users removed');
  }

  console.log(
    failures
      ? `\n${failures} creative check(s) failed.`
      : '\nMarketing creatives work end to end.',
  );
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
