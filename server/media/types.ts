import type { ImageProvider } from '@prisma/client';
import type { AspectRatioKey } from '@/lib/platforms';
import type { ImageStyleKey } from '@/lib/graphics-ui';

/**
 * The image-generation provider contract.
 *
 * Content Studio talks to this interface and never to a vendor. Adding a
 * provider means adding one file under `server/media/providers/` and one line
 * in the registry — no route, service or component changes. That is the whole
 * reason this abstraction exists rather than a direct OpenAI call.
 */
export interface ImageGenerationParams {
  prompt: string;
  negativePrompt?: string;
  /** Requested ratio. The provider maps it to its own nearest supported size. */
  aspectRatio: AspectRatioKey;
  /** Resolved pixel size for the ratio (providers may still round it). */
  width: number;
  height: number;
  /** 1-4. The service caps this before it ever reaches a provider. */
  numberOfImages: number;
  /** Style key from IMAGE_STYLES; already folded into `prompt` as well. */
  style?: string;
}

/** One image as it comes back from a provider, before we persist it. */
export interface GeneratedImage {
  /** Raw bytes. Providers that return a URL are fetched inside the provider. */
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
  /** The provider's own URL, kept for traceability only — these expire. */
  sourceUrl?: string;
  /** Some providers rewrite the prompt and report what they actually drew. */
  revisedPrompt?: string;
  /** Provider-shaped extras worth keeping (seed, request id, safety verdict). */
  metadata?: Record<string, unknown>;
}

export interface ImageGenerationProvider {
  readonly id: ImageProvider;
  /** Human label shown in the model selector. */
  readonly label: string;
  /** The model actually invoked, surfaced so the UI never has to guess. */
  readonly model: string;
  /** One line on what this provider is good at, shown under the radio. */
  readonly description: string;
  /** Env var that must be present. Named in the UI when it is missing. */
  readonly credentialEnv: string;
  /** Ratios this provider can produce natively. */
  readonly supportedRatios: AspectRatioKey[];
  /** Most images this provider will return from a single call. */
  readonly maxImagesPerRequest: number;
  /** True when the deployment has credentials for it. */
  isConfigured(): boolean;
  generateImage(params: ImageGenerationParams): Promise<GeneratedImage[]>;
}

/**
 * A provider failed in a way the user can act on.
 *
 * Carries the provider id so the UI can offer "try another model", and keeps
 * the raw provider response OUT of `message` — that detail is logged
 * server-side only, because provider errors routinely echo the request body
 * back and occasionally include request headers with it.
 */
export class ImageProviderError extends Error {
  readonly status: number;
  constructor(
    readonly provider: ImageProvider,
    message: string,
    status = 502,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'ImageProviderError';
    this.status = status;
  }
}

/** No provider has credentials on this deployment. */
export class NoImageProviderError extends Error {
  readonly status = 503;
  constructor() {
    super(
      'No image provider is configured. Add an API key for OpenAI, Google, ' +
        'Stability or Replicate to enable graphic generation.',
    );
    this.name = 'NoImageProviderError';
  }
}

/**
 * Art direction per style.
 *
 * Folded into the prompt text rather than passed as a provider flag: only some
 * providers have a style parameter, and the ones that do disagree on the
 * vocabulary. Expressing style as art direction keeps every provider producing
 * a recognisably similar result from the same selection.
 *
 * The style KEYS live in lib/graphics-ui.ts (the client needs those); this text
 * is prompt material and stays server-side.
 */
export const STYLE_DIRECTION: Record<ImageStyleKey, string> = {
  professional:
    'Polished corporate photography and clean vector accents. Balanced, ' +
    'trustworthy, premium. Soft realistic lighting, muted confident palette.',
  minimal:
    'Extreme restraint. Generous negative space, two or three colours, one ' +
    'clear subject, geometric simplicity. Nothing decorative.',
  cinematic:
    'Dramatic film lighting, shallow depth of field, moody graded colour, ' +
    'strong rim light and atmosphere. Feels like a frame from a film.',
  '3d':
    'Modern 3D render. Soft studio lighting, subtle material detail, gentle ' +
    'shadows, clean isometric or hero framing. Tasteful, never toy-like.',
  illustration:
    'Editorial vector illustration. Confident flat shapes, limited palette, ' +
    'expressive but restrained — the visual language of a good tech blog header.',
};
