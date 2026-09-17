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
 * Hugging Face Inference — FLUX.1-schnell by default.
 *
 * Unlike every other provider here, the response body IS the image. There is
 * no JSON envelope, no `data[]`, no base64 field: a success is raw bytes and a
 * failure is text that may or may not be JSON. That single difference drives
 * most of what follows.
 *
 * It is the only provider in this registry with a usable free tier, which
 * makes it the practical default for a workspace that has not set up billing
 * anywhere else.
 */
const DEFAULT_MODEL = 'black-forest-labs/FLUX.1-schnell';
const DEFAULT_BASE = 'https://api-inference.huggingface.co/models';
/** Image generation is slow, and a cold model slower still. */
const TIMEOUT_MS = 120_000;

/**
 * All four shapes.
 *
 * The Inference API takes explicit `width` and `height` for text-to-image
 * models, so the canonical size for each ratio is passed straight through
 * rather than the provider being pinned to squares. FLUX generates at
 * arbitrary dimensions.
 */
const SUPPORTED: AspectRatioKey[] = ['1:1', '4:5', '16:9', '9:16'];

function apiKey(): string | undefined {
  return process.env.HUGGINGFACE_API_KEY;
}

function baseUrl(): string {
  return (process.env.HUGGINGFACE_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
}

function resolveModel(): string {
  return process.env.HUGGINGFACE_MODEL_ID || DEFAULT_MODEL;
}

export const huggingFaceImageProvider: ImageGenerationProvider = {
  id: 'HUGGINGFACE',
  label: 'Hugging Face',
  model: resolveModel(),
  description:
    'FLUX.1-schnell on a free tier. Fast once warm; the first call after an ' +
    'idle spell waits for the model to load.',
  credentialEnv: 'HUGGINGFACE_API_KEY',
  supportedRatios: SUPPORTED,
  /**
   * Four per request, delivered by fanning out below.
   *
   * This endpoint returns exactly one image per call — there is no `n` — so
   * variations are separate round trips, as they are for Stability, Google and
   * Agnes.
   */
  maxImagesPerRequest: 4,

  isConfigured() {
    return Boolean(apiKey());
  },

  async generateImage(params: ImageGenerationParams): Promise<GeneratedImage[]> {
    const key = apiKey();
    if (!key) {
      throw new ImageProviderError(
        'HUGGINGFACE',
        'Hugging Face is not configured on this deployment. Add HUGGINGFACE_API_KEY.',
        503,
        false,
      );
    }

    /**
     * Fan out in PARALLEL.
     *
     * Four variations together cost roughly the wall-clock of one; in sequence
     * they are four times as long, which is what pushes a generation past a
     * serverless function's budget and gets it killed.
     *
     * allSettled, not all: three good images out of four is a good result and
     * the pipeline above reports partial success. fanOutFailure preserves a
     * real provider error — crucially its retryability, so a cold-model 503
     * stays retryable while a bad token does not.
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

    if (images.length === 0) {
      throw fanOutFailure('HUGGINGFACE', 'Hugging Face', lastError);
    }
    return images;
  },
};

/** One image, one call. */
async function generateOne(
  key: string,
  params: ImageGenerationParams,
): Promise<GeneratedImage> {
  const model = resolveModel();
  const endpoint = `${baseUrl()}/${model}`;

  const res = await httpRequest(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: params.prompt,
      parameters: {
        width: params.width,
        height: params.height,
        // No negative-prompt field is guaranteed across models on this
        // endpoint, so it is only sent when there is one to send.
        ...(params.negativePrompt
          ? { negative_prompt: params.negativePrompt }
          : {}),
      },
    }),
    timeoutMs: TIMEOUT_MS,
    // The service retries across providers; retrying a paid generation
    // in-place would silently double the cost of one click.
    retries: 0,
  });

  if (!res.ok) {
    /**
     * Read the failure as TEXT, not JSON.
     *
     * A success here is bytes, and a failure may be JSON, HTML or a bare
     * string. Calling .json() on an HTML error page throws, and the user would
     * be shown a parser message instead of the reason they failed.
     */
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

    logger.error('huggingface image generation failed', {
      status: res.status,
      endpoint,
      model,
      detail: detail.slice(0, 200),
    });
    throw failure(res.status, model, detail, estimatedTime);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new ImageProviderError(
      'HUGGINGFACE',
      'Hugging Face returned an empty image. Try again.',
      502,
    );
  }

  // Trust the response's own type where it gives one: FLUX returns PNG, but
  // other models on this endpoint return JPEG, and a wrong mime type is a
  // silent failure at publish time.
  const contentType = res.headers.get('content-type') ?? '';
  const mimeType = contentType.startsWith('image/') ? contentType : 'image/png';

  return {
    data: buffer,
    mimeType,
    width: params.width,
    height: params.height,
    metadata: { model, size: `${params.width}x${params.height}` },
  };
}

function failure(
  status: number,
  model: string,
  detail: string,
  estimatedTime: number | null,
): ImageProviderError {
  /**
   * A cold model is the most common failure on this endpoint and the only one
   * where waiting genuinely helps — so it names the wait and stays RETRYABLE,
   * which lets the job layer try again rather than failing the run outright.
   */
  if (status === 503) {
    const seconds = estimatedTime ? Math.ceil(estimatedTime) : null;
    return new ImageProviderError(
      'HUGGINGFACE',
      seconds
        ? `The model is loading, please try again in ${seconds} seconds.`
        : 'The model is loading on Hugging Face. Try again in a moment.',
      503,
      true,
    );
  }
  if (status === 429) {
    return new ImageProviderError(
      'HUGGINGFACE',
      'Hugging Face is rate limiting this token. Wait a minute and try again, or upgrade the account.',
      429,
      true,
    );
  }
  if (status === 401) {
    return new ImageProviderError(
      'HUGGINGFACE',
      'Hugging Face rejected the token. Check HUGGINGFACE_API_KEY on the deployment.',
      401,
      false,
    );
  }
  /**
   * 403 has a specific, non-obvious cause: a token can be valid, have the read
   * role, and still be refused because the fine-grained permission for
   * Inference Providers was never enabled. Saying "forbidden" would send
   * someone to regenerate a token that was never the problem.
   */
  if (status === 403) {
    return new ImageProviderError(
      'HUGGINGFACE',
      'Hugging Face refused this token. A read token also needs the fine-grained permission “Make calls to Inference Providers” — enable it at huggingface.co/settings/tokens.',
      403,
      false,
    );
  }
  if (status === 404) {
    return new ImageProviderError(
      'HUGGINGFACE',
      `Hugging Face has no model at “${model}”. Check HUGGINGFACE_MODEL_ID.`,
      502,
      false,
    );
  }
  return new ImageProviderError(
    'HUGGINGFACE',
    detail || `Hugging Face could not generate the image (HTTP ${status}).`,
    502,
    status >= 500,
  );
}
