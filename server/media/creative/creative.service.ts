import crypto from 'node:crypto';

import type { ContentDraft, ImageProvider } from '@prisma/client';
import { z } from 'zod';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  brandPalette,
  chooseFontPair,
  chooseLayout,
  CREATIVE_TYPES,
  CREATIVE_VERSION,
  detailBacked,
  detectCreativeType,
  figuresBacked,
  type CreativeInput,
  type CreativeSpec,
  type CreativeText,
  type TextField,
  type TextSource,
} from '@/lib/creative/spec';
import { buildPhotoPrompt } from '@/lib/creative/photo-prompt';
import { resolvePlatform } from '@/lib/platforms';
import type { ContentTypeKey } from '@/lib/validations/content';
import { completeStructured, isClaudeConfigured } from '@/server/ai/claude';
import { renderForManual } from '@/server/content/render';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import { recordAudit } from '@/server/services/audit.service';
import { isAnyProviderConfigured } from '@/server/media/providers';
import { generateGraphics } from '@/server/media/generation.service';
import {
  createAsset,
  readAssetBytes,
  toAssetView,
  type AssetView,
} from '@/server/media/asset.service';
import { putImage } from '@/server/media/storage';
import { readImageDimensions, sniffImageMime } from '@/server/media/validate';
import { fetchExternal } from '@/server/media/storage';
import {
  renderCreative,
  type RenderImage,
} from '@/server/media/creative/render';

/**
 * Marketing creatives for a Content Studio draft (lib/creative/spec.ts):
 *
 *   1. copy — the headline, supporting line and call to action written for
 *      the creative; dates, times, venues and offers only as the person gave
 *      them (never invented); every figure checked against what they wrote;
 *   2. photo — a photorealistic background from the existing image providers
 *      (server/media/generation.service.ts), briefed for commercial
 *      photography with calm space where the text goes;
 *   3. layout — composed with real typography, the brand's colours and logo
 *      (server/media/creative/render.ts), exported as one PNG and stored as an
 *      ordinary asset, so attaching, review and approval work as before.
 *
 * When no photo can be made (no provider, quota, an outage) the creative is
 * still delivered on a brand-colour background — and labelled as such, never
 * presented as an AI photograph.
 */

type Bag = Record<string, unknown>;

export interface BrandInfo {
  name: string;
  industry: string | null;
  description: string | null;
  offerings: string | null;
  website: string | null;
  colors: {
    primary: string | null;
    secondary: string | null;
    accent: string | null;
  };
  logoAssetId: string | null;
  logoUrl: string | null;
  tone: string[];
  consumer: boolean;
  audience: string | null;
}

