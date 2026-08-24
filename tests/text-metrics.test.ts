import { describe, expect, it } from 'vitest';

import {
  ctaEffectiveness,
  hookStrength,
  predictEngagement,
  readability,
  sentences,
  structure,
  syllables,
  words,
} from '@/server/intelligence/text-metrics';

/**
 * These metrics are the numeric backbone of the Marketing Intelligence
 * dashboard, so they must be deterministic and defensible — a score that drifts
 * between refreshes is worse than no score.
 */
describe('tokenizing', () => {
  it('splits sentences on terminators and bullets', () => {
    expect(sentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
    expect(sentences('Intro\n- first\n- second')).toHaveLength(3);
  });

  it('drops URLs from the word list so links do not skew readability', () => {
    expect(words('read https://example.com/a/b now')).toEqual(['read', 'now']);
  });

  it('counts syllables with the vowel-group heuristic', () => {
    expect(syllables('cat')).toBe(1);
    expect(syllables('marketing')).toBe(3);
    expect(syllables('a')).toBe(1);
    expect(syllables('')).toBe(0);
  });
});

describe('readability', () => {
  it('scores short plain sentences as easy', () => {
    const r = readability('We ship fast. Our team is small. You get help.');
    expect(r.score).toBeGreaterThan(70);
    expect(r.verdict).toMatch(/easy|clear/i);
  });

  it('scores long multisyllabic prose as hard', () => {
    const r = readability(
      'The implementation of comprehensive organizational transformation initiatives ' +
        'necessitates systematic reconsideration of established operational methodologies ' +
        'across interdependent administrative departments.',
    );
    expect(r.score).toBeLessThan(40);
    expect(r.gradeLevel).toBeGreaterThan(12);
  });

  it('reports an unmeasurable state instead of a fake zero-ish score', () => {
    const r = readability('   ');
    expect(r.score).toBe(0);
    expect(r.verdict).toMatch(/not enough text/i);
  });
});

describe('hookStrength', () => {
  it('rewards a short, specific, curiosity-driving opener', () => {
    const h = hookStrength('Why 82% of your posts never get read.');
    expect(h.score).toBeGreaterThan(75);
    expect(h.strengths.join(' ')).toMatch(/number/i);
  });

  it('penalizes generic corporate openers', () => {
    const weak = hookStrength(
      "We're excited to announce that our company has some news to share today.",
    );
    const strong = hookStrength('Stop writing 3-paragraph intros.');
    expect(weak.score).toBeLessThan(strong.score);
    expect(weak.weaknesses.join(' ')).toMatch(/filler/i);
  });

  it('penalizes an over-long opening line', () => {
    const long = hookStrength(
      'There are many different considerations that a marketing team should ' +
        'probably think about when they are planning what to post next quarter.',
    );
    expect(long.weaknesses.join(' ')).toMatch(/words/i);
  });

  it('never returns a score outside 0-100', () => {
    const h = hookStrength(
      'In today, maybe perhaps arguably we are excited to sort of announce something.',
    );
    expect(h.score).toBeGreaterThanOrEqual(0);
    expect(h.score).toBeLessThanOrEqual(100);
  });
});

describe('ctaEffectiveness', () => {
  it('ranks a closing question highest', () => {
    const r = ctaEffectiveness('We changed our pricing. What would you have done?');
    expect(r.present).toBe(true);
    expect(r.kind).toBe('question');
    expect(r.score).toBeGreaterThan(70);
  });

  it('ranks a bare link lowest and explains why', () => {
    const r = ctaEffectiveness('We wrote it all up. https://example.com/post');
    expect(r.kind).toBe('link');
    expect(r.score).toBeLessThan(60);
    expect(r.notes.join(' ')).toMatch(/reach/i);
  });

  it('reports a missing call to action', () => {
    const r = ctaEffectiveness('We shipped a thing. It works well. That is all.');
    expect(r.present).toBe(false);
    expect(r.score).toBe(0);
    expect(r.notes.join(' ')).toMatch(/no call to action/i);
  });

  it('marks a vague ask down', () => {
    const vague = ctaEffectiveness('We changed pricing. Thoughts?');
    const specific = ctaEffectiveness(
      'We changed pricing. Which model would you rather be billed on?',
    );
    expect(vague.score).toBeLessThan(specific.score);
  });
});

describe('structure', () => {
  it('rewards scannable paragraphs and a sane hashtag count', () => {
    const text = ['First idea here.', 'Second idea here.', 'Third idea here.'].join(
      '\n\n',
    );
    const s = structure(`${text} ${'word '.repeat(60)}`, 4);
    expect(s.paragraphCount).toBe(3);
    expect(s.score).toBeGreaterThan(70);
  });

  it('flags hashtag spam', () => {
    const s = structure('Short post.', 12);
    expect(s.notes.join(' ')).toMatch(/spam/i);
  });
});

describe('predictEngagement', () => {
  it('weights the hook most heavily', () => {
    const goodHook = predictEngagement({
      hook: 90,
      cta: 40,
      readability: 60,
      structure: 60,
    });
    const goodEverythingElse = predictEngagement({
      hook: 40,
      cta: 90,
      readability: 90,
      structure: 90,
    });
    expect(goodHook.score).toBeGreaterThan(
      goodEverythingElse.score - 20,
    );
  });

  it('names the drivers behind the band', () => {
    const p = predictEngagement({
      hook: 30,
      cta: 20,
      readability: 30,
      structure: 30,
    });
    expect(p.band).toBe('below average');
    expect(p.drivers).toContain('weak opening line');
    expect(p.drivers).toContain('missing call to action');
  });
});
