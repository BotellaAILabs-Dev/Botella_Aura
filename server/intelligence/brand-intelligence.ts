import { words } from '@/server/intelligence/text-metrics';
import type { BrandVoiceProfile } from '@/lib/validations/content';
import type {
  BrandIntelligence,
  ScoreBlock,
  ToneFinding,
} from '@/server/intelligence/types';
import type { AnalysedDraft } from '@/server/intelligence/content-intelligence';

/**
 * Brand Intelligence — does the content actually sound like the brand profile
 * says it should?
 *
 * Tone is checked against observable proxies rather than vibes: a profile that
 * says "concise" is tested by sentence length, "conversational" by second-person
 * address, "no hype" by superlative density. That keeps the verdict explainable
 * — every finding names the thing it measured.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are',
  'how', 'why', 'what', 'new', 'now', 'has', 'have', 'will', 'can', 'about',
  'into', 'out', 'its', 'their', 'a', 'an', 'to', 'of', 'in', 'on', 'is',
  'it', 'we', 'our', 'they', 'them', 'but', 'not', 'was', 'were', 'be', 'been',
  'as', 'at', 'by', 'or', 'if', 'so', 'do', 'does', 'did', 'just', 'more',
  'most', 'than', 'then', 'there', 'here', 'when', 'who', 'all', 'any', 'up',
]);

const HYPE_WORDS = [
  'revolutionary', 'game-changing', 'game changing', 'cutting-edge',
  'world-class', 'best-in-class', 'unparalleled', 'seamless', 'synergy',
  'disruptive', 'unprecedented', 'incredible', 'amazing', 'ultimate',
  'leverage', 'robust', 'turnkey',
];

interface ToneProbe {
  /** Descriptors this probe can judge (lowercase substrings). */
  matches: string[];
  /** Returns 0–1 adherence for one piece of text. */
  test: (text: string) => number;
  /** What the probe measured, for the explanation line. */
  measured: string;
}

