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
 * Stability AI (Stable Image Core), v2beta.
 *
 * Two quirks shape this file. The API takes multipart/form-data rather than
 * JSON, and it generates exactly ONE image per call — so several variations
 * mean several sequential calls, which is why the loop below stops at the first
 * hard failure instead of hammering a provider that has started rejecting us.
 *
 * It is also the only provider here that takes a first-class negative prompt,
 * which is why negativePrompt exists on the shared params type at all.
 */
const ENDPOINT = 'https://api.stability.ai/v2beta/stable-image/generate/core';
const TIMEOUT_MS = 90_000;

const SUPPORTED: AspectRatioKey[] = ['1:1', '4:5', '16:9', '9:16'];

export const stabilityImageProvider: ImageGenerationProvider = {
  id: 'STABILITY',
  label: 'Stability AI',
  model: process.env.STABILITY_IMAGE_MODEL || 'stable-image-core',
  description:
    'Fast and inexpensive, with fine-grained negative prompting for things you ' +
    'want kept out of the frame.',
  credentialEnv: 'STABILITY_API_KEY',
  supportedRatios: SUPPORTED,
  // One image per call; the service fans out and this caps the fan-out.
  maxImagesPerRequest: 4,

  isConfigured() {
    return Boolean(process.env.STABILITY_API_KEY);
  },

  async generateImage(params: ImageGenerationParams): Promise<GeneratedImage[]> {
    const key = process.env.STABILITY_API_KEY;
    if (!key) {
      throw new ImageProviderError(
        'STABILITY',
        'Stability AI is not configured on this deployment.',
        503,
        false,
      );
    }

    const count = Math.min(params.numberOfImages, 4);

    /**
     * Fan out in PARALLEL, not in sequence.
     *
     * This API generates exactly one image per call, so four variations means
     * four round-trips. Run one after another that is 4x the wall-clock, which
     * is what pushes a generation past a serverless function's budget and gets
     * it killed. Run together, four variations cost roughly the time of one.
     *
     * allSettled rather than all: one failure out of four must still return the
     * other three (the service treats partial success as success).
     */
    const settled = await Promise.allSettled(
      Array.from({ length: count }, () => generateOne(key, params)),
    );

    const images: GeneratedImage[] = [];
    let lastError: ImageProviderError | null = null;
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        images.push(outcome.value);
      } else {
        lastError =
          outcome.reason instanceof ImageProviderError
            ? outcome.reason
            : new ImageProviderError('STABILITY', 'Stability AI request failed.');
      }
    }

    if (images.length === 0) {
      throw (
        lastError ??
        new ImageProviderError('STABILITY', 'Stability AI returned no image.')
      );
    }
    return images;
  },
};

async function generateOne(
  key: string,
  params: ImageGenerationParams,
): Promise<GeneratedImage> {
  const form = new FormData();
  form.append('prompt', params.prompt);
  form.append('aspect_ratio', params.aspectRatio);
  form.append('output_format', 'png');
  if (params.negativePrompt) {
    form.append('negative_prompt', params.negativePrompt);
  }

  const res = await httpRequest(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      // image/* asks for raw bytes back instead of a base64 JSON envelope.
      accept: 'image/*',
    },
    body: form,
    timeoutMs: TIMEOUT_MS,
    retries: 0,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.error('stability image generation failed', {
      status: res.status,
      detail: detail.slice(0, 200),
    });
    throw new ImageProviderError(
      'STABILITY',
      describeFailure(res.status),
      res.status === 429 ? 429 : 502,
      res.status === 429 || res.status >= 500,
    );
  }

  const contentType = res.headers.get('content-type') || 'image/png';
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new ImageProviderError('STABILITY', 'Stability AI returned an empty image.');
  }

  return {
    data: buffer,
    mimeType: contentType.split(';')[0]!.trim(),
    width: params.width,
    height: params.height,
    metadata: {
      model: process.env.STABILITY_IMAGE_MODEL || 'stable-image-core',
      aspectRatio: params.aspectRatio,
      ...(res.headers.get('seed') ? { seed: res.headers.get('seed') } : {}),
    },
  };
}

function describeFailure(status: number): string {
  if (status === 401) {
    return 'Stability AI rejected the API key. Check STABILITY_API_KEY on the deployment.';
  }
  if (status === 402) {
    return 'The Stability AI account is out of credits. Top it up or switch model.';
  }
  if (status === 403) {
    return 'Stability AI declined this prompt on content-policy grounds. Reword it.';
  }
  if (status === 429) {
    return 'Stability AI is rate-limiting right now. Wait a moment or switch model.';
  }
  return `Stability AI could not generate the image (HTTP ${status}).`;
}
