import { describe, expect, it } from 'vitest';

import type { BusinessContextSnapshot } from '@/lib/business-context-snapshot';
import { assembleGenerationContext, type AssembleInput } from '@/lib/generation-context';
import {
  offeringsSummary,
  pickProducts,
  productLine,
  readProducts,
  type Product,
} from '@/lib/products';
import {
  BusinessContextUpdateError,
  businessContextPatchSchema,
} from '@/lib/validations/business-context';
import { businessProfileSchema } from '@/lib/validations/profile';
import {
  EMPTY_STORED_CONTEXT,
  planBusinessContextWrite,
  type StoredBusinessContext,
} from '@/server/business-context/update';

/**
 * The product catalogue: drafts should be about a real product and the people
 * it is for, not the business in general.
 */

const product = (over: Partial<Product> = {}): Product => ({
  id: 'p_1',
  name: 'Bean subscription',
  description: 'Two bags of single-origin beans every month.',
  audience: 'home brewers with a grinder',
  benefit: 'never runs out, always fresh',
  price: '₹899 / month',
  url: null,
  featured: false,
  ...over,
});

const CATALOG: Product[] = [
  product(),
  product({
    id: 'p_2',
    name: 'Office coffee plan',
    description: 'Bulk beans and a grinder on loan for offices.',
    audience: 'office managers at 20–200 person companies',
    benefit: 'one invoice, no machine to buy',
    price: null,
    featured: true,
  }),
  product({
    id: 'p_3',
    name: 'Gift box',
    description: 'Three sample bags in a box with a tasting card.',
    audience: 'people buying for a coffee lover',
    benefit: 'ships wrapped with a note',
    price: null,
  }),
];

describe('choosing products for a piece of work', () => {
  it('picks the product the brief names', () => {
    const r = pickProducts(CATALOG, 'A Diwali post about our gift box');
    expect(r.matched).toBe(true);
    expect(r.products[0]!.name).toBe('Gift box');
  });

  it('matches on who a product is for, not only its name', () => {
    const r = pickProducts(CATALOG, 'Why office managers should stop buying pods');
    expect(r.products[0]!.name).toBe('Office coffee plan');
  });

  it('falls back to lead products when the brief names none', () => {
    const r = pickProducts(CATALOG, 'Our story: ten years of roasting');
    expect(r.matched).toBe(false);
    expect(r.products.map((p) => p.name)).toEqual(['Office coffee plan']);
  });

  it('falls back to the first listed when none is marked as lead', () => {
    const r = pickProducts(
      CATALOG.map((p) => ({ ...p, featured: false })),
      'Monsoon is here',
      1,
    );
    expect(r.products.map((p) => p.name)).toEqual(['Bean subscription']);
  });

  it('describes a product in one line with what makes it relevant', () => {
    expect(productLine(CATALOG[0]!)).toBe(
      'Bean subscription — Two bags of single-origin beans every month. (for home brewers with a grinder; why people choose it: never runs out, always fresh; price: ₹899 / month)',
    );
  });

  it('adds product names to "what it sells" for every one-line consumer', () => {
    expect(offeringsSummary({ offerings: 'Coffee.', products: CATALOG })).toBe(
      'Coffee. Products: Bean subscription, Office coffee plan, Gift box.',
    );
    expect(offeringsSummary({ offerings: null, products: [] })).toBeNull();
    expect(offeringsSummary({ offerings: 'Coffee.' })).toBe('Coffee.');
  });
});

describe('reading stored products', () => {
  it('drops a damaged entry without losing the rest of the profile', () => {
    const parsed = businessProfileSchema.parse({
      description: 'We roast coffee in small batches for home brewers.',
      products: [product(), { name: 42 }, 'nonsense'],
    });
    expect(parsed.description).toMatch(/roast coffee/);
    expect(parsed.products?.map((p) => p.name)).toEqual(['Bean subscription']);
    expect(readProducts('not a list')).toEqual([]);
  });
});

