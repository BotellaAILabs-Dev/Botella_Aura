import { describe, it, expect } from 'vitest';

import { checkQuality, type QualityContext } from '@/lib/content-quality';
import { playbookFor } from '@/lib/content-playbook';

import {
  anglePolicyFor,
  classifySource,
  isPromotionalFormat,
  promotionalPhrases,
  refusalFor,
  safetyInstructions,
  storedSourceSafety,
  toneMismatch,
  TOPIC_LABEL,
} from '@/lib/brand-safety';

/**
 * Brand safety.
 *
 * The case that produced this module: Market Trends surfaced a news story in
 * which people had died, and Content Studio wrote a LinkedIn post promoting
 * whiskey as "bringing people together". The first group of tests is that
 * exact failure. The second is the reason a check like this usually gets
 * switched off — marketing English is full of borrowed violence ("killer
 * feature", "price war", "we crushed it"), and a classifier that flags those
 * is worse than none, because people stop believing it.
 */

describe('the failure this exists for', () => {
  const source =
    'Three people died after a crash on the road outside the distillery ' +
    'district on Saturday night. Police said the death toll could rise.';
  const copy =
    'Whiskey has always brought people together. Raise a glass to the ' +
    'moments that matter. 🥃 Don’t miss our new release.';

  it('reads the source as unsuitable, and says why in words a person can act on', () => {
    const s = classifySource(source);
    expect(s.posture).toBe('unsuitable');
    expect(s.hits.map((h) => h.topic)).toContain('death');
    expect(s.reason).toContain(TOPIC_LABEL.death);
  });

  it('catches the promotional copy written off it', () => {
    const { mismatch, phrases } = toneMismatch(classifySource(source), copy);
    expect(mismatch).toBe(true);
    expect(phrases).toContain('raise a glass');
  });

  it('refuses a promotion outright, but still allows a post that speaks to it', () => {
    const s = classifySource(source);
    // There is no respectful way to write an advert off a fatality.
    expect(refusalFor(s, 'PROMO')).toBeTruthy();
    expect(refusalFor(s, 'AD')).toBeTruthy();
    expect(refusalFor(s, 'CAMPAIGN_COPY')).toBeTruthy();
    // A person may legitimately want to write about a hard subject, so an
    // ordinary post is allowed — and then held to the rules instead.
    expect(refusalFor(s, 'LINKEDIN_POST')).toBeNull();
    expect(refusalFor(s, 'BLOG')).toBeNull();
  });

  it('tells the writer what not to do, in instructions rather than cautions', () => {
    const text = safetyInstructions(classifySource(source));
    expect(text).toContain('NOT MARKETING MATERIAL');
    expect(text).toMatch(/do not use it as a reason, hook or occasion/i);
    expect(text).toMatch(/no celebratory/i);
    // And it must not merely advise care — that is not actionable.
    expect(text).toMatch(/ABSOLUTE RULES/);
  });

  it('tells the digest not to invent an angle for it', () => {
    const policy = anglePolicyFor(classifySource(source));
    expect(policy).toMatch(/do not suggest a marketing angle/i);
    expect(policy).toMatch(/suitableForPromotion/);
  });
});