export async function loadBrand(companyId: string): Promise<BrandInfo> {
  const [company, ctx] = await Promise.all([
    db.company.findUnique({
      where: { id: companyId },
      select: { name: true, industry: true, website: true },
    }),
    getBusinessContext(companyId, { sections: [] }),
  ]);
  if (!company) throw new Error('Company not found');
  const v = ctx?.identity.visual ?? null;
  return {
    name: ctx?.identity.name ?? company.name,
    industry: ctx?.identity.industry ?? company.industry ?? null,
    description: ctx?.identity.description ?? null,
    offerings: ctx?.identity.offerings ?? null,
    website: ctx?.identity.website ?? company.website ?? null,
    colors: {
      primary: v?.primaryColor ?? null,
      secondary: v?.secondaryColor ?? null,
      accent: v?.accentColor ?? null,
    },
    logoAssetId: v?.logoAssetId ?? null,
    logoUrl: v?.logoUrl ?? null,
    tone: ctx?.voice.profile?.toneDescriptors ?? [],
    consumer: ctx?.audience.marketMode !== 'B2B',
    audience: ctx?.audience.stated ?? null,
  };
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const copySchema = z.object({
  type: z.enum(CREATIVE_TYPES).catch('brand_awareness'),
  eyebrow: z.string().max(60).nullish(),
  /** The event's or campaign's own name, only as the person wrote it. */
  eventName: z.string().max(100).nullish(),
  headline: z.string().min(2).max(120),
  subheadline: z.string().max(200).nullish(),
  cta: z.string().max(40).nullish(),
  date: z.string().max(80).nullish(),
  time: z.string().max(60).nullish(),
  venue: z.string().max(120).nullish(),
  offer: z.string().max(60).nullish(),
  photoScene: z.string().max(500).nullish(),
});
type Copy = z.infer<typeof copySchema>;

const CTA_DEFAULT: Record<CreativeSpec['type'], string | null> = {
  event: 'Register now',
  product_launch: 'Discover more',
  promotion: 'Shop now',
  offer: 'Shop now',
  greeting: null,
  announcement: 'Learn more',
  educational: 'Read more',
  brand_awareness: 'Learn more',
  retail_promo: 'Visit us',
  b2b: 'Learn more',
};

const words = (s: string, n: number) => {
  const w = s.trim().split(/\s+/);
  return w.length <= n
    ? s.trim()
    : `${w
        .slice(0, n)
        .join(' ')
        .replace(/[,;:—-]+$/, '')}`;
};
const sentences = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 3 && !/^#/.test(x));
const clamp = (s: string | null | undefined, max: number) => {
  if (!s) return null;
  const t = s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“]|["”]$/g, '');
  if (!t) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return cut
    .slice(0, cut.lastIndexOf(' ') > max * 0.6 ? cut.lastIndexOf(' ') : max)
    .replace(/[,;:—-]+$/, '');
};

async function askCopy(args: {
  brand: BrandInfo;
  post: string;
  request: string;
  type: CreativeSpec['type'] | null;
  locked: Partial<Record<TextField | 'eventName', string>>;
}): Promise<Copy> {
  const { brand } = args;
  return completeStructured({
    schema: copySchema,
    tier: 'standard',
    effort: 'low',
    maxTokens: 900,
    system: [
      `You are the creative director at ${brand.name}${brand.industry ? ` (${brand.industry})` : ''}, writing the words for a social media poster.`,
      'Write like a top agency: short, specific, memorable. A headline is 2–7 words; a supporting line is one short sentence.',
      'NEVER invent facts. A date, time, venue, price, discount or offer may only be returned if it is stated in THE REQUEST or THE FIXED DETAILS — otherwise return null for it. Do not put numbers in the headline or supporting line unless they appear in what you were given.',
      'Respond with ONLY valid JSON.',
    ].join('\n'),
    prompt: [
      `BUSINESS: ${brand.name}${brand.description ? ` — ${brand.description}` : ''}`,
      brand.offerings ? `WHAT IT SELLS: ${brand.offerings}` : '',
      brand.audience ? `AUDIENCE: ${brand.audience}` : '',
      brand.tone.length ? `BRAND TONE: ${brand.tone.join(', ')}` : '',
      args.request ? `THE REQUEST (from the person):\n${args.request}` : '',
      Object.keys(args.locked).length
        ? `THE FIXED DETAILS (use exactly, do not change):\n${Object.entries(
            args.locked,
          )
            .map(([k, v]) => `- ${k}: ${v}`)
            .join('\n')}`
        : '',
      args.post
        ? `THE POST THIS POSTER ACCOMPANIES:\n${args.post.slice(0, 2000)}`
        : '',
      args.type
        ? `CREATIVE TYPE: ${args.type}`
        : `Pick the creative type from: ${CREATIVE_TYPES.join(', ')}.`,
      '',
      'Return JSON: {"type": one of the types, "eventName": "the event or campaign name exactly as written in THE REQUEST, or null", "eyebrow": "2-4 word kicker or null", "headline": "2-7 words (for an event: a tagline, not the name)", "subheadline": "one short sentence or null", "cta": "2-3 words or null", "date": null or as stated, "time": null or as stated, "venue": null or as stated, "offer": "short, e.g. 20% OFF — or null", "photoScene": "one sentence: the photograph — a real, specific scene for this business and message (no text in it)"}',
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

export interface CopyResult {
  type: CreativeSpec['type'];
  text: CreativeText;
  sources: Partial<Record<TextField, TextSource>>;
  photoScene: string | null;
  /** Things the guard removed, said plainly. */
  removed: string[];
  ai: boolean;
}

/**
 * The creative's words. What the person typed is used exactly; what Aura
 * writes is checked — a detail they did not give is dropped, never invented.
 */
export async function writeCopy(args: {
  draft: ContentDraft;
  input: CreativeInput;
  brand: BrandInfo;
}): Promise<CopyResult> {
  const { draft, input, brand } = args;
  const meta = (draft.aiMetadata ?? {}) as {
    source?: { brief?: string | null };
  };
  const request = meta.source?.brief?.trim() ?? '';
  const post = renderForManual(draft);
  const locked: Partial<Record<TextField | 'eventName', string>> = {};
  for (const k of [
    'eyebrow',
    'headline',
    'subheadline',
    'date',
    'time',
    'venue',
    'offer',
    'cta',
    'website',
    'eventName',
  ] as const) {
    const v = input[k];
    if (v && v.trim()) locked[k] = v.trim();
  }
  // What the person said, in their own words: the only source for details.
  const userText = [request, ...Object.values(locked)].join('\n');
  const trusted = [
    userText,
    post,
    brand.name,
    brand.description ?? '',
    brand.offerings ?? '',
    brand.website ?? '',
  ].join('\n');
  const consumerB2b = !brand.consumer;

  let copy: Copy | null = null;
  if (isClaudeConfigured()) {
    try {
      copy = await askCopy({
        brand,
        post,
        request,
        type: input.type ?? null,
        locked,
      });
    } catch (err) {
      logger.warn('creative: copy model failed, using the post', {
        draftId: draft.id,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }

  const removed: string[] = [];
  const sources: Partial<Record<TextField, TextSource>> = {};
  let eventFromRequest = false;
  const type =
    input.type ??
    copy?.type ??
    detectCreativeType(
      `${request}\n${post}\n${locked.offer ?? ''}`,
      consumerB2b,
    );
  const lines = sentences(post);

  const pick = (
    field: TextField,
    aiValue: string | null | undefined,
    max: number,
    fallback: string | null,
    fallbackSource: TextSource,
  ): string | null => {
    if (locked[field]) {
      sources[field] = 'you';
      return clamp(locked[field], max);
    }
    const v = clamp(aiValue, max);
    if (v && figuresBacked(v, trusted)) {
      sources[field] = 'aura';
      return v;
    }
    if (v) removed.push(`a ${field} with a figure you did not give (“${v}”)`);
    if (fallback) sources[field] = fallbackSource;
    return fallback ? clamp(fallback, max) : null;
  };
  const detail = (
    field: 'date' | 'time' | 'venue' | 'offer',
    aiValue: string | null | undefined,
    max: number,
  ): string | null => {
    if (locked[field]) {
      sources[field] = 'you';
      return clamp(locked[field], max);
    }
    const v = clamp(aiValue, max);
    if (!v) return null;
    if (request && detailBacked(v, request)) {
      sources[field] = 'your request';
      return v;
    }
    removed.push(`a ${field} that was not in your request (“${v}”)`);
    return null;
  };

  // An event's own name leads its poster — as the person wrote it, never invented.
  const aiEventName = clamp(copy?.eventName, 80);
  const eventName =
    locked.eventName ??
    (aiEventName && request && detailBacked(aiEventName, request)
      ? aiEventName
      : null);
  if (aiEventName && !eventName && !locked.eventName)
    removed.push(
      `an event name that was not in your request (“${aiEventName}”)`,
    );
  if (
    eventName &&
    !locked.eventName &&
    !locked.headline &&
    (type === 'event' || type === 'product_launch')
  ) {
    locked.eventName = eventName;
    // The model's headline becomes the tagline beneath the name.
    if (
      !locked.subheadline &&
      copy?.headline &&
      figuresBacked(copy.headline, trusted)
    ) {
      copy = {
        ...copy,
        subheadline: copy.headline,
        eyebrow: copy.eyebrow ?? null,
      };
    }
    eventFromRequest = true;
  }
  const headlineFallback =
    locked.eventName ??
    (lines[0] ? words(lines[0].replace(/[.!?]$/, ''), 8) : brand.name);
  let headline =
    locked.headline ??
    (locked.eventName && (eventFromRequest || !copy?.headline)
      ? locked.eventName
      : null) ??
    pick(
      'headline',
      copy?.headline,
      60,
      headlineFallback,
      locked.eventName ? 'you' : 'your post',
    );
  if (locked.headline) sources.headline = 'you';
  else if (locked.eventName && headline === locked.eventName)
    sources.headline = eventFromRequest ? 'your request' : 'you';
  headline = clamp(headline, 80) ?? brand.name;

  const text: CreativeText = {
    eyebrow: eventFromRequest
      ? ((sources.eyebrow = 'business'), clamp(brand.name, 32))
      : pick(
          'eyebrow',
          copy?.eyebrow,
          32,
          type === 'event' ? brand.name : null,
          'business',
        ),
    headline,
    subheadline: pick(
      'subheadline',
      copy?.subheadline,
      110,
      lines[1] ? words(lines[1], 16) : null,
      'your post',
    ),
    date: detail('date', copy?.date, 60),
    time: detail('time', copy?.time, 40),
    venue: detail('venue', copy?.venue, 100),
    offer: detail('offer', copy?.offer, 40),
    cta: pick('cta', copy?.cta, 24, CTA_DEFAULT[type], 'aura'),
    website: locked.website ? clamp(locked.website, 80) : null,
  };
  if (text.website) sources.website = 'you';
  // A named event leads; the model's line supports it.
  if (locked.eventName && locked.headline && !locked.eyebrow) {
    text.eyebrow = clamp(locked.eventName, 32);
    sources.eyebrow = 'you';
  }
  return {
    type,
    text,
    sources,
    photoScene: copy?.photoScene?.trim() || null,
    removed,
    ai: Boolean(copy),
  };
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

export async function buildSpec(args: {
  draft: ContentDraft;
  input: CreativeInput;
  brand?: BrandInfo;
  /** Keep this text (regenerating only the photo, or re-rendering an edit). */
  keepText?: {
    text: CreativeText;
    sources: CreativeSpec['sources'];
    type: CreativeSpec['type'];
  } | null;
  variant?: number;
}): Promise<{
  spec: CreativeSpec;
  photoPrompt: { prompt: string; negativePrompt: string };
  removed: string[];
  copyByAi: boolean;
}> {
  const brand = args.brand ?? (await loadBrand(args.draft.companyId));
  const input = args.input;
  const copy = args.keepText
    ? { ...args.keepText, photoScene: null, removed: [], ai: false }
    : await writeCopy({ draft: args.draft, input, brand });
  const type = input.type ?? copy.type;
  const layout =
    input.layout ??
    chooseLayout(type, {
      hasOffer: Boolean(copy.text.offer),
      variant: args.variant ?? 0,
    });
  const fontPair = input.fontPair ?? chooseFontPair(type, brand.tone);
  const mood =
    input.mood ??
    (type === 'product_launch'
      ? 'studio'
      : type === 'greeting' || type === 'event'
        ? 'moody'
        : 'natural');
  const colors = brandPalette({
    primary: input.colors.primary ?? brand.colors.primary,
    secondary: brand.colors.secondary,
    accent: input.colors.accent ?? brand.colors.accent,
  });
  const spec: CreativeSpec = {
    version: CREATIVE_VERSION,
    type,
    layout,
    aspectRatio: input.aspectRatio,
    fontPair,
    mood,
    text: copy.text,
    sources: copy.sources,
    brand: {
      name: brand.name,
      colors,
      logoAssetId: brand.logoAssetId,
      logoUrl: brand.logoUrl,
      showLogo: input.showLogo,
    },
    photo: {
      assetId: input.photo === 'reuse' ? (input.photoAssetId ?? null) : null,
      prompt: null,
      direction: input.photoDirection?.trim() || null,
      fallback: false,
      fallbackReason: null,
    },
  };
  const photoPrompt = buildPhotoPrompt({
    type,
    layout,
    aspectRatio: input.aspectRatio,
    mood,
    business: {
      name: brand.name,
      industry: brand.industry,
      offerings: brand.offerings,
      description: brand.description,
    },
    scene: copy.photoScene,
    direction: spec.photo.direction,
    consumer: brand.consumer,
  });
  return { spec, photoPrompt, removed: copy.removed, copyByAi: copy.ai };
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** resvg draws PNG and JPEG reliably; anything else is not used. */
function asRenderImage(data: Buffer | null): RenderImage | null {
  if (!data) return null;
  const mime = sniffImageMime(data);
  if (mime !== 'image/png' && mime !== 'image/jpeg') return null;
  const dims = readImageDimensions(data, mime);
  if (!dims) return null;
  return {
    src: `data:${mime};base64,${data.toString('base64')}`,
    width: dims.width,
    height: dims.height,
  };
}

async function assetImage(
  companyId: string,
  assetId: string | null,
): Promise<{ image: RenderImage | null; provider: ImageProvider | null }> {
  if (!assetId) return { image: null, provider: null };
  const asset = await db.generatedAsset.findFirst({
    where: { id: assetId, companyId },
  });
  if (!asset) return { image: null, provider: null };
  return {
    image: asRenderImage(await readAssetBytes(asset)),
    provider: asset.provider,
  };
}

async function logoImage(
  companyId: string,
  spec: CreativeSpec,
  warnings: string[],
): Promise<RenderImage | null> {
  if (!spec.brand.showLogo) return null;
  if (spec.brand.logoAssetId) {
    const { image } = await assetImage(companyId, spec.brand.logoAssetId);
    if (image) return image;
  }
  if (spec.brand.logoUrl && /^https:\/\//.test(spec.brand.logoUrl)) {
    try {
      const image = asRenderImage(await fetchExternal(spec.brand.logoUrl));
      if (image) return image;
    } catch {
      /* unreachable logo: use the name */
    }
  }
  if (spec.brand.logoAssetId || spec.brand.logoUrl) {
    warnings.push(
      'Your logo could not be read (it must be a PNG or JPEG), so the business name is shown instead.',
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Producing a creative
// ---------------------------------------------------------------------------

export interface CreativeResult {
  asset: AssetView;
  spec: CreativeSpec;
  warnings: string[];
  /** Details the guard removed because they were not given. */
  removed: string[];
}

const cuidLike = () =>
  `c${Date.now().toString(36)}${crypto.randomBytes(9).toString('base64url').toLowerCase()}`;

/** Compose, render and store a creative from a resolved spec. */
export async function composeAndStore(args: {
  draft: ContentDraft;
  userId: string | null;
  spec: CreativeSpec;
  removed?: string[];
  jobId?: string;
}): Promise<CreativeResult> {
  const { draft, spec } = args;
  const warnings: string[] = [];
  const [{ image: photo, provider }, logo] = await Promise.all([
    assetImage(draft.companyId, spec.photo.assetId),
    logoImage(draft.companyId, spec, warnings),
  ]);
  if (spec.photo.assetId && !photo) {
    warnings.push(
      'The photo could not be used (it must be a PNG or JPEG), so a brand background was used.',
    );
    spec.photo = {
      ...spec.photo,
      assetId: null,
      fallback: true,
      fallbackReason: 'the photo could not be read',
    };
  }
  const rendered = await renderCreative(spec, { photo, logo });
  warnings.push(...rendered.warnings);

  const assetId = cuidLike();
  const stored = await putImage({
    companyId: draft.companyId,
    assetId,
    data: rendered.png,
    mimeType: 'image/png',
  });
  const platform = resolvePlatform(
    draft.type as ContentTypeKey,
    draft.platform,
  );
  const row = await createAsset({
    id: assetId,
    companyId: draft.companyId,
    contentDraftId: draft.id,
    createdById: args.userId,
    // The photo's provenance; a creative with no AI photo is the business's own design.
    provider: provider ?? 'UPLOAD',
    model: `aura-creative/${spec.layout}`,
    kind: 'IMAGE',
    prompt: `Marketing creative: ${spec.text.headline}`,
    originalPrompt: spec.photo.prompt,
    style: 'creative',
    aspectRatio: spec.aspectRatio,
    width: rendered.width,
    height: rendered.height,
    mimeType: 'image/png',
    fileSize: rendered.png.byteLength,
    storage: stored.storage,
    data: stored.data ?? null,
    storageUrl: stored.storageUrl ?? null,
    platform,
    metadata: {
      kind: 'creative',
      spec,
      warnings,
      removed: args.removed ?? [],
      ...(args.jobId ? { creativeJobId: args.jobId } : {}),
    } as object,
  });
  await recordAudit({
    action: 'GRAPHIC_GENERATED',
    userId: args.userId,
    companyId: draft.companyId,
    metadata: {
      draftId: draft.id,
      creative: true,
      type: spec.type,
      layout: spec.layout,
      aspectRatio: spec.aspectRatio,
      photo: spec.photo.assetId
        ? 'photo'
        : spec.photo.fallback
          ? 'fallback'
          : 'none',
    },
  });
  return {
    asset: toAssetView(row),
    spec,
    warnings,
    removed: args.removed ?? [],
  };
}

/**
 * The full run (a background job): copy, a new photograph, the layout.
 * A photo that cannot be made never costs the creative — it is delivered on
 * the brand's colours and says so.
 */
export async function generateCreative(args: {
  draft: ContentDraft;
  userId: string | null;
  input: CreativeInput;
  keepText?: {
    text: CreativeText;
    sources: CreativeSpec['sources'];
    type: CreativeSpec['type'];
  } | null;
  jobId?: string;
  report?: (message: string, percent: number) => Promise<void>;
}): Promise<CreativeResult> {
  const { draft, input } = args;
  // A retried job returns the creative it already made rather than paying again.
  if (args.jobId) {
    const done = await db.generatedAsset.findFirst({
      where: {
        companyId: draft.companyId,
        metadata: { path: ['creativeJobId'], equals: args.jobId },
      },
      select: {
        id: true,
        companyId: true,
        contentDraftId: true,
        createdById: true,
        provider: true,
        model: true,
        kind: true,
        prompt: true,
        originalPrompt: true,
        revisedPrompt: true,
        negativePrompt: true,
        style: true,
        aspectRatio: true,
        width: true,
        height: true,
        mimeType: true,
        fileSize: true,
        storage: true,
        storageUrl: true,
        sourceUrl: true,
        platform: true,
        metadata: true,
        createdAt: true,
      },
    });
    if (done) {
      const m = done.metadata as unknown as {
        spec: CreativeSpec;
        warnings?: string[];
        removed?: string[];
      };
      return {
        asset: toAssetView(done),
        spec: m.spec,
        warnings: m.warnings ?? [],
        removed: m.removed ?? [],
      };
    }
  }

  await args.report?.(
    args.keepText ? 'Keeping your text…' : 'Writing the words…',
    15,
  );
  const { spec, photoPrompt, removed } = await buildSpec({
    draft,
    input,
    keepText: args.keepText ?? null,
  });
  spec.photo.prompt = photoPrompt.prompt;

  if (input.photo === 'new') {
    if (!isAnyProviderConfigured()) {
      spec.photo.fallback = true;
      spec.photo.fallbackReason = 'no image provider is configured';
    } else {
      await args.report?.('Photographing the scene…', 35);
      try {
        const result = await generateGraphics({
          draft,
          userId: args.userId,
          prompt: photoPrompt.prompt,
          negativePrompt: photoPrompt.negativePrompt,
          aspectRatio: input.aspectRatio,
          style: 'photo',
          variations: 1,
          ...(args.jobId ? { jobId: args.jobId } : {}),
        });
        spec.photo.assetId = result.assets[0]?.id ?? null;
        if (!spec.photo.assetId) {
          spec.photo.fallback = true;
          spec.photo.fallbackReason = 'the image provider returned no photo';
        }
      } catch (err) {
        const status = (err as { status?: number })?.status;
        spec.photo.fallback = true;
        spec.photo.fallbackReason =
          status === 429 ||
          /quota|rate|limit/i.test(err instanceof Error ? err.message : '')
            ? 'the image provider is at its limit'
            : 'the image provider did not return a photo';
        logger.warn('creative: photo failed, using a brand background', {
          draftId: draft.id,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        });
      }
    }
  }
  await args.report?.('Setting the type and layout…', 80);
  return composeAndStore({
    draft,
    userId: args.userId,
    spec,
    removed,
    ...(args.jobId ? { jobId: args.jobId } : {}),
  });
}

/** The creatives made for a draft, newest first. */
export async function creativesForDraft(companyId: string, draftId: string) {
  return db.generatedAsset.findMany({
    where: {
      companyId,
      contentDraftId: draftId,
      metadata: { path: ['kind'], equals: 'creative' },
    },
    orderBy: { createdAt: 'desc' },
    take: 12,
    select: { id: true, metadata: true, createdAt: true },
  });
}

export function specOf(metadata: unknown): CreativeSpec | null {
  const m = (metadata ?? {}) as Bag;
  return m.kind === 'creative' && m.spec ? (m.spec as CreativeSpec) : null;
}
