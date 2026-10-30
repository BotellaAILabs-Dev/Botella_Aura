import { websitePlatform } from '@/lib/website-platforms';
import { ghostAdapter } from '@/server/websites/adapters/ghost';
import { shopifyAdapter } from '@/server/websites/adapters/shopify';
import { wordpressAdapter } from '@/server/websites/adapters/wordpress';
import type { WebsiteAdapter } from '@/server/websites/types';

/**
 * Platform id → adapter. A platform is publishable when it is listed as
 * `available` in lib/website-platforms.ts AND has an adapter here.
 */
const ADAPTERS: Record<string, WebsiteAdapter> = {
  wordpress: wordpressAdapter,
  shopify: shopifyAdapter,
  ghost: ghostAdapter,
};

export function getAdapter(platform: string): WebsiteAdapter | null {
  const meta = websitePlatform(platform);
  if (!meta || meta.status !== 'available') return null;
  return ADAPTERS[platform] ?? null;
}

/** Shopify OAuth needs app credentials on the deployment; the token path does not. */
export function shopifyOAuthConfigured(): boolean {
  return Boolean(process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);
}