describe('what counts as sensitive', () => {
  const cases: [string, string, string][] = [
    ['death', 'unsuitable', 'A fire killed two workers at the plant.'],
    ['violence', 'unsuitable', 'A gunman opened fire at the market.'],
    ['conflict', 'unsuitable', 'Airstrikes continued as the war entered its third year.'],
    ['self_harm', 'unsuitable', 'A report shows suicide rates have risen sharply.'],
    ['missing', 'unsuitable', 'A search and rescue operation is under way for a missing person.'],
    ['disaster', 'caution', 'The earthquake flattened homes and a state of emergency was declared.'],
    ['injury', 'caution', 'Four people were hospitalised in critical condition.'],
    ['illness', 'caution', 'The opioid crisis continues to strain rural hospices.'],
    ['hardship', 'caution', 'The firm announced layoffs affecting 400 staff.'],
    ['legal', 'caution', 'The brand issued a product recall after a safety investigation.'],
    ['discrimination', 'caution', 'The report documents racism and harassment at the company.'],
  ];

  for (const [topic, posture, text] of cases) {
    it(`treats ${topic} as ${posture}`, () => {
      const s = classifySource(text);
      expect(s.posture).toBe(posture);
      expect(s.hits.map((h) => h.topic)).toContain(topic);
    });
  }

  it('grave topics outrank the rest when both appear', () => {
    // Injury alone is caution; a death alongside it makes the whole source
    // unsuitable rather than averaging out.
    expect(
      classifySource('Two died and four were injured in the collision.').posture,
    ).toBe('unsuitable');
  });

  it('has nothing to say about ordinary material', () => {
    const s = classifySource(
      'Our new single malt launches next month after three years in cask.',
    );
    expect(s.posture).toBe('clear');
    expect(s.hits).toEqual([]);
    expect(s.reason).toBeNull();
    expect(safetyInstructions(s)).toBe('');
    expect(anglePolicyFor(s)).toBe('');
  });

  it('says nothing about text too short to judge', () => {
    for (const text of ['', '   ', 'Hello', null, undefined]) {
      expect(classifySource(text).posture).toBe('clear');
    }
  });
});

describe('marketing English that only sounds violent', () => {
  // Every one of these is a phrase an ordinary B2B post uses. A check that
  // flags them is a check that gets turned off within a week, so they are
  // stripped before any topic is looked for.
  const idioms: [string, string][] = [
    ['killer feature', 'Our new dashboard is a killer feature and the beta users killed it.'],
    ['dead simple', 'Onboarding is dead simple now — we were dying to ship it.'],
    ['price war', 'The streaming price war is reshaping how brands bundle.'],
    ['war room', 'We ran a war room for launch week.'],
    ['flooded with', 'We were flooded with orders — a flood of signups in 48 hours.'],
    ['deadline', 'The deadline is Friday, the team is on fire, and we crushed it.'],
    ['pain points', 'We mapped the top pain points in disaster recovery planning.'],
    ['attack the problem', 'Let’s attack the problem of churn — the missing piece is onboarding.'],
    ['data breach', 'A data breach costs millions; our fraud detection catches it early.'],
    ['cancer charity', 'We sponsor a cancer research charity walk every spring.'],
    ['to die for', 'The new dessert menu is to die for.'],
    ['smashed targets', 'The team smashed targets this quarter and blew up our forecast.'],
    ['bleeding edge', 'This is bleeding edge technology.'],
    ['brain drain', 'The brain drain in regional tech is a real problem.'],
  ];

  for (const [name, text] of idioms) {
    it(`does not flag "${name}"`, () => {
      const s = classifySource(text);
      expect(s.posture).toBe('clear');
      expect(s.hits).toEqual([]);
    });
  }
});

describe('the tone check only applies where it should', () => {
  const promo =
    'Celebrate with us! Raise a glass, don’t miss this limited time offer. 🎉';

  it('never flags promotional copy on a clear source', () => {
    // This is the important half: on ordinary material, celebration and
    // urgency are exactly what is wanted.
    const s = classifySource('Our tasting room reopens next week.');
    expect(toneMismatch(s, promo)).toEqual({ mismatch: false, phrases: [] });
  });

  it('flags it on a source that involves real harm', () => {
    const s = classifySource('Two people died in the warehouse fire.');
    expect(toneMismatch(s, promo).mismatch).toBe(true);
  });

  it('accepts measured copy on a sensitive source', () => {
    const s = classifySource('Two people died in the warehouse fire.');
    const measured =
      'Our thoughts are with the families affected by Saturday’s fire. ' +
      'The local relief fund is accepting donations.';
    expect(toneMismatch(s, measured).mismatch).toBe(false);
  });

  it('finds celebratory emoji as well as words', () => {
    expect(promotionalPhrases('Big news 🎉').length).toBeGreaterThan(0);
    expect(promotionalPhrases('A short factual update.')).toEqual([]);
  });
});

