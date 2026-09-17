import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const httpRequest = vi.fn();
vi.mock('@/lib/http', () => ({ httpRequest: (...a: unknown[]) => httpRequest(...a) }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { googleImageProvider } from '@/server/media/providers/gemini';
import { ImageProviderError, type ImageGenerationParams } from '@/server/media/types';

/**
 * The Google image provider.
 *
 * Two things were wrong and both were invisible to the user. The provider
 * declared it could return a single image per request, which made
 * generateGraphics clamp a four-variation request down to one and then decline
 * to warn about it — "1 of 1" satisfies the shortfall check. And the request
 * shape has to follow the model family, because the two Google image APIs are
 * not interchangeable and a mismatch returns a bare 404.
 */

const PARAMS: ImageGenerationParams = {
  prompt: 'a photo of a coffee roastery',
  aspectRatio: '1:1',
  width: 1024,
  height: 1024,
  numberOfImages: 4,
  style: 'PHOTOREAL',
};

/** A 1x1 PNG, base64 — enough for the provider to hand back real bytes. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function geminiOk() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } },
      ],
    }),
  };
}

function errorResponse(status: number, message: string, code?: string) {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message, status: code } }),
  };
}


/**
 * Run a generation that is expected to fail and return the typed error.
 *
 * `.catch(e => e as ImageProviderError)` widens to a union with the success
 * type, so every assertion on `.message` then fails to typecheck.
 */
async function expectFailure(
  params: ImageGenerationParams,
): Promise<ImageProviderError> {
  try {
    await googleImageProvider.generateImage(params);
  } catch (e) {
    return e as ImageProviderError;
  }
  throw new Error('expected generateImage to reject, but it resolved');
}

beforeEach(() => {
  httpRequest.mockReset();
  process.env.GOOGLE_AI_API_KEY = 'test-key';
  delete process.env.GOOGLE_IMAGE_MODEL;
});
afterEach(() => {
  delete process.env.GOOGLE_AI_API_KEY;
});

describe('variation fan-out', () => {
  /**
   * The regression that matters: asking for four must actually attempt four.
   * Before the fix this provider advertised a per-request maximum of one, so
   * the caller never even asked for more.
   */
  it('advertises a per-request maximum that allows real variations', () => {
    expect(googleImageProvider.maxImagesPerRequest).toBeGreaterThan(1);
  });

  it('issues one call per requested variation and returns them all', async () => {
    httpRequest.mockImplementation(async () => geminiOk());

    const images = await googleImageProvider.generateImage(PARAMS);

    expect(httpRequest).toHaveBeenCalledTimes(4);
    expect(images).toHaveLength(4);
    for (const image of images) {
      expect(image.mimeType).toBe('image/png');
      expect(image.data.byteLength).toBeGreaterThan(0);
    }
  });

  it('uses the generateContent endpoint for the gemini-* family', async () => {
    httpRequest.mockImplementation(async () => geminiOk());
    await googleImageProvider.generateImage({ ...PARAMS, numberOfImages: 1 });

    const [url, options] = httpRequest.mock.calls[0]!;
    expect(String(url)).toContain(':generateContent');
    expect(String(url)).not.toContain(':predict');

    // responseModalities must ask for IMAGE, or the model replies with prose
    // describing the picture it would have drawn.
    const body = JSON.parse((options as { body: string }).body);
    expect(body.generationConfig.responseModalities).toContain('IMAGE');
  });

  /**
   * Three good images out of four is a good result, not a failure. The
   * pipeline above already reports partial success to the user.
   */
  it('keeps the images that succeeded when one call fails', async () => {
    let call = 0;
    httpRequest.mockImplementation(async () => {
      call += 1;
      return call === 2 ? errorResponse(500, 'backend error') : geminiOk();
    });

    const images = await googleImageProvider.generateImage(PARAMS);
    expect(images).toHaveLength(3);
  });

  it('throws the provider error when every call fails', async () => {
    httpRequest.mockImplementation(async () =>
      errorResponse(429, 'Quota exceeded for your plan', 'RESOURCE_EXHAUSTED'),
    );
    await expect(googleImageProvider.generateImage(PARAMS)).rejects.toBeInstanceOf(
      ImageProviderError,
    );
  });
});

describe('error mapping', () => {
  it('names the variable to change on a 404 instead of reporting HTTP 404', async () => {
    process.env.GOOGLE_IMAGE_MODEL = 'imagen-4.0-generate-001';
    httpRequest.mockImplementation(async () =>
      errorResponse(404, 'models/imagen-4.0-generate-001 is not found', 'NOT_FOUND'),
    );

    const error = await expectFailure({ ...PARAMS, numberOfImages: 1 });

    expect(error).toBeInstanceOf(ImageProviderError);
    expect(error.message).toContain('GOOGLE_IMAGE_MODEL');
    // A model this key cannot see will never appear; retrying is pure waste.
    expect(error.retryable).toBe(false);
  });

  /**
   * A 429 is two different problems wearing one status code, and the
   * difference decides whether retrying achieves anything.
   */
  it('separates an exhausted quota from a burst limit', async () => {
    httpRequest.mockImplementation(async () =>
      errorResponse(429, 'Quota exceeded: enable billing on your plan'),
    );
    const quota = await expectFailure({ ...PARAMS, numberOfImages: 1 });
    expect(quota.retryable).toBe(false);
    expect(quota.message).toMatch(/quota/i);

    httpRequest.mockImplementation(async () =>
      errorResponse(429, 'Too many requests, slow down'),
    );
    const burst = await expectFailure({ ...PARAMS, numberOfImages: 1 });
    expect(burst.retryable).toBe(true);
  });

  it('reports a rejected key as a configuration problem, not a retryable fault', async () => {
    httpRequest.mockImplementation(async () =>
      errorResponse(403, 'API key not valid'),
    );
    const error = await expectFailure({ ...PARAMS, numberOfImages: 1 });
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('GOOGLE_AI_API_KEY');
  });

  it('explains a safety block rather than reporting an empty response', async () => {
    httpRequest.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
        promptFeedback: { blockReason: 'SAFETY' },
      }),
    }));

    const error = await expectFailure({ ...PARAMS, numberOfImages: 1 });
    expect(error.message).toMatch(/safety/i);
  });

  it('refuses to call the API at all when no key is configured', async () => {
    delete process.env.GOOGLE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GEMINI_API_KEY;

    const error = await expectFailure(PARAMS);

    expect(error).toBeInstanceOf(ImageProviderError);
    expect(error.status).toBe(503);
    expect(httpRequest).not.toHaveBeenCalled();
  });
});
