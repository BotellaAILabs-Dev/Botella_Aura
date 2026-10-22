import { describe, it, expect } from 'vitest';
import type { ZodObject, ZodRawShape } from 'zod';

import {
  FORMAT_FAMILIES,
  FORMAT_SPECS,
  ctaRequired,
  formatForFamily,
  formatInstructions,
} from '@/lib/content-formats';
import { playbookFor } from '@/lib/content-playbook';
import { checkQuality, copyParts } from '@/lib/content-quality';
import { draftSnippet } from '@/lib/content-ui';
import { buildContentBrief } from '@/lib/content-brief';
import {
  buildContextHandoff,
  type HandoffInput,
} from '@/lib/recommendation-context-handoff';
import { platformsForType } from '@/lib/platforms';
import {
  aiBodySchemaFor,
  bodySchemaFor,
  CONTENT_TYPES,
  isCopyOnlyType,
  type ContentTypeKey,
} from '@/lib/validations/content';
import { renderForManual } from '@/server/content/render';
import { SAMPLE_BODIES } from './fixtures/format-bodies';

/**
 * Content formats: each defined once — template, required fields, channel,
 * length, CTA, voice, output — and held to that definition everywhere.
 */

describe('every format is fully defined', () => {
  it.each(CONTENT_TYPES)(
    '%s: template, channel, length, CTA, voice and output',
    (type) => {
      const f = FORMAT_SPECS[type];
      expect(f.key).toBe(type);
      expect(f.purpose).toBeTruthy();
      expect(f.template.length).toBeGreaterThan(0);
      expect(f.channel.constraints.length).toBeGreaterThan(0);
      expect(f.length.length).toBeGreaterThan(0);
      expect(['required', 'optional', 'none']).toContain(f.cta.mode);
      expect(f.voice.length).toBeGreaterThan(0);
      expect(f.output.schemaText).toMatch(/^\{ .* \}$/);
    },
  );

  it.each(CONTENT_TYPES)(
    '%s: the declared output fields are exactly the schema’s',
    (type) => {
      // What the AI is told to write is exactly what it is held to.
      const shape = (aiBodySchemaFor(type) as unknown as ZodObject<ZodRawShape>)
        .shape;
      expect(Object.keys(FORMAT_SPECS[type].output.fields).sort()).toEqual(
        Object.keys(shape).sort(),
      );
      for (const key of Object.keys(shape))
        expect(FORMAT_SPECS[type].output.schemaText).toContain(`"${key}"`);
      // The stored body adds only the post's details — never asked of the AI.
      const stored = (bodySchemaFor(type) as unknown as ZodObject<ZodRawShape>).shape;
      expect(Object.keys(stored).sort()).toEqual([...Object.keys(shape), 'details'].sort());
      expect(FORMAT_SPECS[type].output.schemaText).not.toContain('"details"');
    },
  );

  it.each(CONTENT_TYPES)('%s: a well-formed body passes its schema', (type) => {
    expect(bodySchemaFor(type).safeParse(SAMPLE_BODIES[type]).success).toBe(
      true,
    );
  });

  it('the playbook builds each format from its template', () => {
    for (const type of CONTENT_TYPES) {
      const rules = playbookFor(type, null).rules;
      for (const line of FORMAT_SPECS[type].template)
        expect(rules).toContain(line);
    }
  });

  it('copied-out formats are exactly the copy-only types (plus the blog), and have no network', () => {
    for (const type of CONTENT_TYPES) {
      const out = FORMAT_SPECS[type].channel.publishing === 'copy_out';
      expect(out, type).toBe(isCopyOnlyType(type) || type === 'BLOG');
      if (isCopyOnlyType(type) && type !== 'AD')
        expect(platformsForType(type)).toEqual([]);
    }
  });
});

