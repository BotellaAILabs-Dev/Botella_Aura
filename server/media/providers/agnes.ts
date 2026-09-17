import { httpRequest } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { AspectRatioKey } from '@/lib/platforms';
import {
  ImageProviderError,
  fanOutFailure,
  type GeneratedImage,
  type ImageGenerationParams,
  type ImageGenerationProvider,
} from '@/server/media/types';

/**
 * Agnes AI images.
 *
 * The request shape is OpenAI-compatible — POST /images/generations with
 * { model, prompt, n, size } and a Bearer key — so this provider is deliberately
 * close to server/media/providers/openai.ts. Where it differs is documented
 * below rather than silently.
 *
 * RATIOS: ONE, ON PURPOSE
 * -----------------------
 * Only 1024x1024 is declared, because that is the only size there is evidence
 * for. Declaring ratios the API may not accept would turn a wrong guess into a
 * failed generation for anyone who picks 9:16; declaring one means the format
 * resolver substitutes the nearest supported shape and REPORTS the substitution
 * (see server/media/aspect.ts), which is a visibly different and much better
 * outcome. Widening this is a one-line change once the accepted sizes are
 * confirmed against a working endpoint.
 */
/**
 * Note the /api/v1 prefix.
 *
 * Probing the host showed every path under /v1 returning 404, while the same
 * paths under /api/v1 return 401 — so the routes live there and /v1 is a
 * plausible-looking guess that can never work. A 404 reads as "this product is
 * broken"; pointing at the real routes turns it into an ordinary auth error
 * that names what to fix.
 */
const DEFAULT_BASE_URL = 'https://api.agnes-ai.com/api/v1';
const DEFAULT_MODEL = 'agnes-image-2.0-flash';
/** Image generation is slow; a short timeout produces false failures. */
const TIMEOUT_MS = 120_000;

const SUPPORTED: AspectRatioKey[] = ['1:1'];

/** The one size this API is known to accept. */
const SIZE = '1024x1024';

interface AgnesImageResponse {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: { message?: string; code?: string } | string;
  message?: string;
  code?: string;
}

function apiKey(): string | undefined {
  return process.env.AGNES_API_KEY;
}

