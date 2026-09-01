/**
 * How confident are we that a drafted message is safe to approve unread?
 *
 * Bulk approval only earns its place if it is selective. "Approve all"
 * transfers the reviewer's judgement to a button; a threshold means the batch
 * is limited to drafts whose grounding we can actually point at, and everything
 * weaker stays in the queue for a human to read.
 *
 * Every factor is a real property of the draft — not a model self-rating, which
 * would be exactly the kind of unearned confidence this is meant to prevent.
 */
export interface ConfidenceInput {
  /** Was a real model used, or the deterministic fallback? */
  model?: string | null;
  brandVoiceApplied?: boolean;
  /** Was a concrete public signal cited when drafting? */
  hasSignal: boolean;
  /** AI fit score of the lead this message targets. */
  fitScore?: number | null;
  /** Do we know who we are writing to? */
  hasContactName: boolean;
  hasLinkedInUrl: boolean;
  draftText: string;
  /** Connection notes have a hard length limit on LinkedIn. */
  type: string;
}

export interface ConfidenceResult {
  /** 0-100. */
  score: number;
  /** Plain-language reasons, shown so the number is never a black box. */
  reasons: string[];
  /** Why it is NOT higher — what a human should check. */
  concerns: string[];
}

/** Connection notes over this are rejected by LinkedIn's own UI. */
const CONNECTION_NOTE_LIMIT = 300;

/** At or above this, a draft is safe to include in a bulk approval. */
export const BULK_APPROVE_THRESHOLD = 70;

/**
 * Ceilings applied when a grounding factor is absent.
 *
 * These are caps, not deductions, and that distinction is the whole design.
 * Adding up points let a draft missing one essential still total above the
 * threshold by being strong everywhere else — which is exactly the message a
 * reviewer needed to read. Bulk approval means "send unread", so each essential
 * is a gate: absent, it holds the draft below the bar no matter what else is
 * true. The score still communicates degree; the caps decide eligibility.
 */
const CAP_NO_SIGNAL = 60;
const CAP_NO_BRAND_VOICE = 60;
const CAP_WEAK_FIT = 55;
const CAP_NO_CONTACT = 50;
const CAP_NO_PROFILE_URL = 65;
const CAP_MALFORMED = 40;
const CAP_PLACEHOLDER = 25;

export function scoreConfidence(input: ConfidenceInput): ConfidenceResult {
  const reasons: string[] = [];
  const concerns: string[] = [];
  let score = 0;
  let cap = 100;
  const limit = (value: number) => {
    cap = Math.min(cap, value);
  };

  // Grounding in a real signal is the single strongest predictor that the
  // message says something specific rather than generic filler.
  if (input.hasSignal) {
    score += 30;
    reasons.push('Cites a specific public signal');
  } else {
    limit(CAP_NO_SIGNAL);
    concerns.push('No public signal behind it — the opening may be generic');
  }

  const usedModel = Boolean(input.model) && input.model !== 'none';
  if (usedModel && input.brandVoiceApplied) {
    score += 20;
    reasons.push('Written in your brand voice');
  } else {
    limit(CAP_NO_BRAND_VOICE);
    concerns.push('Fallback wording — your brand voice was not applied');
  }

  const fit = input.fitScore ?? null;
  if (fit !== null && fit >= 70) {
    score += 25;
    reasons.push(`Strong lead fit (${fit}/100)`);
  } else if (fit !== null && fit >= 45) {
    score += 12;
    limit(CAP_WEAK_FIT);
    concerns.push(`Moderate lead fit (${fit}/100)`);
  } else {
    limit(CAP_WEAK_FIT);
    concerns.push(
      fit === null ? 'Lead is unscored' : `Weak lead fit (${fit}/100)`,
    );
  }

  if (input.hasContactName) {
    score += 15;
    reasons.push('Addressed to a named contact');
  } else {
    limit(CAP_NO_CONTACT);
    concerns.push('No named contact — company-only lead');
  }

  // Without a confirmed profile there is nowhere to send it, so approving it
  // into the queue would only create work that cannot be completed.
  if (input.hasLinkedInUrl) {
    score += 10;
    reasons.push('Profile URL confirmed');
  } else {
    limit(CAP_NO_PROFILE_URL);
    concerns.push('No confirmed profile URL to send it on');
  }

  // Correctness problems, not preferences.
  const text = input.draftText.trim();
  if (text.length < 40) {
    limit(CAP_MALFORMED);
    concerns.push('Unusually short — likely truncated');
  }
  if (input.type === 'CONNECTION_NOTE' && text.length > CONNECTION_NOTE_LIMIT) {
    limit(CAP_MALFORMED);
    concerns.push(
      `Over LinkedIn's ${CONNECTION_NOTE_LIMIT}-character connection-note limit`,
    );
  }
  // An unfilled placeholder must never go out in a batch.
  if (/\[[^\]]+\]|\{\{[^}]+\}\}|\bTODO\b|\bXXX\b/.test(text)) {
    limit(CAP_PLACEHOLDER);
    concerns.push('Contains an unfilled placeholder');
  }

  return {
    score: Math.max(0, Math.min(cap, score)),
    reasons,
    concerns,
  };
}

export function isBulkApprovable(result: ConfidenceResult): boolean {
  return result.score >= BULK_APPROVE_THRESHOLD;
}
