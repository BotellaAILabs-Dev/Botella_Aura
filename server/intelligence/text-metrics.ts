/**
 * Deterministic text metrics behind Content Intelligence.
 *
 * Everything here is pure and unit-testable: the same draft always produces the
 * same numbers, with no model call. That matters because these scores are shown
 * as measurements, not opinions — a "readability 62" that drifts every refresh
 * would be worthless. The AI layer sits on top and explains these numbers; it
 * never replaces them.
 */

const VOWELS = /[aeiouy]+/g;

/**
 * Split text into sentences.
 *
 * Line breaks are treated as sentence boundaries BEFORE whitespace is
 * collapsed. Social copy is full of bulleted and one-thought-per-line posts
 * that carry no terminating punctuation; collapsing newlines first fuses a
 * ten-line post into a single 90-word "sentence" and drags readability and
 * hook scores far below the truth.
 */
export function sentences(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .flatMap((line) =>
      line
        // Drop a leading bullet or list marker so it is not counted as a word.
        .replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, '')
        .split(/(?<=[.!?])\s+/),
    )
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence.length > 0);
}

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^a-z0-9'’-]+/)
    .filter((w) => w.length > 0);
}

/**
 * Syllable estimate for a single English word. The classic vowel-group
 * heuristic: good enough for Flesch, and deterministic.
 */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '');
  const groups = trimmed.match(VOWELS);
  return Math.max(1, groups ? groups.length : 1);
}

export interface ReadabilityResult {
  /** Flesch Reading Ease, 0–100 (higher = easier). Clamped. */
  score: number;
  /** Approximate US school grade needed to read it comfortably. */
  gradeLevel: number;
  avgSentenceLength: number;
  avgSyllablesPerWord: number;
  /** Plain-English verdict for the UI. */
  verdict: string;
}

/**
 * Flesch Reading Ease. Social copy should land around 60–80: below ~40 reads
 * like a contract, above ~90 reads like a children's book.
 */
export function readability(text: string): ReadabilityResult {
  const sents = sentences(text);
  const ws = words(text);
  if (sents.length === 0 || ws.length === 0) {
    return {
      score: 0,
      gradeLevel: 0,
      avgSentenceLength: 0,
      avgSyllablesPerWord: 0,
      verdict: 'Not enough text to measure.',
    };
  }

  const syllableCount = ws.reduce((sum, w) => sum + syllables(w), 0);
  const avgSentenceLength = ws.length / sents.length;
  const avgSyllablesPerWord = syllableCount / ws.length;

  const raw =
    206.835 - 1.015 * avgSentenceLength - 84.6 * avgSyllablesPerWord;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const gradeLevel =
    Math.round(
      (0.39 * avgSentenceLength + 11.8 * avgSyllablesPerWord - 15.59) * 10,
    ) / 10;

  let verdict: string;
  if (score >= 80) verdict = 'Very easy to read — good for social.';
  else if (score >= 60) verdict = 'Plain and clear — the right range for social.';
  else if (score >= 45)
    verdict = 'Fairly dense. Shorten sentences and swap long words for short ones.';
  else
    verdict =
      'Hard to read. Long sentences and complex words are costing you readers.';

  return {
    score,
    gradeLevel: Math.max(0, gradeLevel),
    avgSentenceLength: Math.round(avgSentenceLength * 10) / 10,
    avgSyllablesPerWord: Math.round(avgSyllablesPerWord * 100) / 100,
    verdict,
  };
}

export interface HookResult {
  score: number; // 0–100
  /** What the hook does well. */
  strengths: string[];
  /** Concrete, actionable weaknesses. */
  weaknesses: string[];
  hook: string;
}

const WEAK_OPENERS = [
  'in today',
  'in this article',
  'we are excited',
  "we're excited",
  'i am pleased',
  "i'm pleased",
  'as we all know',
  'it is important to',
  'in the world of',
  'let me tell you',
  'thrilled to announce',
];

