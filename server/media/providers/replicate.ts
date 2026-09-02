import { httpRequest } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { AspectRatioKey } from '@/lib/platforms';
import {
  ImageProviderError,
  type GeneratedImage,
  type ImageGenerationParams,
  type ImageGenerationProvider,
} from '@/server/media/types';

/**
 * Replicate — the escape hatch provider.
 *
 * Replicate hosts hundreds of image models behind one API, so this is how a
 * deployment reaches a model we have not written a dedicated provider for:
 * point REPLICATE_IMAGE_MODEL at any model whose input schema takes `prompt`
 * and `aspect_ratio`, and it works with no code change.
 *
 * Replicate is asynchronous by default: POST creates a prediction, and you poll
 * until it succeeds. `Prefer: wait` asks it to hold the connection open for up
 * to 60s instead, which covers most generations in one request; the polling
 * loop below is the fallback for the ones it does not, and is what stops a slow
 * model from surfacing as an empty result.
 */
const ENDPOINT = 'https://api.replicate.com/v1/predictions';
const DEFAULT_MODEL = 'black-forest-labs/flux-1.1-pro';
const WAIT_SECONDS = 60;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 180_000;

const SUPPORTED: AspectRatioKey[] = ['1:1', '4:5', '16:9', '9:16'];

interface Prediction {
  id?: string;
  status?: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string | string[];
  error?: string;
  urls?: { get?: string };
}

export const replicateImageProvider: ImageGenerationProvider = {
  id: 'REPLICATE',
  label: 'Replicate',
  model: process.env.REPLICATE_IMAGE_MODEL || DEFAULT_MODEL,
  description:
    'Runs any hosted image model. Point REPLICATE_IMAGE_MODEL at the one you ' +
    'want — no code change needed.',
  credentialEnv: 'REPLICATE_API_TOKEN',
  supportedRatios: SUPPORTED,
  maxImagesPerRequest: 4,

  isConfigured() {
    return Boolean(process.env.REPLICATE_API_TOKEN);
  },

  async generateImage(params: ImageGenerationParams): Promise<GeneratedImage[]> {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) {
      throw new ImageProviderError(
        'REPLICATE',
        'Replicate is not configured on this deployment.',
        503,
        false,
      );
    }

    const model = process.env.REPLICATE_IMAGE_MODEL || DEFAULT_MODEL;
    const count = Math.min(params.numberOfImages, 4);

    /**
     * Fan out in PARALLEL, not in sequence.
     *
     * Each prediction is a create-then-poll cycle that can run to a minute on
     * its own. Four of those back to back reliably outlives a serverless
     * function budget and gets the run killed mid-flight; four at once costs
     * roughly the time of one. allSettled keeps partial success working.
     */
    const settled = await Promise.allSettled(
      Array.from({ length: count }, async () => {
        const urls = await runPrediction(token, model, params);
        const produced: GeneratedImage[] = [];
        for (const url of urls) {
          const bytes = await download(url);
          if (!bytes) continue;
          produced.push({
            data: bytes.data,
            mimeType: bytes.mimeType,
            width: params.width,
            height: params.height,
            sourceUrl: url,
            metadata: { model, aspectRatio: params.aspectRatio },
          });
        }
        return produced;
      }),
    );

    const images: GeneratedImage[] = [];
    let lastError: ImageProviderError | null = null;
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        images.push(...outcome.value);
      } else {
        lastError =
          outcome.reason instanceof ImageProviderError
            ? outcome.reason
            : new ImageProviderError('REPLICATE', 'Replicate request failed.');
      }
    }

    if (images.length === 0) {
      throw (
        lastError ??
        new ImageProviderError('REPLICATE', 'Replicate returned no image.')
      );
    }
    return images;
  },
};

/** Create a prediction and return the output image URL(s). */
async function runPrediction(
  token: string,
  model: string,
  params: ImageGenerationParams,
): Promise<string[]> {
  const res = await httpRequest(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      // Hold the connection instead of returning immediately, when it can.
      prefer: `wait=${WAIT_SECONDS}`,
    },
    body: JSON.stringify({
      model,
      input: {
        prompt: params.prompt,
        aspect_ratio: params.aspectRatio,
        output_format: 'png',
        ...(params.negativePrompt
          ? { negative_prompt: params.negativePrompt }
          : {}),
      },
    }),
    timeoutMs: (WAIT_SECONDS + 15) * 1000,
    retries: 0,
  });

  const payload = (await res.json().catch(() => ({}))) as Prediction;
  if (!res.ok) {
    logger.error('replicate prediction failed', {
      status: res.status,
      model,
    });
    throw new ImageProviderError(
      'REPLICATE',
      describeFailure(res.status),
      res.status === 429 ? 429 : 502,
      res.status === 429 || res.status >= 500,
    );
  }

  const finished = await settle(token, payload);
  if (finished.status !== 'succeeded') {
    throw new ImageProviderError(
      'REPLICATE',
      finished.status === 'canceled'
        ? 'The Replicate prediction was canceled.'
        : 'Replicate could not generate this image. Try another model or reword the prompt.',
      502,
    );
  }
  const output = finished.output;
  if (!output) return [];
  return (Array.isArray(output) ? output : [output]).filter(
    (u): u is string => typeof u === 'string' && u.startsWith('http'),
  );
}

/** Poll until the prediction leaves a running state, or we run out of budget. */
async function settle(token: string, initial: Prediction): Promise<Prediction> {
  let current = initial;
  const pollUrl = current.urls?.get ?? (current.id ? `${ENDPOINT}/${current.id}` : null);
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (
    (current.status === 'starting' || current.status === 'processing') &&
    pollUrl
  ) {
    if (Date.now() > deadline) {
      throw new ImageProviderError(
        'REPLICATE',
        'Replicate is taking longer than expected. Try again or switch model.',
        504,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const res = await httpRequest(pollUrl, {
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: 15_000,
      retries: 1,
    });
    if (!res.ok) {
      throw new ImageProviderError(
        'REPLICATE',
        `Replicate stopped reporting on this generation (HTTP ${res.status}).`,
        502,
      );
    }
    current = (await res.json()) as Prediction;
  }
  return current;
}

async function download(
  url: string,
): Promise<{ data: Buffer; mimeType: string } | null> {
  const res = await httpRequest(url, { timeoutMs: 30_000, retries: 1 });
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength === 0) return null;
  return {
    data: buffer,
    mimeType: (res.headers.get('content-type') || 'image/png').split(';')[0]!.trim(),
  };
}

function describeFailure(status: number): string {
  if (status === 401) {
    return 'Replicate rejected the API token. Check REPLICATE_API_TOKEN on the deployment.';
  }
  if (status === 402) {
    return 'The Replicate account has no remaining credit. Top it up or switch model.';
  }
  if (status === 404) {
    return 'That Replicate model was not found. Check REPLICATE_IMAGE_MODEL.';
  }
  if (status === 429) {
    return 'Replicate is rate-limiting right now. Wait a moment or switch model.';
  }
  return `Replicate could not generate the image (HTTP ${status}).`;
}
