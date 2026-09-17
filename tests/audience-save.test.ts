import { describe, it, expect } from 'vitest';

import {
  marketingProfileSchema,
  AUDIENCE_MAX,
  GOALS_MAX,
} from '@/lib/validations/profile';

/**
 * Saving audience and goals.
 *
 * The reported bug was not that the schema was wrong — it rejected the right
 * things — but that a rejection arrived at the user as the single word
 * "Validation failed". The route flattens Zod's issues into per-field messages
 * and the form discarded them, so someone who wrote a long answer got no field
 * named, no limit stated, and no way to tell what to change.
 *
 * These tests pin the half of that contract the server owns: a failure must
 * name the field and say something a person can act on. The form's job is to
 * render `details`, which it now does.
 */
describe('marketing profile validation', () => {
  it('accepts a full, realistic profile', () => {
    const result = marketingProfileSchema.safeParse({
      marketMode: 'B2C',
      audience:
        'People in their 30s and 40s who already drink bourbon and read the back label.',
      goals: 'Get 5,000 app downloads this quarter.',
      channels: ['Instagram', 'X'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts every channel at once — the limit must not be below the list', () => {
    // max(6) against a six-item list: one off in either direction and picking
    // everything on the page becomes an unexplainable save failure.
    const result = marketingProfileSchema.safeParse({
      marketMode: 'B2B',
      audience: 'Ops leads at logistics firms.',
      goals: '',
      channels: ['LinkedIn', 'Blog', 'Newsletter', 'X', 'Instagram', 'YouTube'],
    });
    expect(result.success).toBe(true);
  });

  it('names the field and states the limit when audience is too long', () => {
    const result = marketingProfileSchema.safeParse({
      marketMode: 'B2B',
      audience: 'a'.repeat(AUDIENCE_MAX + 1),
      goals: '',
      channels: [],
    });
    expect(result.success).toBe(false);
    if (result.success) return;

    const fieldErrors = result.error.flatten().fieldErrors;
    // The route returns exactly this object as `details`; the form reads it.
    expect(fieldErrors.audience?.[0]).toBeTruthy();
    expect(fieldErrors.audience?.[0]).toContain(String(AUDIENCE_MAX));
  });

  it('names goals when goals is the field at fault', () => {
    const result = marketingProfileSchema.safeParse({
      marketMode: 'B2B',
      audience: 'Ops leads.',
      goals: 'g'.repeat(GOALS_MAX + 1),
      channels: [],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.flatten().fieldErrors.goals?.[0]).toContain(
      String(GOALS_MAX),
    );
  });

  it('reports an unknown channel against `channels`, not as a whole-form failure', () => {
    const result = marketingProfileSchema.safeParse({
      marketMode: 'B2B',
      audience: 'Ops leads.',
      goals: '',
      channels: ['Facebook'],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.flatten().fieldErrors.channels?.[0]).toBeTruthy();
  });

  /**
   * Clearing a field has to actually clear it. The transform turns '' into
   * undefined, which `mergeSection` then strips from the preferences bag —
   * without this an emptied box would leave the old value in place and the UI
   * would disagree with what the generator reads.
   */
  it('treats an emptied field as cleared rather than as an empty string', () => {
    const result = marketingProfileSchema.safeParse({
      marketMode: 'B2B',
      audience: '',
      goals: '   ',
      channels: [],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.audience).toBeUndefined();
    expect(result.data.goals).toBeUndefined();
  });

  it('keeps the market mode, which decides how everything is written', () => {
    const result = marketingProfileSchema.safeParse({
      marketMode: 'B2C',
      audience: 'People who like coffee.',
      goals: '',
      channels: [],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.marketMode).toBe('B2C');
  });
});