const CURIOSITY_MARKERS = [
  'why',
  'how',
  'what',
  'nobody',
  'no one',
  'most people',
  'stop',
  'never',
  'the truth',
  'mistake',
  'wrong',
  'secret',
  'here is',
  "here's",
];

/**
 * Hook strength: does the first line earn the second?
 *
 * Scored on the things that measurably predict a scroll-stop — brevity, a
 * concrete number, specificity, a curiosity or tension marker — and penalised
 * for the generic openers that signal filler.
 */
export function hookStrength(text: string): HookResult {
  const hook = (sentences(text)[0] ?? text.slice(0, 200)).trim();
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  if (!hook) {
    return { score: 0, strengths, weaknesses: ['No opening line found.'], hook: '' };
  }

  const lower = hook.toLowerCase();
  const wordCount = words(hook).length;
  let score = 45; // neutral baseline

  // Length: short hooks stop the scroll; long ones get truncated by the feed.
  if (wordCount <= 12) {
    score += 15;
    strengths.push('Short enough to land before the "see more" cut.');
  } else if (wordCount <= 20) {
    score += 6;
  } else {
    score -= 12;
    weaknesses.push(
      `The opening line is ${wordCount} words — feeds truncate around 12–15. Cut it to one idea.`,
    );
  }

  // A concrete number is the cheapest specificity there is.
  if (/\d/.test(hook)) {
    score += 12;
    strengths.push('Opens with a concrete number.');
  } else {
    weaknesses.push('No number or concrete detail — add one specific fact.');
  }

  // Curiosity / tension.
  if (CURIOSITY_MARKERS.some((m) => lower.includes(m))) {
    score += 12;
    strengths.push('Creates a question the reader wants answered.');
  } else {
    weaknesses.push(
      'No tension or question — give the reader a reason to keep reading.',
    );
  }

  // Direct address builds relevance fast.
  if (/\b(you|your)\b/i.test(hook)) {
    score += 8;
    strengths.push('Speaks directly to the reader.');
  }

  // Generic corporate openers.
  const weakOpener = WEAK_OPENERS.find((o) => lower.startsWith(o));
  if (weakOpener) {
    score -= 22;
    weaknesses.push(
      `Starts with a filler phrase ("${weakOpener}…"). Lead with the point instead.`,
    );
  }

  // Hedging language drains authority.
  if (/\b(maybe|perhaps|might be|sort of|kind of|arguably)\b/i.test(hook)) {
    score -= 8;
    weaknesses.push('Hedging language weakens the claim — commit to a position.');
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    strengths,
    weaknesses,
    hook,
  };
}

export interface CtaResult {
  score: number; // 0–100
  present: boolean;
  /** The detected CTA sentence, if any. */
  cta: string | null;
  kind: 'question' | 'directive' | 'link' | 'none';
  notes: string[];
}

const DIRECTIVE_VERBS =
  /\b(comment|share|repost|download|read|book|try|join|sign up|subscribe|follow|reply|tell me|let me know|check out|register|get)\b/i;

/**
 * CTA effectiveness. A post with no ask gets no action; a post with three asks
 * gets none either. We look at the closing third, where a CTA belongs.
 */