describe('saving products', () => {
  const stored = (products: unknown[] = []): StoredBusinessContext => ({
    ...EMPTY_STORED_CONTEXT,
    name: 'Roastery',
    preferences: {
      business: { description: 'We roast single-origin coffee in small batches.', products },
    },
  });
  const write = (current: StoredBusinessContext, products: unknown) =>
    planBusinessContextWrite(
      current,
      businessContextPatchSchema.parse({ identity: { products } }),
      'settings',
    );
  const saved = (plan: ReturnType<typeof write>) =>
    ((plan.data.preferences?.business as Record<string, unknown>)?.products ?? []) as Product[];

  it('stores a new product with a server-assigned id and keeps the description', () => {
    const plan = write(stored(), [{ name: ' Gift box ', description: 'Three bags', url: '' }]);
    expect(plan.changed).toEqual(['identity.products']);
    const [p] = saved(plan);
    expect(p).toMatchObject({ name: 'Gift box', description: 'Three bags', url: null, featured: false });
    expect(p!.id).toMatch(/^p_[0-9a-f]{12}$/);
    expect((plan.data.preferences?.business as Record<string, unknown>).description).toMatch(/roast/);
  });

  it('keeps known ids and replaces made-up ones', () => {
    const plan = write(stored([product()]), [
      { ...product(), name: 'Bean subscription (250 g)' },
      { id: 'p_invented', name: 'Gift box' },
    ]);
    const [a, b] = saved(plan);
    expect(a!.id).toBe('p_1');
    expect(b!.id).not.toBe('p_invented');
  });

  it('is not a write when the same list is sent back', () => {
    const plan = write(stored([product()]), [product()]);
    expect(plan.changed).toEqual([]);
    expect(plan.data.preferences).toBeUndefined();
  });

  it('removes the list when every product is deleted', () => {
    const plan = write(stored([product()]), []);
    expect(plan.changed).toEqual(['identity.products']);
    expect(plan.data.preferences?.business).not.toHaveProperty('products');
  });

  it('refuses placeholder and duplicate names, listing each problem', () => {
    let error: unknown;
    try {
      write(stored(), [{ name: 'TBD' }, { name: 'Gift box' }, { name: 'gift box' }]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BusinessContextUpdateError);
    const messages = (error as BusinessContextUpdateError).issues.map((i) => i.message);
    expect(messages.join(' ')).toMatch(/placeholder/);
    expect(messages.join(' ')).toMatch(/listed twice/);
  });

  it('rejects a bad link and an empty name at the shape check', () => {
    expect(
      businessContextPatchSchema.safeParse({ identity: { products: [{ name: 'X', url: 'not a url' }] } }).success,
    ).toBe(false);
    expect(businessContextPatchSchema.safeParse({ identity: { products: [{ name: '  ' }] } }).success).toBe(false);
  });

  it('lets only a person change products', () => {
    expect(() =>
      planBusinessContextWrite(
        stored(),
        businessContextPatchSchema.parse({ identity: { products: [{ name: 'Gift box' }] } }),
        'ai',
      ),
    ).toThrow(BusinessContextUpdateError);
  });
});

describe('products in the generation context', () => {
  const snapshot = {
    version: 2,
    companyId: 'co1',
    fingerprint: 'abcdef1234567890',
    revision: null,
    generatedAt: '2026-10-30T10:00:00.000Z',
    view: 'content',
    strict: false,
    business: { name: 'Roastery', description: 'We roast coffee.', industry: null, website: null },
    products: {
      offerings: null,
      catalog: CATALOG.map(({ id: _id, ...p }) => p),
      highlights: [],
    },
    audience: null,
    goals: null,
    voice: null,
    channels: null,
    competitors: null,
    learning: null,
    history: null,
    trust: {},
    assumptions: [],
    omitted: [],
    gaps: [],
    meta: { sections: ['business', 'products'], estimatedTokens: 100 },
  } as unknown as BusinessContextSnapshot;

  const business = (brief: string) => {
    const ctx = assembleGenerationContext({
      brief,
      contentBrief: null,
      snapshot,
      snapshotStatus: 'current',
      playbook: { label: 'LinkedIn post', rules: [] },
      format: { type: 'LINKEDIN_POST', channel: 'LinkedIn' },
      campaign: null,
      knowledge: [],
      reference: [],
      previous: [],
      now: new Date('2026-10-30T12:00:00Z'),
    } as unknown as AssembleInput);
    return ctx.sections.find((s) => s.key === 'business')?.text ?? '';
  };

  it('puts the product the post is about in front of the model', () => {
    const text = business('Diwali gift box launch');
    expect(text).toMatch(/Products this piece is about:/);
    expect(text).toMatch(/- Gift box — Three sample bags/);
    expect(text).not.toMatch(/Office coffee plan/);
  });

  it('offers the lead product for a general post, marked as optional', () => {
    const text = business('Ten years of roasting');
    expect(text).toMatch(/brief names none/);
    expect(text).toMatch(/Office coffee plan/);
  });
});
