import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { aiFailureMessage, completeStructured, geminiQuota, isQuotaExhausted, isRetryable } from '@/server/ai/claude';

/**
 * Gemini quota handling. The shape below is what Gemini really returned on
 * 22 Oct 2026 for the free tier (20 requests/day per model, spent): a spent
 * daily quota is reported once, plainly, with when to try again — not retried
 * six times, not re-asked as if the reply were malformed.
 */

const DAILY_429 = JSON.stringify({
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7615s' },
    ],
  },
});
const MINUTE_429 = JSON.stringify({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1s' },
    ],
  },
});

describe('reading a Gemini 429', () => {
  it('names the quota and when it resets', () => {
    expect(geminiQuota(DAILY_429)).toEqual({ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', retryAfterMs: 7_615_000 });
    expect(geminiQuota(MINUTE_429)).toEqual({ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', retryAfterMs: 1000 });
    expect(geminiQuota('not json')).toBeNull();
    expect(geminiQuota(JSON.stringify({ error: { code: 429 } }))).toBeNull();
  });

  it('a spent daily quota (or a long wait) is not retried; a brief rate limit is', () => {
    const daily = Object.assign(new Error('x'), { status: 429, quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', retryAfterMs: 7_615_000 });
    const minute = Object.assign(new Error('x'), { status: 429, quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', retryAfterMs: 1000 });
    const longWait = Object.assign(new Error('x'), { status: 429, quotaId: null, retryAfterMs: 120_000 });
    expect(isQuotaExhausted(daily)).toBe(true);
    expect(isRetryable(daily)).toBe(false);
    expect(isQuotaExhausted(longWait)).toBe(true);
    expect(isRetryable(minute)).toBe(true);
    expect(isRetryable(Object.assign(new Error('x'), { status: 429 }))).toBe(true); // no details: as before
    expect(isRetryable(Object.assign(new Error('x'), { status: 503 }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('x'), { status: 401 }))).toBe(false);
  });

  it('the person is told it is the quota, and roughly when to try again — never the raw provider text', () => {
    const daily = Object.assign(new Error('Gemini API error (429): quota GenerateRequestsPerDayPerProjectPerModel-FreeTier exhausted, resets in about 127 min'), {
      status: 429,
      quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
      retryAfterMs: 7_615_000,
    });
    expect(aiFailureMessage(daily)).toBe('Aura’s writer is at its limit right now — the AI provider’s usage quota is used up. Nothing was changed — try again in about 2 hour(s).');
    const soon = Object.assign(new Error('Gemini API error (429): …'), { status: 429, quotaId: 'X-PerDay', retryAfterMs: 20 * 60_000 });
    expect(aiFailureMessage(soon)).toMatch(/try again in about 20 minutes/);
    // A brief rate limit keeps the existing wording.
    expect(aiFailureMessage(Object.assign(new Error('Gemini API error (429): {}'), { status: 429 }))).toMatch(/at its limit right now \(rate limit or quota\)/);
  });
});

describe('completeStructured with Gemini over quota', () => {
  const saved = { ...process.env };
  let calls = 0;
  beforeEach(() => {
    calls = 0;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });
  const respond = (body: string, status = 429) =>
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response(body, { status, headers: { 'content-type': 'application/json' } });
    });
  const schema = z.object({ ok: z.boolean() });

  it('a spent daily quota: one call, then a clear error carrying the reset time (no retries, no re-ask)', async () => {
    respond(DAILY_429);
    const err = await completeStructured({ prompt: 'x', schema }).catch((e) => e);
    expect(calls).toBe(1);
    expect(err.status).toBe(429);
    expect(err.message).toBe('Gemini API error (429): quota GenerateRequestsPerDayPerProjectPerModel-FreeTier exhausted, resets in about 127 min');
    expect(aiFailureMessage(err)).toMatch(/usage quota is used up/);
  });

  it('a brief rate limit is retried by complete() — but not re-asked as a schema problem', async () => {
    respond(MINUTE_429);
    const err = await completeStructured({ prompt: 'x', schema, maxAttempts: 3 }).catch((e) => e);
    expect(calls).toBe(3); // complete()'s own retries only (it was 6 with the re-ask)
    expect(err.status).toBe(429);
  });

  it('a malformed reply is still re-asked once', async () => {
    vi.stubGlobal('fetch', async () => {
      calls++;
      const text = calls === 1 ? '{"nope":1}' : '{"ok":true}';
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }), { status: 200 });
    });
    await expect(completeStructured({ prompt: 'x', schema })).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});
