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
 * Google Imagen, via the Generative Language REST API.
 *
 * No SDK, matching how server/ai/claude.ts already talks to Gemini — one fetch
 * keeps the dependency surface flat. Imagen takes an aspect ratio directly
 * rather than a pixel size and returns base64 inline, so nothing expires
 * between generation and storage.
 *
 * Reuses the SAME credential as the text side (GEMINI_API_KEY /
 * GOOGLE_AI_API_KEY): a workspace that has already enabled Gemini for content
 * should not have to configure Google twice to draw a picture.
 */
const DEFAULT_MODEL = 'imagen-4.0-generate-001';
const TIMEOUT_MS = 120_000;

/** Imagen's own ratio vocabulary. It happens to match ours exactly. */
const SUPPORTED: AspectRatioKey[] = ['1:1', '4:5', '16:9', '9:16'];

interface ImagenResponse {
  predictions?: Array<{
    bytesBase64Encoded?: string;
    mimeType?: string;
    raiFilteredReason?: string;
  }>;
  error?: { message?: string; status?: string };
}

function apiKey(): string | undefined {
  return (
    process.env.GOOGLE_AI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GEMINI_API_KEY
  );
}

export const googleImageProvider: ImageGenerationProvider = {
  id: 'GOOGLE',
  label: 'Google Imagen',
  model: process.env.GOOGLE_IMAGE_MODEL || DEFAULT_MODEL,
  description:
    'Photorealistic output and native support for every format, including ' +
    '9:16 stories.',
  credentialEnv: 'GOOGLE_AI_API_KEY',
  supportedRatios: SUPPORTED,
  maxImagesPerRequest: 4,

  isConfigured() {
    return Boolean(apiKey());
  },

  async generateImage(params: ImageGenerationParams): Promise<GeneratedImage[]> {
    const key = apiKey();
    if (!key) {
      throw new ImageProviderError(
        'GOOGLE',
        'Google image generation is not configured on this deployment.',
        503,
        false,
      );
    }

    const model = process.env.GOOGLE_IMAGE_MODEL || DEFAULT_MODEL;
    const res = await httpRequest(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify({
          instances: [
            {
              prompt: params.prompt,
              ...(params.negativePrompt
                ? { negativePrompt: params.negativePrompt }
                : {}),
            },
          ],
          parameters: {
            sampleCount: Math.min(params.numberOfImages, 4),
            aspectRatio: params.aspectRatio,
            // Block only what a business account would object to publishing;
            // anything stricter refuses ordinary marketing imagery.
            safetySetting: 'block_medium_and_above',
            personGeneration: 'allow_adult',
          },
        }),
        timeoutMs: TIMEOUT_MS,
        retries: 0,
      },
    );

    const payload = (await res.json().catch(() => ({}))) as ImagenResponse;
    if (!res.ok) {
      logger.error('google image generation failed', {
        status: res.status,
        code: payload.error?.status,
      });
      throw new ImageProviderError(
        'GOOGLE',
        describeFailure(res.status),
        res.status === 429 ? 429 : 502,
        res.status === 429 || res.status >= 500,
      );
    }

    const images: GeneratedImage[] = [];
    let filtered = 0;
    for (const prediction of payload.predictions ?? []) {
      if (!prediction.bytesBase64Encoded) {
        if (prediction.raiFilteredReason) filtered++;
        continue;
      }
      images.push({
        data: Buffer.from(prediction.bytesBase64Encoded, 'base64'),
        mimeType: prediction.mimeType || 'image/png',
        width: params.width,
        height: params.height,
        metadata: { model, aspectRatio: params.aspectRatio },
      });
    }

    if (images.length === 0) {
      throw new ImageProviderError(
        'GOOGLE',
        filtered > 0
          ? 'Google’s safety filter blocked every image for this prompt. Reword it and try again.'
          : 'Google returned no image for this prompt. Try rewording it.',
        502,
      );
    }
    return images;
  },
};

function describeFailure(status: number): string {
  if (status === 401 || status === 403) {
    return 'Google rejected the API key. Check GOOGLE_AI_API_KEY on the deployment.';
  }
  if (status === 429) {
    return 'Google is rate-limiting image generation right now. Wait a moment or switch model.';
  }
  if (status === 400) {
    return 'Google rejected this prompt. Try rewording it or picking another format.';
  }
  return `Google could not generate the image (HTTP ${status}).`;
}