function baseUrl(): string {
  return (process.env.AGNES_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function resolveModel(): string {
  return process.env.AGNES_IMAGE_MODEL || DEFAULT_MODEL;
}

export const agnesImageProvider: ImageGenerationProvider = {
  id: 'AGNES',
  label: 'Agnes AI',
  model: resolveModel(),
  description:
    'Square 1024px output. Other formats are produced at the nearest supported ' +
    'shape and flagged as substituted.',
  credentialEnv: 'AGNES_API_KEY',
  supportedRatios: SUPPORTED,
  /**
   * Four per request, delivered by fanning out below.
   *
   * There is no evidence this API honours `n` above 1, and asking for more
   * than a model returns is what made the Google provider silently hand back
   * one image for a four-variation request. Issuing one call per variation
   * sidesteps the question entirely and works either way.
   */
  maxImagesPerRequest: 4,

  isConfigured() {
    return Boolean(apiKey());
  },

  async generateImage(params: ImageGenerationParams): Promise<GeneratedImage[]> {
    const key = apiKey();
    if (!key) {
      throw new ImageProviderError(
        'AGNES',
        'Agnes AI is not configured on this deployment. Add AGNES_API_KEY.',
        503,
        false,
      );
    }

    /**
     * Fan out in PARALLEL, matching the Stability and Google providers.
     *
     * Four variations run together cost roughly the wall-clock of one; run in
     * sequence they are four times as long, which is what pushes a generation
     * past a serverless function's budget and gets it killed.
     *
     * allSettled, not all: three good images out of four is a good result, and
     * the pipeline above already reports partial success. Only a total failure
     * rethrows, so the user still gets a real reason.
     */
    const count = Math.max(1, Math.min(params.numberOfImages, 4));
    const settled = await Promise.allSettled(
      Array.from({ length: count }, () => generateOne(key, params)),
    );

    const images: GeneratedImage[] = [];
    let lastError: unknown;
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') images.push(outcome.value);
      else lastError = outcome.reason;
    }

    // Keeps the real cause and the provider's own retryability. Inventing a
    // "try rewording it" here blames the prompt for a transport failure and,
    // because ImageProviderError defaults to retryable, parks the job in
    // QUEUED at 10% where nothing ever picks it up again.
    if (images.length === 0) throw fanOutFailure('AGNES', 'Agnes AI', lastError);
    return images;
  },
};

/** One image, one call. */
async function generateOne(
  key: string,
  params: ImageGenerationParams,
): Promise<GeneratedImage> {
  const model = resolveModel();
  const endpoint = `${baseUrl()}/images/generations`;

  // No negativePrompt field exists on this API, so it is folded into the
  // prompt rather than silently dropped.
  const prompt = params.negativePrompt
    ? `${params.prompt}\n\nAvoid: ${params.negativePrompt}`
    : params.prompt;

  const res = await httpRequest(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, prompt, n: 1, size: SIZE }),
    timeoutMs: TIMEOUT_MS,
    // The service retries across providers; retrying a paid generation
    // in-place would silently double the cost of one click.
    retries: 0,
  });

  const payload = (await res.json().catch(() => ({}))) as AgnesImageResponse;

  if (!res.ok) {
    const detail =
      (typeof payload.error === 'string'
        ? payload.error
        : payload.error?.message) ??
      payload.message ??
      '';
    // Logged, never returned: provider error bodies echo the prompt back.
    logger.error('agnes image generation failed', {
      status: res.status,
      endpoint,
      model,
      code: payload.code,
    });
    throw failure(res.status, endpoint, detail);
  }

  const item = payload.data?.[0];
  const bytes = await readImage(item);
  if (!bytes) {
    throw new ImageProviderError(
      'AGNES',
      'Agnes AI accepted the request but returned no image. Try rewording the prompt.',
      502,
    );
  }

  const [width, height] = SIZE.split('x').map(Number) as [number, number];
  return {
    data: bytes,
    mimeType: 'image/png',
    width,
    height,
    ...(item?.url ? { sourceUrl: item.url } : {}),
    ...(item?.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
    metadata: { model, size: SIZE },
  };
}

/** Inline base64 when offered, otherwise fetch the hosted URL once. */
async function readImage(
  item: { b64_json?: string; url?: string } | undefined,
): Promise<Buffer | null> {
  if (!item) return null;
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (!item.url) return null;
  try {
    const res = await httpRequest(item.url, {
      timeoutMs: 30_000,
      retries: 1,
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    // A hosted URL that cannot be fetched is a failed image, not a crash —
    // the caller turns an empty result into a message the user can act on.
    return null;
  }
}

function failure(
  status: number,
  endpoint: string,
  detail: string,
): ImageProviderError {
  if (status === 401 || status === 403) {
    return new ImageProviderError(
      'AGNES',
      'Agnes AI rejected the API key. Check AGNES_API_KEY on the deployment.',
      status,
      false,
    );
  }
  // A 404 here means the configured base URL has no such endpoint — most
  // often a wrong AGNES_API_BASE_URL. Naming the URL saves a debugging session.
  if (status === 404) {
    return new ImageProviderError(
      'AGNES',
      `Agnes AI has no endpoint at ${endpoint}. Check AGNES_API_BASE_URL and the model name.`,
      502,
      false,
    );
  }
  if (status === 429) {
    return new ImageProviderError(
      'AGNES',
      'Agnes AI is rate limiting or out of quota. Wait a moment or pick another model.',
      429,
      true,
    );
  }
  if (status === 400) {
    return new ImageProviderError(
      'AGNES',
      detail || 'Agnes AI rejected this prompt. Try rewording it.',
      400,
      false,
    );
  }
  return new ImageProviderError(
    'AGNES',
    detail || `Agnes AI could not generate the image (HTTP ${status}).`,
    502,
    status >= 500,
  );
}
