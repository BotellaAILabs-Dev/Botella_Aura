import type { MemoryConfidence } from '@prisma/client';

/**
 * Pure metrics helpers for Marketing Memory (Sprint 5, Module 2) — fixture-
 * tested. No fabrication: these only transform real numbers that a source
 * actually provided.
 */
export interface PerfMetrics {
  impressions?: number;
  likes?: number;
  comments?: number;
  reposts?: number;
  clicks?: number;
}

/** A single weighted "engagement" scalar for ranking (comments > reposts > likes). */
export function engagementScore(m: PerfMetrics): number {
  return (
    (m.likes ?? 0) +
    (m.comments ?? 0) * 3 +
    (m.reposts ?? 0) * 4 +
    (m.clicks ?? 0) * 2
  );
}

/**
 * Minimum published items (with metrics) before we'll emit ANY insight. Below
 * this we return an honest "not enough data" result instead of guessing.
 */
export const MIN_SAMPLE_FOR_INSIGHTS = 10;

/** Confidence tier derived purely from sample size (transparency). */
export function confidenceFromSample(sampleSize: number): MemoryConfidence {
  if (sampleSize >= 30) return 'HIGH';
  if (sampleSize >= 15) return 'MEDIUM';
  return 'LOW';
}

/** Whether there is enough real data to extract insights at all. */
export function hasEnoughData(sampleSize: number): boolean {
  return sampleSize >= MIN_SAMPLE_FOR_INSIGHTS;
}