describe('the formats people ask for', () => {
  it('social post, caption, email, campaign copy and promotional copy are all supported', () => {
    expect(formatForFamily('social_post')).toBe('LINKEDIN_POST');
    expect(formatForFamily('caption')).toBe('IMAGE_POST');
    expect(formatForFamily('email')).toBe('EMAIL');
    expect(formatForFamily('campaign_copy')).toBe('CAMPAIGN_COPY');
    expect(formatForFamily('promotional_copy')).toBe('PROMO');
    // Every family has a format, and every format a family.
    expect(new Set(Object.values(FORMAT_SPECS).map((f) => f.family))).toEqual(
      new Set(Object.keys(FORMAT_FAMILIES)),
    );
  });
});

describe('call to action', () => {
  it('required formats always need one; optional ones when the brief asks; threads carry it inline', () => {
    expect(ctaRequired('EMAIL')).toBe(true);
    expect(ctaRequired('PROMO')).toBe(true);
    expect(ctaRequired('BLOG')).toBe(false);
    expect(ctaRequired('BLOG', true)).toBe(true);
    expect(ctaRequired('TWEET_THREAD', true)).toBe(false);
  });

  it('a missing required CTA blocks approval (so the writer is asked to add it); otherwise it warns', () => {
    const body = { ...SAMPLE_BODIES.EMAIL, cta: '' };
    const base = {
      limits: playbookFor('EMAIL', null).limits,
      sources: 'coffee',
      avoid: [],
      alcohol: false,
    };
    const required = checkQuality('EMAIL', body, {
      ...base,
      ctaRequired: true,
    });
    const optional = checkQuality('EMAIL', body, base);
    expect(required.issues.find((i) => i.code === 'no-cta')?.severity).toBe(
      'block',
    );
    expect(required.approvable).toBe(false);
    expect(optional.issues.find((i) => i.code === 'no-cta')?.severity).toBe(
      'warn',
    );
  });

  it('the writer is told where the CTA sends people — or that no link is known', () => {
    const limits = playbookFor('EMAIL', null).limits;
    expect(
      formatInstructions('EMAIL', {
        limits,
        ctaDestination: 'https://roastery.example',
      }),
    ).toMatch(
      /CALL TO ACTION: Required\..*sends people to https:\/\/roastery\.example/,
    );
    expect(formatInstructions('EMAIL', { limits })).toMatch(
      /No link is known — name the next step without a URL/,
    );
  });
});

describe('the writer’s format instructions', () => {
  it('say what it is, where it goes, how long, the CTA and how the voice applies', () => {
    const text = formatInstructions('PROMO', {
      limits: playbookFor('PROMO', null).limits,
    });
    expect(text).toMatch(/^FORMAT: Promotional copy \(Promotional copy\)/);
    expect(text).toMatch(/WHERE IT GOES: Copied to the site/);
    expect(text).toMatch(
      /LENGTH: Headline: under 60 characters\..*never over 1,300.*No hashtags\./,
    );
    expect(text).toMatch(
      /BRAND VOICE IN THIS FORMAT: Enthusiastic within the brand’s voice/,
    );
  });

  it('promotional copy never invents an offer or a deadline', () => {
    const rules = FORMAT_SPECS.PROMO.template.join(' ');
    expect(rules).toMatch(/never invent a price, discount or product/);
    expect(rules).toMatch(/no false scarcity/);
  });
});

