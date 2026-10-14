import { z } from 'zod';

import { requireUser } from '@/lib/auth-helpers';
import { rateLimit } from '@/lib/rate-limit';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { logger } from '@/lib/logger';
import { agnesImageProvider } from '@/server/media/providers/agnes';
import { googleImageProvider } from '@/server/media/providers/gemini';
import { ImageProviderError } from '@/server/media/types';
import type { ImageGenerationProvider } from '@/server/media/types';
import { withPhotoRealism } from '@/lib/photo-realism';

/**
 * POST /api/generate-image — text-to-image across several providers.
 *
 * WHY THIS ROUTE EXISTS AT ALL
 * ----------------------------
 * The browser must never hold an image-provider key. A key shipped to the
 * client is a key published: it appears in the bundle, in devtools, and in any
 * saved copy of the page. So the browser posts a prompt and a model name here,
 * this route adds the credential server-side, and only an image comes back.
 *
 * That is also why every key is read from `process.env` with no NEXT_PUBLIC_
 * prefix — Next inlines any NEXT_PUBLIC_* value into the client bundle at
 * build time, which would defeat the whole arrangement.
 *
 * AUTHENTICATION IS PART OF KEEPING THE KEY PRIVATE
 * -------------------------------------------------
 * Hiding a key behind an endpoint anyone can call does not protect it; it just
 * means the whole internet spends the quota through our server instead of
 * holding the string. So this requires a signed-in user and is rate limited,
 * like every other route here that costs money.
 *
 * AGNES AND GEMINI REUSE THE PROVIDER REGISTRY
 * --------------------------------------------
 * Both already exist as tested providers under server/media/providers, with
 * their own retry, fan-out and error mapping. Re-implementing them inline here
 * would mean two copies drifting apart — and the drift between the provider
 * list and the request schema has already caused one user-visible bug. Hugging
 * Face is handled inline because it is not part of that registry: it returns
 * raw image bytes rather than the JSON envelope the registry is built around.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Image generation is slow; the platform default (~10s) is far too tight. */
export const maxDuration = 60;

const HF_DEFAULT_MODEL = 'black-forest-labs/FLUX.1-schnell';
const HF_DEFAULT_BASE = 'https://api-inference.huggingface.co/models';
const TIMEOUT_MS = 45_000;

/**
 * Model choices the client may send.
 *
 * Kept permissive on purpose: `model` is also matched by prefix below, so a
 * FLUX variant the dropdown does not list still routes to Hugging Face.
 */
const bodySchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, 'Enter a prompt describing the image you want.')
    .max(2000, 'Keep the prompt under 2000 characters.'),
  /** Defaults to Hugging Face, the only one with a free tier. */
  model: z.string().trim().max(120).optional(),
  /**
   * Make it look like a real marketing photograph (lib/photo-realism.ts).
   * On unless turned off; a prompt asking for an illustration, 3D or the like
   * is sent as written either way.
   */
  realistic: z.boolean().optional().default(true),
});

interface ImageRequest {
  prompt: string;
  negativePrompt: string | null;
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();

    // Generating an image costs money, so it is throttled per user like the
    // other paid paths in this app.
    const limit = rateLimit(`generate-image:${user.id}`, {
      limit: 10,
      windowMs: 60_000,
    });
    if (!limit.allowed) {
      return jsonError(
        `Too many image requests. Try again in ${limit.retryAfterSeconds}s.`,
        429,
      );
    }

    const raw = await req.json().catch(() => null);
    if (raw === null) {
      return jsonError('Send a JSON body of the form { "prompt": "..." }.', 400);
    }
    const { prompt: written, model, realistic } = bodySchema.parse(raw);
    // The person's words first, then the photographic direction.
    const request: ImageRequest = realistic
      ? withPhotoRealism(written)
      : { prompt: written, negativePrompt: null };

    const choice = (model ?? 'huggingface').toLowerCase();

    // Prefix match as well as exact, so "flux-1-schnell" or a future FLUX
    // variant reaches Hugging Face without a schema change.
    if (choice === 'huggingface' || choice.startsWith('flux')) {
      return await generateWithHuggingFace(request);
    }
    if (
      choice === 'nano-banana' ||
      choice === 'gemini' ||
      choice === 'google'
    ) {
      return await generateWithProvider(googleImageProvider, 'Gemini', request);
    }
    if (choice === 'agnes') {
      return await generateWithProvider(
        agnesImageProvider,
        'Agnes AI',
        request,
      );
    }

    return jsonError(
      `Unknown model "${model}". Choose one of: huggingface, nano-banana, agnes.`,
      422,
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      const first = error.issues[0]?.message;
      return jsonError(first ?? 'That request was not valid.', 422);
    }
    return handleRouteError(error);
  }
}

/**
 * Hugging Face Inference — raw bytes, not JSON.
 *
 * The response body IS the image, so it is read as an ArrayBuffer and returned
 * as a data URI. That also means an error must be read as TEXT: asking for
 * .json() on an HTML error page throws, and the user would see a parser
 * message instead of the reason.
 */
