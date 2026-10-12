import type { ContentTypeKey } from '@/lib/validations/content';

/**
 * One valid, clean body per content format — what a well-behaved writer
 * returns. Shared by the format tests and the contextual-generation check.
 */
export const SAMPLE_BODIES: Record<ContentTypeKey, Record<string, unknown>> = {
  LINKEDIN_POST: {
    hook: 'Coffee prices are rising, and our subscribers deserve to know why.',
    paragraphs: [
      'Harvests shrank this year, so green coffee costs more at origin.',
      'We are absorbing part of the increase so your bag stays fairly priced.',
      'Here is exactly where the extra cost goes, from farm to cup.',
    ],
    cta: 'Read the full breakdown on our site.',
    hashtags: ['coffee', 'specialtycoffee'],
  },
  IMAGE_POST: {
    caption:
      'Coffee prices are climbing. Here is what that means for your next bag.',
    cta: 'Tap the link in bio for the full story.',
    hashtags: ['coffee'],
    altText: 'A bag of single-origin beans on a wooden counter.',
  },
  CAROUSEL: {
    title: 'Why coffee costs more this year',
    slides: [
      { headline: 'Smaller harvests', body: 'Weather cut yields at origin.' },
      { headline: 'Higher shipping', body: 'Freight costs rose too.' },
      {
        headline: 'Fair prices to farms',
        body: 'We still pay above fair trade.',
      },
      { headline: 'What we absorb', body: 'Part of the rise stays with us.' },
      { headline: 'What it means for you', body: 'A small, honest change.' },
    ],
    cta: 'Save this and share it with a fellow home brewer.',
    hashtags: ['coffee'],
  },
  TWEET_THREAD: {
    tweets: [
      'Coffee prices are up this year. Here is why, honestly.',
      'Harvests shrank, and shipping costs rose.',
      'We absorb part of it. The full breakdown is on our site.',
    ],
    hashtags: [],
  },
  BLOG: {
    headline: 'Why your coffee costs a little more this year',
    subtitle: 'An honest look at harvests, shipping and fair prices.',
    sections: [
      {
        heading: 'What changed at origin',
        body: 'Harvests shrank across several regions this year.',
      },
      {
        heading: 'What we are doing',
        body: 'We absorb part of the increase and keep paying farms fairly.',
      },
    ],
    tags: ['coffee'],
  },
  EMAIL: {
    subjectLine: 'Why your next bag costs a little more',
    previewText: 'An honest note on this year’s harvest.',
    greeting: 'Hi there,',
    paragraphs: [
      'Harvests shrank this year, so green coffee costs more.',
      'We are absorbing part of it, and here is exactly how.',
    ],
    cta: 'Read the breakdown',
    signOff: 'The Roastery team',
  },
  AD: {
    headline: 'Honest coffee, fairly priced',
    primaryText:
      'Coffee costs more this year. We absorb part of it so your subscription stays fair.',
    description: 'Fresh single-origin beans',
    cta: 'Learn more',
  },
  CAMPAIGN_COPY: {
    tagline: 'Honest coffee, honestly priced',
    keyMessage:
      'When coffee costs more, we tell you why and carry part of it ourselves.',
    shortCopy:
      'Coffee prices are up. We absorb part of the rise and show you where every penny goes.',
    longCopy:
      'Harvests shrank this year and shipping costs rose. We could pass it all on; instead we carry part of it.\n\nEvery subscriber gets the full breakdown, from farm to cup.',
    proofPoints: ['We pay above fair-trade prices.'],
    cta: 'See the breakdown',
  },
  PROMO: {
    headline: 'Your first bag, on us',
    offer: 'A free first bag with any new subscription',
    body: 'Try a single-origin roast before you commit. Your first bag is free when you subscribe.',
    terms: '',
    urgency: '',
    cta: 'Claim your free bag',
  },
};
