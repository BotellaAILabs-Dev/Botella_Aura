import type { ContentDraft } from '@prisma/client';

import { renderForManual } from '@/server/content/render';
import { engagementScore, type PerfMetrics } from '@/server/memory/metrics';
import { bodySchemaFor, type ContentTypeKey } from '@/lib/validations/content';
import {
  ctaEffectiveness,
  hookStrength,
  predictEngagement,
  readability,
  structure,
} from '@/server/intelligence/text-metrics';
import type {
  ContentIntelligence,
  ContentPiece,
  ScoreBlock,
} from '@/server/intelligence/types';

/**
 * Content Intelligence — measures every recent draft on the dimensions that
 * decide whether a post works: hook, readability, CTA, structure, and the
 * engagement those predict.
 *
 * The scores are computed from the draft text itself (server/intelligence/
 * text-metrics.ts), so they exist the moment a draft does — you do not have to
 * publish and wait to find out a hook is weak.
 */
function unavailable(basis: string, recommendation?: string): ScoreBlock {
  return { score: null, hasData: false, basis, ...(recommendation ? { recommendation } : {}) };
}

function average(values: number[]): number {
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/** Hashtag count per content type (they live in different body shapes). */
function hashtagsOf(draft: ContentDraft): string[] {
  const type = draft.type as ContentTypeKey;
  const parsed = bodySchemaFor(type).safeParse(draft.body);
  if (!parsed.success) return [];
  const body = parsed.data as { hashtags?: string[]; tags?: string[] };
  return body.hashtags ?? body.tags ?? [];
}

export interface AnalysedDraft {
  draft: ContentDraft;
  text: string;
  hashtags: string[];
}

/** Render drafts to plain text once; every metric works from the same string. */
export function prepareDrafts(drafts: ContentDraft[]): AnalysedDraft[] {
  return drafts
    .map((draft) => ({
      draft,
      text: renderForManual(draft),
      hashtags: hashtagsOf(draft),
    }))
    .filter((d) => d.text.trim().length > 20);
}

export function analyseContent(
  prepared: AnalysedDraft[],
  performanceByDraft: Map<string, PerfMetrics[]>,
): ContentIntelligence {
  if (prepared.length === 0) {
    const none = unavailable(
      'No drafts with enough text to analyse yet.',
      'Generate a draft in Content Studio — quality scores appear immediately, before you publish.',
    );
    return {
      quality: none,
      hookStrength: none,
      readability: none,
      ctaEffectiveness: none,
      engagementPrediction: none,
      performance: unavailable('No published posts with captured metrics yet.'),
      pieces: [],
      predictionAccuracy: {
        checked: 0,
        note: 'Publish posts and sync their metrics to see how well predictions match reality.',
      },
    };
  }

  const pieces: ContentPiece[] = prepared.map(({ draft, text, hashtags }) => {
    const hook = hookStrength(text);
    const read = readability(text);
    const cta = ctaEffectiveness(text);
    const struct = structure(text, hashtags.length);
    const prediction = predictEngagement({
      hook: hook.score,
      cta: cta.score,
      readability: read.score,
      structure: struct.score,
    });

    // Overall quality weights the levers by how much they change outcomes.
    const qualityScore = Math.round(
      hook.score * 0.35 +
        cta.score * 0.2 +
        Math.min(read.score, 85) * 0.2 +
        struct.score * 0.25,
    );

    const snapshots = performanceByDraft.get(draft.id) ?? [];
    const actualEngagement = snapshots.length
      ? Math.max(...snapshots.map((m) => engagementScore(m)))
      : null;

    return {
      draftId: draft.id,
      title: draft.title ?? text.slice(0, 60),
      type: draft.type,
      status: draft.status,
      publishedAt: draft.publishedAt ? draft.publishedAt.toISOString() : null,
      qualityScore,
      hook: {
        score: hook.score,
        text: hook.hook,
        strengths: hook.strengths,
        weaknesses: hook.weaknesses,
      },
      readability: {
        score: read.score,
        gradeLevel: read.gradeLevel,
        verdict: read.verdict,
      },
      cta: {
        score: cta.score,
        present: cta.present,
        kind: cta.kind,
        notes: cta.notes,
      },
      structure: {
        score: struct.score,
        wordCount: struct.wordCount,
        hashtagCount: struct.hashtagCount,
        notes: struct.notes,
      },
      prediction: {
        score: prediction.score,
        band: prediction.band,
        drivers: prediction.drivers,
      },
      actualEngagement,
    };
  });

  // Worst first — this list is a work queue, not a leaderboard.
  pieces.sort((a, b) => a.qualityScore - b.qualityScore);

  const n = pieces.length;
  const quality = average(pieces.map((p) => p.qualityScore));
  const hook = average(pieces.map((p) => p.hook.score));
  const read = average(pieces.map((p) => p.readability.score));
  const cta = average(pieces.map((p) => p.cta.score));
  const pred = average(pieces.map((p) => p.prediction.score));

  const withCta = pieces.filter((p) => p.cta.present).length;
  const measured = pieces.filter((p) => p.actualEngagement !== null);

  const performance: ScoreBlock = measured.length
    ? {
        score: (() => {
          // Score published performance against this company's own median, so
          // a small account is not punished for not being a big one.
          const values = measured
            .map((p) => p.actualEngagement!)
            .sort((a, b) => a - b);
          const median = values[Math.floor(values.length / 2)] ?? 0;
          const top = values[values.length - 1] ?? 0;
          if (top === 0) return 0;
          return Math.min(100, Math.round((median / top) * 100));
        })(),
        hasData: true,
        basis: `Measured engagement on ${measured.length} published post${measured.length === 1 ? '' : 's'}, scored against your own best performer.`,
        detail: {
          postsMeasured: measured.length,
          bestEngagement: Math.max(...measured.map((p) => p.actualEngagement!)),
        },
      }
    : unavailable(
        'No published post has captured metrics yet.',
        'Sync a published post from the browser extension, or enter its numbers manually, to turn predictions into measurements.',
      );

  // Where we have both a prediction and a measurement, say how they line up.
  let accuracyNote =
    'Publish posts and sync their metrics to see how well predictions match reality.';
  if (measured.length >= 4) {
    const sorted = [...measured].sort(
      (a, b) => b.actualEngagement! - a.actualEngagement!,
    );
    const topHalf = sorted.slice(0, Math.ceil(sorted.length / 2));
    const bottomHalf = sorted.slice(Math.ceil(sorted.length / 2));
    const topPred = average(topHalf.map((p) => p.prediction.score));
    const bottomPred = average(bottomHalf.map((p) => p.prediction.score));
    accuracyNote =
      topPred > bottomPred
        ? `Predictions are tracking: your best-performing posts scored ${topPred} on average vs ${bottomPred} for the rest.`
        : `Predictions are not tracking your results yet (${topPred} vs ${bottomPred}). Treat the scores as writing guidance rather than a forecast until more posts are measured.`;
  }

  return {
    quality: {
      score: quality,
      hasData: true,
      basis: `Average of hook, readability, call to action, and structure across ${n} draft${n === 1 ? '' : 's'}.`,
      recommendation:
        quality < 60
          ? 'Start with the lowest-scoring pieces below — the hook usually moves this number most.'
          : undefined,
      detail: { draftsAnalysed: n },
    },
    hookStrength: {
      score: hook,
      hasData: true,
      basis: `First line of ${n} draft${n === 1 ? '' : 's'}, scored on length, specificity, tension, and filler openers.`,
      recommendation:
        hook < 60
          ? 'Rewrite openings to one short line with a concrete number or a claim worth arguing with.'
          : undefined,
      detail: {
        weakHooks: pieces.filter((p) => p.hook.score < 50).length,
      },
    },
    readability: {
      score: read,
      hasData: true,
      basis: `Flesch Reading Ease across ${n} draft${n === 1 ? '' : 's'} (60–80 is the target for social).`,
      recommendation:
        read < 50
          ? 'Shorten sentences and replace long words — the copy currently reads like documentation.'
          : read > 88
            ? 'Copy is extremely simple; add specifics so it does not read as thin.'
            : undefined,
      detail: {
        avgGradeLevel:
          Math.round(
            (pieces.reduce((s, p) => s + p.readability.gradeLevel, 0) / n) * 10,
          ) / 10,
      },
    },
    ctaEffectiveness: {
      score: cta,
      hasData: true,
      basis: `${withCta} of ${n} draft${n === 1 ? '' : 's'} end with a clear ask; scored by the kind of ask.`,
      recommendation:
        withCta < n
          ? `${n - withCta} draft${n - withCta === 1 ? '' : 's'} have no call to action — add one specific question at the end.`
          : undefined,
      detail: { draftsWithCta: withCta, draftsWithoutCta: n - withCta },
    },
    engagementPrediction: {
      score: pred,
      hasData: true,
      basis:
        'Predicted from hook, call to action, readability, and structure — a forecast from the writing, not a measurement.',
      detail: {
        strongPieces: pieces.filter((p) => p.prediction.score >= 75).length,
        weakPieces: pieces.filter((p) => p.prediction.score < 45).length,
      },
    },
    performance,
    pieces,
    predictionAccuracy: { checked: measured.length, note: accuracyNote },
  };
}
