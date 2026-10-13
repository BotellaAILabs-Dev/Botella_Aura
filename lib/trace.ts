import { bodyFingerprint } from '@/lib/versions';

/**
 * Recommendation → content traceability: the chain from the business
 * context to the approved asset, kept on the asset itself
 * (ContentDraft.aiMetadata.trace) so it outlives the records it points at.
 *
 *   Business Context → Signal → Opportunity → Recommendation → Content Brief
 *     → Generated Asset → Reviewed Version → Approved Version
 *
 * The IDs are written when the asset is generated and moved on when it is
 * reviewed and approved; server/trace/trace.service.ts resolves them into
 * the full story and exposes them to analytics. Pure and client-safe.
 */

export interface TraceIds {
  model: 1;
  /** One id for the whole chain — what analytics joins on. */
  traceId: string;
  businessContext: {
    /** The Business Context revision the asset was generated from. */
    revision: string | null;
    /** The context fields the recommendation relied on. */
    fields: string[];
  };
  signalIds: string[];
  opportunityId: string | null;
  recommendationId: string | null;
  /** The Content Brief the asset was written from. */
  briefId: string | null;
  /** Version 1 — what Aura generated. */
  generatedVersion: number;
  /** The version the last review was of, and that review. */
  reviewedVersion: number | null;
  reviewId: string | null;
  /** The version approved, and the approval. */
  approvedVersion: number | null;
  approvalId: string | null;
  /** The images attached when it was approved. */
  mediaAssetIds: string[];
}

export function traceOf(meta: unknown): TraceIds | null {
  const t = (meta as { trace?: TraceIds } | null)?.trace;
  return t && typeof t === 'object' && t.model === 1 ? t : null;
}

/** A Content Brief's id: stable for the same brief. */
export function briefId(brief: unknown): string | null {
  return brief && typeof brief === 'object'
    ? `brf_${bodyFingerprint(brief)}`
    : null;
}

/** An approval's id, unique to the item, its version and the moment. */
export function approvalId(
  itemId: string,
  version: number,
  at: string,
): string {
  return `apv_${bodyFingerprint([itemId, version, at])}`;
}

/** A review's id, unique to the reviewed body and the moment. */
export function reviewId(bodyHash: string, at: string): string {
  return `rvw_${bodyFingerprint([bodyHash, at])}`;
}

export function newTraceId(): string {
  const r = Math.random().toString(36).slice(2, 10);
  return `trc_${Date.now().toString(36)}${r}`;
}

/** The chain's links, in order, for display. */
export const TRACE_LINKS = [
  'business_context',
  'signal',
  'opportunity',
  'recommendation',
  'brief',
  'generated',
  'reviewed',
  'approved',
] as const;
export type TraceLink = (typeof TRACE_LINKS)[number];

export const TRACE_LINK_LABEL: Record<TraceLink, string> = {
  business_context: 'Business context',
  signal: 'Signals',
  opportunity: 'Opportunity',
  recommendation: 'Recommendation',
  brief: 'Content brief',
  generated: 'Generated asset',
  reviewed: 'Reviewed version',
  approved: 'Approved version',
};

/** The resolved chain (server/trace/trace.service.ts). */
export interface ContentTrace {
  ids: TraceIds & { assetId: string };
  /** Why it was created, in a sentence. */
  why: string | null;
  /** Made from Aura's recommendation, or from a person's own brief. */
  origin: 'recommendation' | 'brief';
  businessContext: {
    revision: string | null;
    name: string | null;
    description: string | null;
    fields: string[];
  };
  signals: {
    id: string;
    title: string;
    source: string;
    observedAt: string | null;
    url: string | null;
  }[];
  opportunity: {
    id: string;
    title: string;
    type: string;
    summary: string | null;
    detectedAt: string | null;
    href: string;
  } | null;
  recommendation: {
    id: string;
    title: string;
    why: string | null;
    status: string | null;
    decidedAt: string | null;
    decidedBy: string | null;
  } | null;
  brief: {
    id: string | null;
    keyMessage: string | null;
    goal: string | null;
    audience: string | null;
    channel: string | null;
    request: string | null;
  } | null;
  asset: {
    id: string;
    type: string;
    platform: string | null;
    status: string;
    createdAt: string;
    mediaAssetIds: string[];
  };
  generated: { version: number; at: string | null };
  reviewed: {
    version: number | null;
    id: string | null;
    status: string | null;
    at: string | null;
  } | null;
  approved: {
    version: number | null;
    id: string | null;
    by: string | null;
    via: string | null;
    at: string | null;
  } | null;
  published: { url: string | null; at: string | null } | null;
  /** Which links could not be found (deleted since, or never existed). */
  gaps: TraceLink[];
}
