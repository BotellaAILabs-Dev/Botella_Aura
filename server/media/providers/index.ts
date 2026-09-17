import type { ImageProvider } from '@prisma/client';
import type { AspectRatioKey } from '@/lib/platforms';
import {
  NoImageProviderError,
  type ImageGenerationProvider,
} from '@/server/media/types';
import { openAiImageProvider } from '@/server/media/providers/openai';
import { googleImageProvider } from '@/server/media/providers/gemini';
import { agnesImageProvider } from '@/server/media/providers/agnes';
import { stabilityImageProvider } from '@/server/media/providers/stability';
import { replicateImageProvider } from '@/server/media/providers/replicate';

/**
 * The image-provider registry.
 *
 * This mirrors how server/connectors/providers.ts already works, and for the
 * same reason: a provider is *implemented* when it appears here, but whether it
 * is *usable* is a deployment question. `listProviders()` reports the difference
 * honestly — naming the missing environment variable — instead of hiding an
 * unconfigured provider or, worse, offering it and failing at generation time.
 *
 * Order matters: it is the preference order used when the caller expresses none.
 */
const REGISTRY: ImageGenerationProvider[] = [
  openAiImageProvider,
  googleImageProvider,
  agnesImageProvider,
  stabilityImageProvider,
  replicateImageProvider,
];

export interface ProviderStatus {
  id: ImageProvider;
  label: string;
  model: string;
  description: string;
  configured: boolean;
  /** Named only when unconfigured, so the UI can say what to add. */
  credentialEnv: string;
  supportedRatios: AspectRatioKey[];
  maxImagesPerRequest: number;
}

/** Every provider with its configuration status — safe to send to the client. */
export function listProviders(): ProviderStatus[] {
  return REGISTRY.map((p) => ({
    id: p.id,
    label: p.label,
    model: p.model,
    description: p.description,
    configured: p.isConfigured(),
    credentialEnv: p.credentialEnv,
    supportedRatios: p.supportedRatios,
    maxImagesPerRequest: p.maxImagesPerRequest,
  }));
}

export function isAnyProviderConfigured(): boolean {
  return REGISTRY.some((p) => p.isConfigured());
}

export function getProvider(id: ImageProvider): ImageGenerationProvider | null {
  return REGISTRY.find((p) => p.id === id) ?? null;
}

/**
 * Resolve which provider to use.
 *
 * An explicit choice is honoured only when it is actually configured — silently
 * substituting a different model would bill the workspace for something it did
 * not pick. With no choice, the first configured provider in registry order
 * wins.
 */
export function resolveProvider(
  requested?: ImageProvider | null,
): ImageGenerationProvider {
  if (requested) {
    const provider = getProvider(requested);
    if (!provider) {
      throw Object.assign(new Error(`Unknown image provider "${requested}".`), {
        status: 400,
      });
    }
    if (!provider.isConfigured()) {
      throw Object.assign(
        new Error(
          `${provider.label} is not configured on this deployment. Add ${provider.credentialEnv}, or pick another model.`,
        ),
        { status: 503 },
      );
    }
    return provider;
  }

  const fallback = REGISTRY.find((p) => p.isConfigured());
  if (!fallback) throw new NoImageProviderError();
  return fallback;
}

/** Configured providers other than `exclude` — powers "Try another model". */
export function alternativeProviders(
  exclude: ImageProvider,
): ImageGenerationProvider[] {
  return REGISTRY.filter((p) => p.id !== exclude && p.isConfigured());
}
