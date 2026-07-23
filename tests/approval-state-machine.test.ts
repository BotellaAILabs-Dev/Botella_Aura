import { describe, it, expect, vi } from 'vitest';

// content.service imports the prisma client at module load; mock it so the
// pure state-machine function can be imported without a database.
vi.mock('@/lib/db', () => ({ db: {} }));

import { isValidTransition } from '@/server/content/content.service';

/**
 * The approval state machine is the product's trust backbone. The single most
 * important invariant: PUBLISHED is reachable ONLY from APPROVED — no draft can
 * jump to published without a human approval (NON-NEGOTIABLE #2).
 */
describe('approval state machine', () => {
  it('allows the happy path DRAFT → PENDING → APPROVED → PUBLISHED', () => {
    expect(isValidTransition('DRAFT', 'PENDING_APPROVAL')).toBe(true);
    expect(isValidTransition('PENDING_APPROVAL', 'APPROVED')).toBe(true);
    expect(isValidTransition('APPROVED', 'PUBLISHED')).toBe(true);
  });

  it('ONLY allows PUBLISHED from APPROVED', () => {
    expect(isValidTransition('APPROVED', 'PUBLISHED')).toBe(true);
    expect(isValidTransition('DRAFT', 'PUBLISHED')).toBe(false);
    expect(isValidTransition('PENDING_APPROVAL', 'PUBLISHED')).toBe(false);
    expect(isValidTransition('REJECTED', 'PUBLISHED')).toBe(false);
    expect(isValidTransition('PUBLISHED', 'PUBLISHED')).toBe(false);
  });

  it('treats PUBLISHED as terminal', () => {
    for (const to of ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'] as const) {
      expect(isValidTransition('PUBLISHED', to)).toBe(false);
    }
  });

  it('supports rejection and reopening', () => {
    expect(isValidTransition('PENDING_APPROVAL', 'REJECTED')).toBe(true);
    expect(isValidTransition('APPROVED', 'REJECTED')).toBe(true);
    expect(isValidTransition('REJECTED', 'DRAFT')).toBe(true);
  });

  it('supports "request changes" back to DRAFT', () => {
    expect(isValidTransition('PENDING_APPROVAL', 'DRAFT')).toBe(true);
    expect(isValidTransition('APPROVED', 'DRAFT')).toBe(true);
  });

  it('rejects nonsensical jumps', () => {
    expect(isValidTransition('DRAFT', 'APPROVED')).toBe(false);
    expect(isValidTransition('REJECTED', 'APPROVED')).toBe(false);
  });
});