const PROBES: ToneProbe[] = [
  {
    matches: ['concise', 'brief', 'short', 'punchy', 'direct'],
    measured: 'average sentence length',
    test: (text) => {
      const sentenceCount = text.split(/[.!?]+/).filter((s) => s.trim()).length || 1;
      const avg = words(text).length / sentenceCount;
      // 12 words/sentence is ideal for "concise"; 28+ is not concise at all.
      return Math.max(0, Math.min(1, (28 - avg) / 16));
    },
  },
  {
    matches: ['conversational', 'friendly', 'approachable', 'human', 'warm'],
    measured: 'use of "you"/"your" and contractions',
    test: (text) => {
      const w = words(text);
      const second = w.filter((x) => x === 'you' || x === 'your').length;
      const contractions = (text.match(/['’](s|re|ve|ll|t|d|m)\b/gi) ?? []).length;
      const density = (second + contractions) / Math.max(1, w.length / 100);
      return Math.max(0, Math.min(1, density / 6));
    },
  },
  {
    matches: ['professional', 'formal', 'authoritative', 'expert'],
    measured: 'absence of slang and exclamation marks',
    test: (text) => {
      const exclamations = (text.match(/!/g) ?? []).length;
      const slang = (text.match(/\b(gonna|wanna|kinda|super|totally|lol)\b/gi) ?? [])
        .length;
      return Math.max(0, 1 - exclamations * 0.15 - slang * 0.25);
    },
  },
  {
    matches: ['no hype', 'no-hype', 'honest', 'plain', 'practical', 'no fluff', 'grounded'],
    measured: 'density of hype words and superlatives',
    test: (text) => {
      const lower = text.toLowerCase();
      const hits = HYPE_WORDS.filter((h) => lower.includes(h)).length;
      const superlatives = (lower.match(/\b\w+est\b/g) ?? []).length;
      return Math.max(0, 1 - hits * 0.2 - superlatives * 0.05);
    },
  },
  {
    matches: ['data', 'evidence', 'specific', 'concrete', 'analytical', 'technical'],
    measured: 'presence of numbers and concrete detail',
    test: (text) => {
      const numbers = (text.match(/\b\d[\d,.%]*\b/g) ?? []).length;
      const per100 = numbers / Math.max(1, words(text).length / 100);
      return Math.max(0, Math.min(1, per100 / 3));
    },
  },
  {
    matches: ['playful', 'witty', 'bold', 'irreverent', 'energetic'],
    measured: 'questions, short punchy lines, and direct claims',
    test: (text) => {
      const questions = (text.match(/\?/g) ?? []).length;
      const shortLines = text
        .split(/\n+/)
        .filter((l) => l.trim() && words(l).length <= 8).length;
      return Math.max(0, Math.min(1, (questions + shortLines) / 6));
    },
  },
];

function unavailable(basis: string, recommendation?: string): ScoreBlock {
  return {
    score: null,
    hasData: false,
    basis,
    ...(recommendation ? { recommendation } : {}),
  };
}

export function analyseBrand(
  prepared: AnalysedDraft[],
  profile: BrandVoiceProfile | null,
): BrandIntelligence {
  if (!profile) {
    return {
      consistency: unavailable(
        'No brand voice profile has been generated yet.',
        'Generate your brand voice profile in Settings → Knowledge base — every score here is measured against it.',
      ),
      toneValidation: {
        hasProfile: false,
        findings: [],
        note: 'Tone can only be validated against a saved brand voice profile.',
      },
      vocabulary: {
        onBrand: [],
        underused: [],
        driftingInto: [],
        violations: [],
        recommendations: [
          'Generate a brand voice profile so vocabulary can be checked against something real.',
        ],
      },
    };
  }

  if (prepared.length === 0) {
    return {
      consistency: unavailable(
        'You have a brand voice profile, but no drafts with enough text to check against it.',
        'Generate a draft in Content Studio to see how closely it matches your brand voice.',
      ),
      toneValidation: {
        hasProfile: true,
        findings: [],
        note: 'No content to validate yet.',
      },
      vocabulary: {
        onBrand: [],
        underused: profile.vocabulary.slice(0, 10),
        driftingInto: [],
        violations: [],
        recommendations: [
          'Your brand vocabulary is defined but unused — the first drafts will show whether it lands naturally.',
        ],
      },
    };
  }

  // --- Tone validation ----------------------------------------------------
  const findings: ToneFinding[] = [];
  for (const descriptor of profile.toneDescriptors) {
    const d = descriptor.toLowerCase();
    const probe = PROBES.find((p) => p.matches.some((m) => d.includes(m)));
    if (!probe) {
      // Be honest that we cannot measure this one rather than inventing a score.
      findings.push({
        descriptor,
        adherence: 0,
        verdict: 'absent',
        note: `We do not have an objective test for "${descriptor}" — the AI suggestions below assess it qualitatively instead.`,
      });
      continue;
    }
    const scores = prepared.map((p) => probe.test(p.text));
    const adherence =
      scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
    const verdict: ToneFinding['verdict'] =
      adherence >= 0.7 ? 'consistent' : adherence >= 0.4 ? 'drifting' : 'absent';
    findings.push({
      descriptor,
      adherence: Math.round(adherence * 100) / 100,
      verdict,
      note:
        verdict === 'consistent'
          ? `Content matches "${descriptor}" — measured by ${probe.measured}.`
          : verdict === 'drifting'
            ? `Content only partly matches "${descriptor}" (${probe.measured}). Some pieces drift.`
            : `Content does not read as "${descriptor}" — ${probe.measured} says otherwise.`,
    });
  }

  // Only descriptors we can actually measure feed the consistency score.
  const measurable = findings.filter((f) =>
    PROBES.some((p) => p.matches.some((m) => f.descriptor.toLowerCase().includes(m))),
  );

  // --- Vocabulary ---------------------------------------------------------
  const corpus = prepared.map((p) => p.text.toLowerCase()).join('\n');
  const corpusWords = words(corpus);
  const freq = new Map<string, number>();
  for (const w of corpusWords) {
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }

  const onBrand: string[] = [];
  const underused: string[] = [];
  for (const term of profile.vocabulary) {
    const t = term.toLowerCase().trim();
    if (!t) continue;
    if (corpus.includes(t)) onBrand.push(term);
    else underused.push(term);
  }

  const violations = profile.topicsToAvoid.filter((topic) => {
    const t = topic.toLowerCase().trim();
    return t.length >= 3 && corpus.includes(t);
  });

  // Frequent content words that the brand profile never mentions — the
  // vocabulary the writing is drifting toward.
  const brandTerms = new Set(
    [...profile.vocabulary, ...profile.commonPhrases].map((v) => v.toLowerCase()),
  );
  const driftingInto = [...freq.entries()]
    .filter(([w, count]) => count >= Math.max(2, prepared.length) && !brandTerms.has(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);

  const hypeUsed = HYPE_WORDS.filter((h) => corpus.includes(h));

  const recommendations: string[] = [];
  if (underused.length > 0) {
    recommendations.push(
      `Your brand vocabulary defines ${underused.length} term${underused.length === 1 ? '' : 's'} the content never uses (${underused.slice(0, 5).join(', ')}). Either work them in or drop them from the profile — an aspirational glossary nobody uses is noise.`,
    );
  }
  if (violations.length > 0) {
    recommendations.push(
      `Content mentions topics your profile says to avoid: ${violations.join(', ')}. Review those drafts before publishing.`,
    );
  }
  if (hypeUsed.length > 0) {
    recommendations.push(
      `Hype words are creeping in (${hypeUsed.slice(0, 4).join(', ')}). Replace each with the specific thing it is standing in for.`,
    );
  }
  if (driftingInto.length > 0) {
    recommendations.push(
      `These words dominate your content but are not in your brand profile: ${driftingInto.slice(0, 5).join(', ')}. If they are genuinely your language, add them to the profile so future generations lean on them deliberately.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      'Vocabulary is aligned with your brand profile — nothing to correct.',
    );
  }

  // --- Consistency score --------------------------------------------------
  const toneComponent = measurable.length
    ? measurable.reduce((sum, f) => sum + f.adherence, 0) / measurable.length
    : null;
  const vocabComponent =
    profile.vocabulary.length > 0
      ? onBrand.length / profile.vocabulary.length
      : null;
  const penalty = Math.min(0.4, violations.length * 0.15 + hypeUsed.length * 0.05);

  const parts = [toneComponent, vocabComponent].filter(
    (v): v is number => v !== null,
  );

  const consistency: ScoreBlock = parts.length
    ? {
        score: Math.max(
          0,
          Math.min(
            100,
            Math.round(
              (parts.reduce((a, b) => a + b, 0) / parts.length - penalty) * 100,
            ),
          ),
        ),
        hasData: true,
        basis: [
          measurable.length
            ? `${measurable.length} measurable tone descriptor${measurable.length === 1 ? '' : 's'}`
            : null,
          vocabComponent !== null
            ? `${onBrand.length}/${profile.vocabulary.length} brand terms in use`
            : null,
          `across ${prepared.length} draft${prepared.length === 1 ? '' : 's'}`,
        ]
          .filter(Boolean)
          .join(', '),
        recommendation:
          violations.length > 0
            ? 'Fix the topics-to-avoid violations first — those are explicit rule breaks, not style drift.'
            : undefined,
        detail: {
          brandTermsUsed: onBrand.length,
          brandTermsDefined: profile.vocabulary.length,
          violations: violations.length,
        },
      }
    : unavailable(
        'Your brand profile has no measurable tone descriptors or vocabulary yet.',
        'Add tone descriptors and a few signature terms to your brand voice profile so consistency can be measured.',
      );

  return {
    consistency,
    toneValidation: {
      hasProfile: true,
      findings,
      note: measurable.length
        ? `${measurable.length} of ${findings.length} descriptor${findings.length === 1 ? '' : 's'} could be checked objectively; the rest are assessed in the AI suggestions.`
        : 'None of your tone descriptors map to an objective test — the AI suggestions assess them instead.',
    },
    vocabulary: {
      onBrand,
      underused,
      driftingInto,
      violations,
      recommendations,
    },
  };
}