describe('which formats exist to sell', () => {
  it('names the promotional ones and nothing else', () => {
    for (const t of ['PROMO', 'AD', 'CAMPAIGN_COPY']) {
      expect(isPromotionalFormat(t)).toBe(true);
    }
    for (const t of ['LINKEDIN_POST', 'BLOG', 'IMAGE_POST', 'CAROUSEL', 'EMAIL']) {
      expect(isPromotionalFormat(t)).toBe(false);
    }
  });
});

describe('reading a verdict back off a stored draft', () => {
  it('reads a stored verdict', () => {
    const s = storedSourceSafety({
      sourceSafety: {
        posture: 'unsuitable',
        hits: [{ topic: 'death', matched: 'died' }],
        reason: 'because',
      },
    });
    expect(s?.posture).toBe('unsuitable');
    expect(s?.hits[0]?.topic).toBe('death');
  });

  it('treats a draft written before this existed as having no extra rules', () => {
    // Not a crash, and not an invented posture — an older draft simply has
    // no verdict, and must generate exactly as it did before.
    for (const meta of [
      {},
      { sourceSafety: null },
      { sourceSafety: 'unsuitable' },
      { sourceSafety: {} },
      { sourceSafety: { posture: 'clear' } },
      { sourceSafety: { posture: 'nonsense' } },
    ]) {
      expect(storedSourceSafety(meta as Record<string, unknown>)).toBeNull();
    }
  });

  it('survives a malformed hits array rather than throwing', () => {
    const s = storedSourceSafety({
      sourceSafety: {
        posture: 'caution',
        hits: [null, 'x', { topic: 'nope' }, { topic: 'injury', matched: 'injured' }],
        reason: 42,
      },
    });
    expect(s?.posture).toBe('caution');
    expect(s?.hits.map((h) => h.topic)).toEqual(['injury']);
    expect(s?.reason).toBeNull();
  });
});

/**
 * The whole chain, from source material to a draft that cannot be approved.
 *
 * The pieces above are each correct on their own; this is the one that would
 * actually have stopped the whiskey post, so it is worth asserting directly
 * rather than inferring from the parts.
 */
describe('end to end: the whiskey post cannot be approved', () => {
  const source =
    'Three people died after a crash outside the distillery district. ' +
    'Police said the death toll could rise.';

  const contextFor = (material: string): QualityContext => {
    const safety = classifySource(material);
    return {
      limits: playbookFor('IMAGE_POST', 'INSTAGRAM').limits,
      sources: material,
      avoid: [],
      alcohol: false,
      // Exactly what qualityContextFor does: a clear verdict is left off.
      ...(safety.posture !== 'clear' ? { sourceSafety: safety } : {}),
    };
  };

  const post = (caption: string, cta = '') => ({
    caption,
    hashtags: [] as string[],
    altText: '',
    cta,
  });

  it('blocks the copy that was actually written', () => {
    const report = checkQuality(
      'IMAGE_POST',
      post(
        'Whiskey has always brought people together. Raise a glass to the moments that matter.',
        'Visit us this weekend',
      ),
      contextFor(source),
    );
    const issue = report.issues.find((i) => i.code === 'source-tone-mismatch');
    expect(report.approvable).toBe(false);
    expect(issue?.severity).toBe('block');
    // The message has to name the source AND the words at fault, or the
    // person cannot tell what to change.
    expect(issue?.message).toContain('deaths or fatalities');
    expect(issue?.message).toContain('raise a glass');
  });

  it('allows measured copy written off the same source', () => {
    const report = checkQuality(
      'IMAGE_POST',
      post(
        'Our thoughts are with the families affected by Saturday night. The local relief fund is accepting donations.',
      ),
      contextFor(source),
    );
    expect(report.issues.some((i) => i.code === 'source-tone-mismatch')).toBe(
      false,
    );
  });

  it('leaves that same promotional copy alone on an ordinary source', () => {
    // The check must be invisible on normal work. If this ever fails, every
    // alcohol brand on the platform has just lost the ability to publish.
    const report = checkQuality(
      'IMAGE_POST',
      post('Whiskey brings people together. Raise a glass!', 'Visit us'),
      contextFor('Our new single malt launches next month after three years in cask.'),
    );
    expect(report.issues.some((i) => i.code === 'source-tone-mismatch')).toBe(
      false,
    );
  });
});
