import type { MaterialCategory } from '@prisma/client';

/**
 * The kinds of business material Aura learns from.
 *
 * The knowledge base could already swallow documents, but every one landed as
 * an undifferentiated blob scored on keyword overlap alone. That is the
 * difference between a filing cabinet and a colleague who has read the files:
 * the page stating what makes the company different competed on equal terms
 * with a stale blog post, and nothing could ask "what do we actually claim?"
 *
 * Each category earns its place by CHANGING something — how long the material
 * stays relevant, how hard it is weighted, and how it is labelled to the model.
 * A category that only showed up as a badge would be decoration.
 */
export interface MaterialCategoryDef {
  id: MaterialCategory;
  /** What a marketer would call this document. */
  label: string;
  /** What Aura does better once it has one. Shown when choosing a category. */
  helps: string;
  /** Example filenames, so the right choice is obvious at a glance. */
  examples: string;
  /**
   * How the model is told what it is reading. Retrieved chunks are labelled
   * with this, because "the following is your brand guidelines" and "the
   * following is a competitor's marketing" demand opposite treatment and an
   * unlabelled excerpt gets neither.
   */
  promptLabel: string;
  /**
   * Reference material does not go stale.
   *
   * Retrieval applies a 30-day recency half-life, which is right for posts and
   * announcements and wrong for positioning: brand guidelines written two years
   * ago are exactly as binding today. Timeless material is scored on relevance
   * alone.
   */
  timeless: boolean;
  /**
   * Retrieval weight. Above 1 means "prefer this when it matches".
   *
   * Differentiators and ICP are highest because they are the direct answer to
   * the failure this whole feature exists to fix — content that is accurate,
   * well-formed and says nothing only this company could say.
   */
  weight: number;
}

export const MATERIAL_CATEGORIES: MaterialCategoryDef[] = [
  {
    id: 'DIFFERENTIATORS',
    label: 'Key differentiators',
    helps: 'Aura can say what makes you different instead of what any competitor could also claim.',
    examples: 'Positioning one-pager, win/loss notes, "why us" page',
    promptLabel: 'WHAT MAKES THIS COMPANY DIFFERENT (use these claims; they are the point)',
    timeless: true,
    weight: 1.6,
  },
  {
    id: 'AUDIENCE_ICP',
    label: 'Target audience / ICP',
    helps: 'Aura writes to a specific buyer rather than to a general business reader.',
    examples: 'ICP definition, buyer personas, customer research',
    promptLabel: 'WHO THIS COMPANY SELLS TO',
    timeless: true,
    weight: 1.5,
  },
  {
    id: 'BRAND_GUIDELINES',
    label: 'Brand guidelines',
    helps: 'Aura follows your real voice rules — the words you use and the ones you never do.',
    examples: 'Brand book, tone-of-voice guide, messaging framework',
    promptLabel: 'BRAND RULES (follow these exactly)',
    timeless: true,
    weight: 1.4,
  },
  {
    id: 'PITCH_DECK',
    label: 'Pitch deck',
    helps: 'Aura learns the story you already tell investors and customers, and keeps to it.',
    examples: 'Sales deck, investor deck, product overview',
    promptLabel: 'THE COMPANY’S OWN PITCH',
    timeless: true,
    weight: 1.35,
  },
  {
    id: 'PAST_CAMPAIGN',
    label: 'Existing content & campaigns',
    helps: 'Aura matches what has already worked for you and avoids repeating it.',
    examples: 'Past posts, newsletters, campaign copy, case studies',
    promptLabel: 'CONTENT THIS COMPANY HAS PUBLISHED BEFORE',
    timeless: false,
    weight: 1.25,
  },
  {
    id: 'COMPANY_INFO',
    label: 'Company & product information',
    helps: 'Aura gets the basics right — what you sell, to whom, and how it works.',
    examples: 'About page, product overview, company profile',
    promptLabel: 'ABOUT THE COMPANY',
    timeless: true,
    weight: 1.2,
  },
  {
    id: 'COMPETITOR_INTEL',
    label: 'Competitor information',
    helps: 'Aura positions against competitors deliberately rather than accidentally echoing them.',
    examples: 'Competitor teardown, battlecard, comparison page',
    promptLabel:
      'COMPETITOR MATERIAL (context only — never adopt their voice or repeat their claims as ours)',
    timeless: false,
    weight: 1.15,
  },
  {
    id: 'PRODUCT_DOCS',
    label: 'Product documentation',
    helps: 'Aura describes features accurately instead of guessing at what they do.',
    examples: 'Docs, help centre articles, release notes, spec sheets',
    promptLabel: 'PRODUCT DOCUMENTATION (factual; do not embellish)',
    timeless: false,
    weight: 1.1,
  },
  {
    id: 'OTHER',
    label: 'Something else',
    helps: 'Still useful context, weighted normally.',
    examples: 'Anything that does not fit the categories above',
    promptLabel: 'COMPANY MATERIAL',
    timeless: false,
    weight: 1.0,
  },
];

const BY_ID = new Map(MATERIAL_CATEGORIES.map((c) => [c.id, c]));

export function materialCategory(
  id: MaterialCategory | null | undefined,
): MaterialCategoryDef | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

/**
 * A first guess at what a document is, from its filename.
 *
 * Only ever a DEFAULT for the picker — never applied silently. Getting this
 * wrong in the background would be worse than not guessing, because a deck
 * mislabelled as brand guidelines would then be treated as binding voice rules.
 * The user always sees and can change the choice.
 */
export function guessCategory(filename: string): MaterialCategory {
  const name = filename.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => name.includes(n));

  if (has('brand', 'tone-of-voice', 'tone of voice', 'styleguide', 'style-guide')) {
    return 'BRAND_GUIDELINES';
  }
  if (has('pitch', 'deck', 'investor', 'sales-deck')) return 'PITCH_DECK';
  if (has('icp', 'persona', 'audience', 'buyer')) return 'AUDIENCE_ICP';
  if (has('competitor', 'battlecard', 'teardown', 'vs-')) return 'COMPETITOR_INTEL';
  if (has('differentiat', 'positioning', 'why-us', 'why us')) return 'DIFFERENTIATORS';
  if (has('docs', 'documentation', 'manual', 'spec', 'release-notes')) {
    return 'PRODUCT_DOCS';
  }
  if (has('campaign', 'newsletter', 'case-study', 'case study', 'post')) {
    return 'PAST_CAMPAIGN';
  }
  if (has('about', 'company', 'overview', 'profile', 'product')) return 'COMPANY_INFO';

  // A .pptx is a deck far more often than it is anything else.
  if (name.endsWith('.pptx')) return 'PITCH_DECK';
  return 'OTHER';
}

/** Narrows an untrusted string (a form field) to a known category. */
export function isMaterialCategory(value: string): value is MaterialCategory {
  return BY_ID.has(value as MaterialCategory);
}
