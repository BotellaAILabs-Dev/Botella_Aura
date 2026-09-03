import { sha256 } from '@/lib/crypto';
import {
  completeStructured,
  isClaudeConfigured,
  DEFAULT_MODEL,
} from '@/server/ai/claude';
import { z } from 'zod';
import { logger } from '@/lib/logger';

/**
 * Website change-detection + summarization (Sprint 4, Module 1).
 *
 * The functions in the first block are PURE and deterministic — they are the
 * fixture-tested core (NON-NEGOTIABLE #7): normalize text, hash it for fast
 * change detection, and compute a bounded line-level diff. Only when a textual
 * change is detected do we spend a Claude call to describe it in plain English.
 */

/** Collapse whitespace and trim so cosmetic reflows don't register as changes. */
export function normalizeText(input: string): string {
  return input
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Stable content hash of normalized text (fast "did anything change?" check). */
export function hashText(input: string): string {
  return sha256(normalizeText(input));
}

export interface TextDiff {
  changed: boolean;
  /** Lines present now but not before (bounded sample). */
  added: string[];
  /** Lines present before but not now (bounded sample). */
  removed: string[];
}

/**
 * Line-level diff between two page snapshots. Deterministic and dependency-free
 * so it is fully unit-testable. Samples are bounded to keep the Claude prompt
 * (and the stored summary) small.
 */
export function diffTexts(
  previous: string | null | undefined,
  next: string,
  sampleLimit = 40,
): TextDiff {
  const nextNorm = normalizeText(next);
  if (previous == null) {
    // First capture — everything is "new", but we don't flood the summary.
    return { changed: false, added: [], removed: [] };
  }
  const prevNorm = normalizeText(previous);
  if (prevNorm === nextNorm) return { changed: false, added: [], removed: [] };

  const prevLines = new Set(prevNorm.split('\n'));
  const nextLines = new Set(nextNorm.split('\n'));

  const added: string[] = [];
  for (const line of nextLines) {
    if (!prevLines.has(line) && line.length > 2) {
      added.push(line);
      if (added.length >= sampleLimit) break;
    }
  }
  const removed: string[] = [];
  for (const line of prevLines) {
    if (!nextLines.has(line) && line.length > 2) {
      removed.push(line);
      if (removed.length >= sampleLimit) break;
    }
  }

  return { changed: added.length > 0 || removed.length > 0, added, removed };
}

const changeSummarySchema = z.object({
  summary: z.string(),
});

/**
 * Turn a computed diff into a human-readable one/two-sentence summary using
 * Claude. Falls back to a deterministic description when the API key is absent
 * or the call fails — the pipeline never breaks on a summarization failure.
 * Returns `{ text, model }` so callers can record provenance.
 */
export async function summarizeChange(args: {
  competitorName: string;
  pageLabel: string; // 'homepage' | 'pricing page'
  diff: TextDiff;
}): Promise<{ text: string; model: string }> {
  const { competitorName, pageLabel, diff } = args;
  if (!diff.changed) return { text: '', model: 'none' };

  const deterministic = deterministicSummary(pageLabel, diff);
  if (!isClaudeConfigured()) return { text: deterministic, model: 'none' };

  try {
    const result = await completeStructured({
      schema: changeSummarySchema,
      system:
        'You are a competitive-intelligence analyst. Given the added and removed ' +
        'text lines from a competitor web page, describe WHAT MATERIALLY CHANGED ' +
        'in 1-2 concise, factual sentences a marketer can act on. Ignore cosmetic ' +
        'or navigational noise. Respond with ONLY JSON: {"summary": string}.',
      prompt: [
        `Competitor: ${competitorName}`,
        `Page: ${pageLabel}`,
        `ADDED lines:\n${diff.added.slice(0, 30).join('\n') || '(none)'}`,
        `REMOVED lines:\n${diff.removed.slice(0, 30).join('\n') || '(none)'}`,
      ].join('\n\n'),
      maxTokens: 400,
      effort: 'low',
      tier: 'cheap',
    });
    const text = result.summary.trim();
    return { text: text || deterministic, model: DEFAULT_MODEL };
  } catch (err) {
    logger.warn('competitors: change summarization failed, using fallback', {
      competitor: competitorName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { text: deterministic, model: 'none' };
  }
}

/** Deterministic, no-AI description used as a fallback. */
export function deterministicSummary(pageLabel: string, diff: TextDiff): string {
  const parts: string[] = [];
  if (diff.added.length)
    parts.push(`${diff.added.length} new line(s) added`);
  if (diff.removed.length)
    parts.push(`${diff.removed.length} line(s) removed`);
  const head = diff.added[0] ?? diff.removed[0];
  const preview = head ? ` e.g. "${head.slice(0, 120)}"` : '';
  return `The ${pageLabel} changed — ${parts.join(', ')}.${preview}`;
}

const positioningSchema = z.object({ summary: z.string() });

/**
 * Summarize what a competitor page SAYS today (positioning, claims, headline
 * offers, price points). Used only on the first-ever capture, where there is no
 * previous snapshot to diff against.
 *
 * Without this, a freshly-added competitor produced an empty weekly report —
 * technically correct ("nothing changed") but indistinguishable from a broken
 * pipeline, which is exactly how it was read in review.
 */
export async function summarizePositioning(args: {
  competitorName: string;
  pageLabel: string;
  pageText: string;
}): Promise<{ text: string; model: string }> {
  const { competitorName, pageLabel, pageText } = args;
  const deterministic = deterministicPositioning(pageLabel, pageText);
  if (!isClaudeConfigured()) return { text: deterministic, model: 'none' };

  try {
    const result = await completeStructured({
      schema: positioningSchema,
      system:
        'You are a competitive-intelligence analyst. Given the visible text of a ' +
        "competitor's web page, summarize their CURRENT positioning in 1-2 factual " +
        'sentences a marketer can act on: who they say they are for, the headline ' +
        'claim or offer, and any explicit price points. Use only what is in the ' +
        'text — invent nothing. Respond with ONLY JSON: {"summary": string}.',
      prompt: [
        `Competitor: ${competitorName}`,
        `Page: ${pageLabel}`,
        `Visible text:\n${normalizeText(pageText).slice(0, 4000)}`,
      ].join('\n\n'),
      maxTokens: 400,
      effort: 'low',
      tier: 'cheap',
    });
    const text = result.summary.trim();
    return { text: text || deterministic, model: DEFAULT_MODEL };
  } catch (err) {
    logger.warn('competitors: positioning summarization failed, using fallback', {
      competitor: competitorName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { text: deterministic, model: 'none' };
  }
}

/** Deterministic baseline: the first substantial lines of the page. */
export function deterministicPositioning(
  pageLabel: string,
  pageText: string,
): string {
  const lines = normalizeText(pageText)
    .split('\n')
    .filter((l) => l.length >= 25)
    .slice(0, 3);
  if (lines.length === 0) {
    return `Baseline captured for the ${pageLabel} — we'll report changes from the next run.`;
  }
  return `Current ${pageLabel} messaging: "${lines.join(' ').slice(0, 300)}"`;
}