describe('each format’s required fields are enforced by the brief', () => {
  const handoff = (
    b: Partial<HandoffInput['business']> = {},
    r: Partial<HandoffInput['recommendation']> = {},
  ) =>
    buildContextHandoff({
      recommendation: {
        id: 'rec1',
        opportunityId: 'opp1',
        status: 'ACCEPTED',
        type: 'CONTENT',
        title: 'Explain the coffee price rise',
        action: 'Tell subscribers why prices rose.',
        steps: ['Say what changed at origin'],
        rationale: 'Prices are rising.',
        expectedOutcome: 'Subscribers understand.',
        outcomeMetric: null,
        channel: null,
        contentType: null,
        audience: null,
        details: { angle: 'Honest about prices' },
        confidence: 'HIGH',
        confidenceReason: null,
        executable: true,
        blockers: [],
        evidence: [
          { label: 'Prices climb', detail: '', url: null, observedAt: null },
        ],
        ...r,
      },
      business: {
        name: 'Roastery',
        description: 'Small-batch roaster.',
        offerings: null,
        industry: null,
        website: 'https://roastery.example',
        goals: 'Grow subscriptions',
        audience: 'Home brewers',
        campaigns: [],
        connected: [],
        voice: null,
        memory: [],
        ...b,
      },
    });
  const OPP = {
    id: 'opp1',
    title: 'Prices rising',
    type: 'TRENDING_TOPIC',
    typeLabel: 'Trending topic',
    summary: '',
    angle: null,
  };
  const briefFor = (
    type: ContentTypeKey,
    b: Partial<HandoffInput['business']> = {},
  ) =>
    buildContentBrief({
      handoff: handoff(b),
      opportunity: OPP,
      choice: { type },
    });

  it('an email with nowhere for its button to go is blocked, saying why', () => {
    const b = briefFor('EMAIL', { website: null });
    expect(b.readiness).toBe('blocked');
    expect(b.fields.find((f) => f.field === 'cta')?.requirement).toBe(
      'required',
    );
    expect(b.blockedBy.join(' ')).toMatch(
      /Email: An email’s button has to send people somewhere/,
    );
  });

  it('an ad with no audience, and campaign copy with no goal, are blocked', () => {
    expect(briefFor('AD', { audience: null }).blockedBy.join(' ')).toMatch(
      /Ad copy: An ad is shown to a chosen audience/,
    );
    expect(
      briefFor('CAMPAIGN_COPY', { goals: null }).blockedBy.join(' '),
    ).toMatch(/Campaign copy: Campaign copy serves a campaign goal/);
  });

  it('the same gaps are only recommended for a social post', () => {
    const b = briefFor('LINKEDIN_POST', {
      website: null,
      goals: null,
      audience: null,
    });
    expect(b.readiness).toBe('ready_with_gaps');
  });

  it('with everything there, every format is ready', () => {
    for (const type of CONTENT_TYPES)
      expect(briefFor(type).readiness, type).not.toBe('blocked');
  });

  it('campaign copy needs no image; a promotion recommends one', () => {
    expect(briefFor('CAMPAIGN_COPY').assetRequirements?.visual.need).toBe(
      'none',
    );
    expect(briefFor('PROMO').assetRequirements?.visual).toMatchObject({
      need: 'recommended',
      aspectRatio: '1:1',
    });
    expect(briefFor('PROMO').channel?.platform).toBeNull();
  });
});

describe('the new formats show and copy out correctly', () => {
  it('quality reads every part of the copy', () => {
    expect(
      copyParts('CAMPAIGN_COPY', SAMPLE_BODIES.CAMPAIGN_COPY).text,
    ).toMatch(/Honest coffee.*breakdown/s);
    expect(copyParts('PROMO', SAMPLE_BODIES.PROMO).cta).toBe(
      'Claim your free bag',
    );
  });

  it('the list shows the tagline / headline', () => {
    expect(draftSnippet('CAMPAIGN_COPY', SAMPLE_BODIES.CAMPAIGN_COPY)).toBe(
      'Honest coffee, honestly priced',
    );
    expect(draftSnippet('PROMO', SAMPLE_BODIES.PROMO)).toBe(
      'Your first bag, on us',
    );
  });

  it('copy-out text carries every part, and leaves out empty terms and urgency', () => {
    const draft = (type: ContentTypeKey) =>
      ({ type, body: SAMPLE_BODIES[type] }) as unknown as Parameters<
        typeof renderForManual
      >[0];
    expect(renderForManual(draft('CAMPAIGN_COPY'))).toMatch(
      /Tagline: .*Key message: .*Short copy:.*Long copy:.*Proof points:.*Call to action: See the breakdown/s,
    );
    const promo = renderForManual(draft('PROMO'));
    expect(promo).toMatch(/Your first bag, on us.*\[ Claim your free bag \]/s);
    expect(promo).not.toMatch(/Terms:/);
  });
});
