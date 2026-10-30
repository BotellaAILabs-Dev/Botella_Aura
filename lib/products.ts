import { z } from 'zod';

/**
 * The business's products, as a short catalogue.
 *
 * "What you sell" is one free-text field, which is fine for a sentence but
 * leaves a model to guess which product a post is about, who that product is
 * for and why anyone would pick it. A draft then talks about the business in
 * general, which is the "not relevant to our products" complaint. A product
 * here is still prose in the business's own words — a name, what it is, who
 * it is for, why they choose it — so it steers a model the same way the
 * description does, only per product.
 *
 * Client-safe: the About My Business page, the write rules and the prompt
 * builders share these definitions.
 */

export const PRODUCT_LIMITS = {
  max: 20,
  name: 80,
  description: 300,
  audience: 200,
  benefit: 200,
  price: 60,
  url: 300,
} as const;

/** A product as stored in `preferences.business.products`. */
export const productSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(PRODUCT_LIMITS.name),
  /** What it is, in the business's own words. */
  description: z.string().max(PRODUCT_LIMITS.description).nullable(),
  /** Who it is for. Falls back to the business's audience when empty. */
  audience: z.string().max(PRODUCT_LIMITS.audience).nullable(),
  /** Why people choose it — the claim a post can make. */
  benefit: z.string().max(PRODUCT_LIMITS.benefit).nullable(),
  /** As the business writes it, e.g. "₹499 / month" or "from $20". */
  price: z.string().max(PRODUCT_LIMITS.price).nullable(),
  url: z.string().max(PRODUCT_LIMITS.url).nullable(),
  /** A lead product: preferred when a post is not about anything specific. */
  featured: z.boolean(),
});

export type Product = z.infer<typeof productSchema>;

/**
 * Reads a stored list leniently: one damaged entry is dropped, not the whole
 * business profile (the description lives next to it).
 */
export function readProducts(value: unknown): Product[] {
  if (!Array.isArray(value)) return [];
  const out: Product[] = [];
  for (const item of value) {
    const parsed = productSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    if (out.length >= PRODUCT_LIMITS.max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Choosing products for a piece of work
// ---------------------------------------------------------------------------

const STOP = new Set(
  'a an and are as at be by for from has have how in is it its of on or our the their this to was we with you your'.split(
    ' ',
  ),
);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** How strongly a product matches what the work is about. */
export function productScore(product: Omit<Product, 'id'>, about: string): number {
  const topic = words(about);
  if (topic.size === 0) return 0;
  const name = product.name.toLowerCase();
  // Naming the product outright beats any amount of word overlap.
  let score = about.toLowerCase().includes(name) ? 10 : 0;
  for (const w of words(product.name)) if (topic.has(w)) score += 3;
  const rest = `${product.description ?? ''} ${product.audience ?? ''} ${product.benefit ?? ''}`;
  for (const w of words(rest)) if (topic.has(w)) score += 1;
  return score;
}

/**
 * The products a piece of work should draw on: those it is about, best match
 * first; when it is about none of them, the featured ones (then the first
 * listed), so a general post still names something real the business sells.
 */
export function pickProducts<T extends Omit<Product, 'id'>>(
  products: readonly T[],
  about: string,
  limit = 3,
): { products: T[]; matched: boolean } {
  if (products.length === 0) return { products: [], matched: false };
  const scored = products
    .map((p, i) => ({ p, i, s: productScore(p, about) }))
    .filter((x) => x.s >= 2)
    .sort((a, b) => b.s - a.s || a.i - b.i);
  if (scored.length) {
    return { products: scored.slice(0, limit).map((x) => x.p), matched: true };
  }
  const featured = products.filter((p) => p.featured);
  return {
    products: (featured.length ? featured : products).slice(0, limit),
    matched: false,
  };
}

// ---------------------------------------------------------------------------
// Text for prompts
// ---------------------------------------------------------------------------

/** One line per product, for a prompt. */
export function productLine(p: Omit<Product, 'id'>): string {
  const parts = [p.name];
  if (p.description) parts.push(`— ${p.description}`);
  const extra = [
    p.audience && `for ${p.audience}`,
    p.benefit && `why people choose it: ${p.benefit}`,
    p.price && `price: ${p.price}`,
    p.url && p.url,
  ].filter(Boolean);
  if (extra.length) parts.push(`(${extra.join('; ')})`);
  return parts.join(' ');
}

/**
 * "What it sells" for the many places that take one string: the business's
 * own sentence, then the product names. Lets every existing consumer of
 * `offerings` see the catalogue without each learning its shape.
 */
export function offeringsSummary(identity: {
  offerings: string | null;
  products?: readonly Product[];
}): string | null {
  const names = (identity.products ?? []).map((p) => p.name);
  const list = names.length ? `Products: ${names.join(', ')}.` : null;
  if (identity.offerings && list) return `${identity.offerings} ${list}`;
  return identity.offerings ?? list;
}

/** A short random id for a new product. */
export function newProductId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `p_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
