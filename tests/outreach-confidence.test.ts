import { describe, expect, it } from 'vitest';

import {
  BULK_APPROVE_THRESHOLD,
  isBulkApprovable,
  scoreConfidence,
  type ConfidenceInput,
} from '@/server/outreach/confidence';

/**
 * Bulk approval only earns its place if it is selective — "approve everything
 * unread" just moves the reviewer's judgement onto a button. These pin the
 * cases that must NEVER reach a batch, and the one that should.
 */
function input(over: Partial<ConfidenceInput> = {}): ConfidenceInput {
  return {
    model: 'claude-opus-4-8',
    brandVoiceApplied: true,
    hasSignal: true,
    fitScore: 82,
    hasContactName: true,
    hasLinkedInUrl: true,
    draftText:
      'Saw the Series B — congratulations. We help spirits brands turn launch momentum into retail demand. Worth a short chat?',
    type: 'CONNECTION_NOTE',
    ...over,
  };
}

describe('outreach confidence', () => {
  it('clears the bar for a fully grounded draft', () => {
    const result = scoreConfidence(input());
    expect(result.score).toBeGreaterThanOrEqual(BULK_APPROVE_THRESHOLD);
    expect(isBulkApprovable(result)).toBe(true);
    expect(result.reasons).toContain('Cites a specific public signal');
  });

  it('holds back a draft with no signal behind it', () => {
    const result = scoreConfidence(input({ hasSignal: false }));
    expect(isBulkApprovable(result)).toBe(false);
    expect(result.concerns.join(' ')).toMatch(/no public signal/i);
  });

  it('holds back a company-only lead with no named contact', () => {
    const result = scoreConfidence(
      input({ hasContactName: false, hasLinkedInUrl: false }),
    );
    expect(isBulkApprovable(result)).toBe(false);
  });

  it('holds back a weak-fit lead even when everything else is present', () => {
    const result = scoreConfidence(input({ fitScore: 20 }));
    expect(isBulkApprovable(result)).toBe(false);
    expect(result.concerns.join(' ')).toMatch(/weak lead fit/i);
  });

  it('never bulk-approves a draft containing an unfilled placeholder', () => {
    for (const text of [
      'Hi [First Name], saw the funding round and wanted to reach out about your launch.',
      'Hi {{name}}, congratulations on the raise — worth a short chat about distribution?',
      'TODO: personalise this before sending it to the prospect at the company.',
    ]) {
      const result = scoreConfidence(input({ draftText: text }));
      expect(isBulkApprovable(result)).toBe(false);
      expect(result.concerns.join(' ')).toMatch(/placeholder/i);
    }
  });

  it("never bulk-approves a connection note over LinkedIn's length limit", () => {
    const result = scoreConfidence(input({ draftText: 'x'.repeat(400) }));
    expect(isBulkApprovable(result)).toBe(false);
    expect(result.concerns.join(' ')).toMatch(/connection-note limit/i);
  });

  it('allows a long follow-up — the limit applies only to connection notes', () => {
    const result = scoreConfidence(
      input({ type: 'FOLLOWUP', draftText: 'A useful follow-up. '.repeat(30) }),
    );
    expect(isBulkApprovable(result)).toBe(true);
  });

  it('holds back a suspiciously short draft', () => {
    const result = scoreConfidence(input({ draftText: 'Hi there.' }));
    expect(isBulkApprovable(result)).toBe(false);
    expect(result.concerns.join(' ')).toMatch(/short/i);
  });

  it('holds back fallback wording generated without a model', () => {
    const result = scoreConfidence(
      input({ model: 'none', brandVoiceApplied: false }),
    );
    expect(isBulkApprovable(result)).toBe(false);
    expect(result.concerns.join(' ')).toMatch(/brand voice was not applied/i);
  });

  it('stays within 0-100 in every case', () => {
    for (const candidate of [
      input(),
      input({ hasSignal: false, fitScore: null, hasContactName: false, hasLinkedInUrl: false, model: 'none', brandVoiceApplied: false, draftText: '' }),
    ]) {
      const result = scoreConfidence(candidate);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });
});