async function generateWithHuggingFace({
  prompt,
  negativePrompt,
}: ImageRequest) {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) {
    return jsonError(
      'Hugging Face is not configured on this deployment. Add HUGGINGFACE_API_KEY to the server environment.',
      503,
    );
  }

  const base = (process.env.HUGGINGFACE_API_BASE || HF_DEFAULT_BASE).replace(
    /\/+$/,
    '',
  );
  const modelId = process.env.HUGGINGFACE_MODEL_ID || HF_DEFAULT_MODEL;
  const endpoint = `${base}/${modelId}`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: prompt,
        ...(negativePrompt
          ? { parameters: { negative_prompt: negativePrompt } }
          : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    logger.error('huggingface: request failed before a response', {
      endpoint,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonError(
      timedOut
        ? 'Hugging Face took too long to respond. FLUX.1-schnell is usually quick — try again.'
        : 'Could not reach Hugging Face. Check HUGGINGFACE_API_BASE and your network.',
      timedOut ? 504 : 502,
    );
  }

  if (!res.ok) {
    // Read as text: an error may be JSON, HTML or a bare string.
    const text = await res.text().catch(() => '');
    let detail = text;
    let estimatedTime: number | null = null;
    try {
      const parsed = JSON.parse(text) as {
        error?: string;
        estimated_time?: number;
      };
      if (parsed.error) detail = parsed.error;
      if (typeof parsed.estimated_time === 'number') {
        estimatedTime = parsed.estimated_time;
      }
    } catch {
      // Not JSON; the raw text is the best detail available.
    }

    logger.error('huggingface: generation failed', {
      status: res.status,
      endpoint,
      modelId,
      detail: detail.slice(0, 200),
    });

    // A cold model is the single most common Hugging Face failure and the only
    // one where waiting actually helps — so it names the wait rather than
    // reading as a generic outage.
    if (res.status === 503) {
      const seconds = estimatedTime ? Math.ceil(estimatedTime) : null;
      return jsonError(
        seconds
          ? `The model is loading, please try again in ${seconds} seconds.`
          : 'The model is loading on Hugging Face. Try again in a moment.',
        503,
      );
    }
    if (res.status === 429) {
      return jsonError(
        'Hugging Face is rate limiting this token. Wait a minute and try again, or upgrade the account.',
        429,
      );
    }
    if (res.status === 401) {
      return jsonError(
        'Hugging Face rejected the token. Check HUGGINGFACE_API_KEY on the server.',
        401,
      );
    }
    // 403 has a specific, non-obvious cause worth naming outright.
    if (res.status === 403) {
      return jsonError(
        'Hugging Face refused this token. A read token also needs the fine-grained permission "Make calls to Inference Providers" — enable it at huggingface.co/settings/tokens.',
        403,
      );
    }
    if (res.status === 404) {
      return jsonError(
        `Hugging Face has no model at "${modelId}". Check HUGGINGFACE_MODEL_ID.`,
        502,
      );
    }
    return jsonError(
      detail || `Hugging Face could not generate the image (HTTP ${res.status}).`,
      502,
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength === 0) {
    return jsonError('Hugging Face returned an empty image. Try again.', 502);
  }

  // Trust the response's own type where it gives one — FLUX returns PNG, but
  // other models on this endpoint return JPEG, and mislabelling breaks the
  // data URI silently in some browsers.
  const contentType = res.headers.get('content-type') ?? '';
  const mime = contentType.startsWith('image/') ? contentType : 'image/png';

  return jsonOk({
    imageUrl: `data:${mime};base64,${buffer.toString('base64')}`,
  });
}

/**
 * Agnes and Gemini, through the providers the Content Studio already uses.
 *
 * They return raw bytes too, so the result is converted to the same data-URI
 * shape Hugging Face produces — the client stays unaware of which provider ran.
 */
async function generateWithProvider(
  provider: ImageGenerationProvider,
  label: string,
  { prompt, negativePrompt }: ImageRequest,
) {
  if (!provider.isConfigured()) {
    return jsonError(
      `${label} is not configured on this deployment. Add ${provider.credentialEnv} to the server environment.`,
      503,
    );
  }

  try {
    const images = await provider.generateImage({
      prompt,
      ...(negativePrompt ? { negativePrompt } : {}),
      aspectRatio: '1:1',
      width: 1024,
      height: 1024,
      numberOfImages: 1,
      style: 'PHOTOREAL',
    });

    const first = images[0];
    if (!first) {
      return jsonError(`${label} returned no image. Try rewording the prompt.`, 502);
    }

    return jsonOk({
      imageUrl: `data:${first.mimeType};base64,${first.data.toString('base64')}`,
    });
  } catch (err) {
    // Providers write messages meant to be read, and carry their own status —
    // surfaced directly rather than collapsed into a generic failure.
    if (err instanceof ImageProviderError) {
      return jsonError(err.message, err.status >= 400 ? err.status : 502);
    }
    throw err;
  }
}
