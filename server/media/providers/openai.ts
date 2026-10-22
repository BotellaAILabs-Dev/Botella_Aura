import { httpRequest } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { AspectRatioKey } from '@/lib/platforms';
import {
  ImageProviderError,
  type GeneratedImage,
  type ImageEditParams,
  type ImageGenerationParams,
  type ImageGenerationProvider,
} from '@/server/media/types';

/**
 * OpenAI Images (gpt-image-1).
 *
 * Returns base64 image data inline, so there is no second fetch and nothing
 * expires between generation and storage. Sizes are fixed by the API, hence the
 * narrow ratio list: 1024x1024, 1024x1536 (portrait) and 1536x1024 (landscape).
 * 9:16 is not offered natively, so the service substitutes the nearest — see
 * server/media/aspect.ts.
 */
const ENDPOINT = 'https://api.openai.com/v1/images/generations';
const DEFAULT_MODEL = 'gpt-image-1';
/** Image generation is slow; a short timeout produces false failures. */
const TIMEOUT_MS = 120_000;

/** The exact `size` strings this API accepts, per ratio. */
const SIZE_FOR_RATIO: Partial<Record<AspectRatioKey, string>> = {
  '1:1': '1024x1024',
  '4:5': '1024x1536',
  '16:9': '1536x1024',
};

interface OpenAiImageResponse {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: { message?: string; type?: string; code?: string };
}

export const openAiImageProvider: ImageGenerationProvider = {
  id: 'OPENAI',
  label: 'OpenAI',
  model: process.env.OPENAI_IMAGE_MODEL || DEFAULT_MODEL,
  description:
    'Strong prompt adherence and legible in-image text. The safest default for ' +
    'business graphics.',
  credentialEnv: 'OPENAI_API_KEY',
  supportedRatios: ['1:1', '4:5', '16:9'],
  maxImagesPerRequest: 4,

  isConfigured() {
    return Boolean(process.env.OPENAI_API_KEY);
  },

  /** gpt-image models edit through /v1/images/edits; DALL·E 3 cannot. */
  canEdit() {
    return (process.env.OPENAI_IMAGE_MODEL || DEFAULT_MODEL).startsWith('gpt-image');
  },

  async editImage(params: ImageEditParams): Promise<GeneratedImage> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new ImageProviderError('OPENAI', 'OpenAI is not configured on this deployment.', 503, false);
    }
    const size = SIZE_FOR_RATIO[params.aspectRatio] ?? '1024x1024';
    const model = process.env.OPENAI_IMAGE_MODEL || DEFAULT_MODEL;
    const ext = params.image.mimeType === 'image/jpeg' ? 'jpg' : params.image.mimeType === 'image/webp' ? 'webp' : 'png';
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', params.prompt);
    form.append('size', size);
    form.append('quality', 'high');
    form.append('n', '1');
    form.append('image', new Blob([new Uint8Array(params.image.data)], { type: params.image.mimeType }), `image.${ext}`);

    const res = await httpRequest('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      timeoutMs: TIMEOUT_MS,
      retries: 0,
    });
    const payload = (await res.json().catch(() => ({}))) as OpenAiImageResponse;
    if (!res.ok) {
      logger.error('openai image edit failed', { status: res.status, code: payload.error?.code, type: payload.error?.type });
      throw new ImageProviderError(
        'OPENAI',
        describeFailure(res.status, payload.error?.message),
        res.status === 429 ? 429 : 502,
        res.status === 429 || res.status >= 500,
      );
    }
    const [width, height] = size.split('x').map(Number) as [number, number];
    for (const item of payload.data ?? []) {
      const bytes = await readImage(item);
      if (bytes) return { data: bytes, mimeType: 'image/png', width, height, metadata: { model, size, edit: true } };
    }
    throw new ImageProviderError('OPENAI', 'OpenAI accepted the edit but returned no image. Try rewording the instruction.', 502);
  },

  async generateImage(params: ImageGenerationParams): Promise<GeneratedImage[]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new ImageProviderError(
        'OPENAI',
        'OpenAI is not configured on this deployment.',
        503,
        false,
      );
    }

    const size = SIZE_FOR_RATIO[params.aspectRatio] ?? '1024x1024';
    const model = process.env.OPENAI_IMAGE_MODEL || DEFAULT_MODEL;

    const res = await httpRequest(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt: params.prompt,
        n: Math.min(params.numberOfImages, 4),
        size,
        quality: 'high',
        // Explicit: base64 back means nothing to re-fetch and nothing to expire.
        output_format: 'png',
      }),
      timeoutMs: TIMEOUT_MS,
      // The service retries across providers; retrying a paid generation
      // in-place would silently double the cost of one click.
      retries: 0,
    });

    const payload = (await res.json().catch(() => ({}))) as OpenAiImageResponse;
    if (!res.ok) {
      // Logged, never returned: OpenAI error bodies echo the prompt back and
      // can carry organisation identifiers.
      logger.error('openai image generation failed', {
        status: res.status,
        code: payload.error?.code,
        type: payload.error?.type,
      });
      throw new ImageProviderError(
        'OPENAI',
        describeFailure(res.status, payload.error?.message),
        res.status === 429 ? 429 : 502,
        res.status === 429 || res.status >= 500,
      );
    }

    const [width, height] = size.split('x').map(Number) as [number, number];
    const images: GeneratedImage[] = [];
    for (const item of payload.data ?? []) {
      const bytes = await readImage(item);
      if (!bytes) continue;
      images.push({
        data: bytes,
        mimeType: 'image/png',
        width,
        height,
        ...(item.url ? { sourceUrl: item.url } : {}),
        ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
        metadata: { model, size },
      });
    }

    if (images.length === 0) {
      throw new ImageProviderError(
        'OPENAI',
        'OpenAI accepted the request but returned no image. Try rewording the prompt.',
        502,
      );
    }
    return images;
  },
};

/**
 * gpt-image-1 always answers with base64; the `url` branch covers older models
 * a deployment may have pinned via OPENAI_IMAGE_MODEL.
 */
async function readImage(item: {
  b64_json?: string;
  url?: string;
}): Promise<Buffer | null> {
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (!item.url) return null;
  const res = await httpRequest(item.url, { timeoutMs: 30_000, retries: 1 });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

/** Map a status to something the user can act on, without leaking the body. */
function describeFailure(status: number, message?: string): string {
  if (status === 401) {
    return 'OpenAI rejected the API key. Check OPENAI_API_KEY on the deployment.';
  }
  if (status === 429) {
    return 'OpenAI is rate-limiting image generation right now. Wait a moment or switch model.';
  }
  if (status === 400 && message?.toLowerCase().includes('safety')) {
    return 'OpenAI declined this prompt on safety grounds. Edit the prompt and try again.';
  }
  if (status === 400) {
    return 'OpenAI rejected this prompt. Try rewording it or picking another format.';
  }
  return `OpenAI could not generate the image (HTTP ${status}).`;
}
