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
 * Google image generation, via the Generative Language REST API.
 *
 * No SDK, matching how server/ai/claude.ts already talks to Gemini — one fetch
 * keeps the dependency surface flat. Both model families take an aspect ratio
 * directly rather than a pixel size and return base64 inline, so nothing
 * expires between generation and storage.
 *
 * Reuses the SAME credential as the text side (GEMINI_API_KEY /
 * GOOGLE_AI_API_KEY): a workspace that has already enabled Gemini for content
 * should not have to configure Google twice to draw a picture.
 *
 * TWO INCOMPATIBLE FAMILIES LIVE BEHIND ONE PROVIDER
 * --------------------------------------------------
 * Google serves image generation through two entirely different APIs, and
 * which one a key can reach depends on how that key was provisioned:
 *
 *   imagen-*   → POST :predict         { instances, parameters }
 *                                      → predictions[].bytesBase64Encoded
 *   gemini-*   → POST :generateContent { contents, generationConfig }
 *                                      → candidates[].content.parts[].inlineData
 *
 * This provider used to hardcode the Imagen path and default to
 * `imagen-4.0-generate-001`. A standard Google AI Studio key cannot see any
 * Imagen model — listing /v1beta/models on one returns the gemini-*-image
 * family and no Imagen at all — so every generation failed with a bare
 * "HTTP 404", which reads like a broken deployment rather than a model that
 * was never reachable. The default is now a model such a key actually has,
 * and the request shape follows from the model name.
 */
const DEFAULT_MODEL = 'gemini-2.5-flash-image';
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

interface GenerateContentResponse {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType?: string; data?: string };
      }>;
    };
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

function apiKey(): string | undefined {
  return (
    process.env.GOOGLE_AI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GEMINI_API_KEY
  );
}

function resolveModel(): string {
  return process.env.GOOGLE_IMAGE_MODEL || DEFAULT_MODEL;
}

/** Which of the two APIs this model name belongs to. */
function isImagen(model: string): boolean {
  return model.startsWith('imagen');
}

export const googleImageProvider: ImageGenerationProvider = {
  id: 'GOOGLE',
  label: 'Google Imagen',
  model: resolveModel(),
  description:
    'Photorealistic output and native support for every format, including ' +
    '9:16 stories.',
  credentialEnv: 'GOOGLE_AI_API_KEY',
  supportedRatios: SUPPORTED,
  // Imagen draws up to four per call; the gemini-* image models return a
  // single image per request. Asking for more than the model can give would
  // report a shortfall the job then pointlessly retries.
  maxImagesPerRequest: isImagen(resolveModel()) ? 4 : 1,

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

    const model = resolveModel();
    return isImagen(model)
      ? predictImagen(model, key, params)
      : generateWithGemini(model, key, params);
  },
};

/** The imagen-* family: :predict, instances/parameters, predictions[] back. */
async function predictImagen(
  model: string,
  key: string,
  params: ImageGenerationParams,
): Promise<GeneratedImage[]> {
  const res = await httpRequest(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
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
  if (!res.ok) throw failure(res.status, payload.error, model);

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

  if (images.length === 0) throw emptyResult(filtered > 0);
  return images;
}

/**
 * The gemini-*-image family: :generateContent, and the image comes back as an
 * inlineData part alongside any commentary the model chose to write.
 *
 * responseModalities must include IMAGE or the model answers with prose
 * describing the picture it would have drawn.
 */
async function generateWithGemini(
  model: string,
  key: string,
  params: ImageGenerationParams,
): Promise<GeneratedImage[]> {
  // No negativePrompt field exists on this API; fold it into the prompt so the
  // instruction is not silently dropped.
  const prompt = params.negativePrompt
    ? `${params.prompt}\n\nAvoid: ${params.negativePrompt}`
    : params.prompt;

  const res = await httpRequest(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: params.aspectRatio },
        },
      }),
      timeoutMs: TIMEOUT_MS,
      retries: 0,
    },
  );

  const payload = (await res
    .json()
    .catch(() => ({}))) as GenerateContentResponse;
  if (!res.ok) throw failure(res.status, payload.error, model);

  const images: GeneratedImage[] = [];
  for (const candidate of payload.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (!part.inlineData?.data) continue;
      images.push({
        data: Buffer.from(part.inlineData.data, 'base64'),
        mimeType: part.inlineData.mimeType || 'image/png',
        width: params.width,
        height: params.height,
        metadata: { model, aspectRatio: params.aspectRatio },
      });
    }
  }

  if (images.length === 0) {
    const blocked =
      Boolean(payload.promptFeedback?.blockReason) ||
      (payload.candidates ?? []).some((c) => c.finishReason === 'SAFETY');
    throw emptyResult(blocked);
  }
  return images;
}

function emptyResult(blocked: boolean): ImageProviderError {
  return new ImageProviderError(
    'GOOGLE',
    blocked
      ? 'Google’s safety filter blocked every image for this prompt. Reword it and try again.'
      : 'Google returned no image for this prompt. Try rewording it.',
    502,
  );
}

function failure(
  status: number,
  error: { message?: string; status?: string } | undefined,
  model: string,
): ImageProviderError {
  logger.error('google image generation failed', {
    status,
    code: error?.status,
    model,
  });

  // A 429 is two different problems wearing the same status code, and the
  // difference decides whether retrying is worth anything. A burst limit
  // clears on its own; an exhausted plan quota does not, and retrying it just
  // spins until the client gives up with "this is taking longer than expected"
  // — which tells the user nothing about the fact that their key has no image
  // allowance. Google names the second case in the message body.
  if (status === 429) {
    const text = error?.message ?? '';
    const outOfQuota = /quota|billing|plan/i.test(text);
    return new ImageProviderError(
      'GOOGLE',
      outOfQuota
        ? 'This Google API key has no image-generation quota left. Image models on the Gemini API need billing enabled on the key — or pick another model above.'
        : 'Google is rate-limiting image generation right now. Wait a moment or switch model.',
      429,
      !outOfQuota,
    );
  }

  if (status === 401 || status === 403) {
    return new ImageProviderError(
      'GOOGLE',
      'Google rejected the API key. Check GOOGLE_AI_API_KEY on the deployment.',
      status,
      false,
    );
  }

  // 404 means the key cannot reach this model at all — most often an Imagen
  // model on a key that only has the gemini-* family. Name the variable to
  // change, because "HTTP 404" on its own sends people looking for a bug.
  if (status === 404) {
    return new ImageProviderError(
      'GOOGLE',
      `This Google API key cannot access the model “${model}”. Set GOOGLE_IMAGE_MODEL to one your key has (for example ${DEFAULT_MODEL}), or pick another model above.`,
      404,
      false,
    );
  }

  if (status === 400) {
    return new ImageProviderError(
      'GOOGLE',
      'Google rejected this prompt. Try rewording it or picking another format.',
      400,
      false,
    );
  }

  return new ImageProviderError(
    'GOOGLE',
    `Google could not generate the image (HTTP ${status}).`,
    502,
    status >= 500,
  );
}