export function ctaEffectiveness(text: string): CtaResult {
  const sents = sentences(text);
  if (sents.length === 0) {
    return { score: 0, present: false, cta: null, kind: 'none', notes: [] };
  }

  const tailStart = Math.max(0, sents.length - Math.max(2, Math.ceil(sents.length / 3)));
  const tail = sents.slice(tailStart);
  const notes: string[] = [];

  const question = tail.find((s) => s.trim().endsWith('?'));
  const directive = tail.find((s) => DIRECTIVE_VERBS.test(s));
  const link = tail.find((s) => /https?:\/\//.test(s));

  let cta: string | null = null;
  let kind: CtaResult['kind'] = 'none';
  let score = 0;

  if (question) {
    cta = question;
    kind = 'question';
    score = 78;
    notes.push('Ends with a question — the strongest driver of comments.');
  } else if (directive) {
    cta = directive;
    kind = 'directive';
    score = 66;
    notes.push('Has a clear ask.');
  } else if (link) {
    cta = link;
    kind = 'link';
    score = 45;
    notes.push(
      'Ends with a link. Links suppress reach — consider asking for a reply and putting the link in the comments.',
    );
  } else {
    notes.push(
      'No call to action in the closing lines. Add one specific ask — a question usually works best.',
    );
  }

  // More than one ask splits the reader's attention.
  const askCount = [question, directive, link].filter(Boolean).length;
  if (askCount > 1) {
    score -= 12;
    notes.push('More than one ask — pick a single action.');
  }

  // A vague ask is barely better than none.
  if (cta && /\b(thoughts|let me know what you think)\b/i.test(cta)) {
    score -= 10;
    notes.push('"Thoughts?" is too vague — ask about something specific.');
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    present: Boolean(cta),
    cta,
    kind,
    notes,
  };
}

export interface StructureResult {
  score: number;
  wordCount: number;
  paragraphCount: number;
  hashtagCount: number;
  notes: string[];
}

/** Formatting signals that affect whether a post gets read at all. */
export function structure(text: string, hashtagCount: number): StructureResult {
  const wordCount = words(text).length;
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const notes: string[] = [];
  let score = 60;

  if (wordCount < 40) {
    score -= 10;
    notes.push('Very short — there may not be enough substance to earn a follow.');
  } else if (wordCount <= 250) {
    score += 15;
  } else if (wordCount <= 400) {
    score += 5;
  } else {
    score -= 10;
    notes.push(
      `${wordCount} words is long for a feed post — consider splitting it into a series.`,
    );
  }

  if (paragraphs.length >= 3) {
    score += 12;
  } else if (wordCount > 120) {
    score -= 10;
    notes.push('Break this into short paragraphs — walls of text lose readers.');
  }

  if (hashtagCount === 0) {
    notes.push('No hashtags — 3–5 relevant ones help discovery.');
  } else if (hashtagCount > 6) {
    score -= 8;
    notes.push(`${hashtagCount} hashtags reads as spam; 3–5 is the sweet spot.`);
  } else {
    score += 8;
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    wordCount,
    paragraphCount: paragraphs.length,
    hashtagCount,
    notes,
  };
}

/**
 * Predicted engagement band, from the quality signals above.
 *
 * This is explicitly a PREDICTION from text features, not a measurement — the
 * UI labels it that way. When we have real performance history the caller
 * calibrates it against the company's own median.
 */
export interface EngagementPrediction {
  /** 0–100 relative score. */
  score: number;
  band: 'below average' | 'average' | 'above average' | 'strong';
  drivers: string[];
}

export function predictEngagement(parts: {
  hook: number;
  cta: number;
  readability: number;
  structure: number;
}): EngagementPrediction {
  // The hook decides whether anything else is read at all, so it dominates.
  const score = Math.round(
    parts.hook * 0.4 +
      parts.cta * 0.25 +
      // Readability helps up to a point; extremely high is not extra credit.
      Math.min(parts.readability, 80) * 0.15 +
      parts.structure * 0.2,
  );

  const drivers: string[] = [];
  if (parts.hook >= 70) drivers.push('strong opening line');
  else if (parts.hook < 45) drivers.push('weak opening line');
  if (parts.cta >= 65) drivers.push('clear call to action');
  else if (parts.cta < 40) drivers.push('missing call to action');
  if (parts.readability < 45) drivers.push('dense language');
  if (parts.structure < 50) drivers.push('hard-to-scan formatting');

  const band: EngagementPrediction['band'] =
    score >= 75 ? 'strong' : score >= 60 ? 'above average' : score >= 45 ? 'average' : 'below average';

  return { score: Math.max(0, Math.min(100, score)), band, drivers };
}
