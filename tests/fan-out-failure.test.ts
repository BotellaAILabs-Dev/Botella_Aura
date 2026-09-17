import { describe, it, expect } from 'vitest';

import { fanOutFailure, ImageProviderError } from '@/server/media/types';

/**
 * What a fan-out throws when every call failed.
 *
 * This is the "stuck at 10%" bug. Providers that issue one call per variation
 * collected the failures, found no images, and threw a FRESH error reading
 * "returned no image for this prompt. Try rewording it." That was wrong twice:
 *
 *   - ImageProviderError defaults `retryable` to true, so the job layer parked
 *     the run in QUEUED announcing "Hit a snag — retrying…" at 10 percent. With
 *     no cron reaper running — every local machine — it sat there indefinitely
 *     while the client waited for a terminal status that never came.
 *   - It blamed the prompt for what was a transport failure, sending users to
 *     rewrite perfectly good prompts for a request that never reached a model.
 */
describe('fanOutFailure', () => {
  /**
   * The case that caused the hang: a rejected API key can never succeed, and
   * its retryability must survive the fan-out rather than being replaced by
   * the permissive default.
   */
  it('rethrows a provider error untouched, keeping retryable false', () => {
    const cause = new ImageProviderError(
      'AGNES',
      'Agnes AI rejected the API key. Check AGNES_API_KEY on the deployment.',
      401,
      false,
    );

    const result = fanOutFailure('AGNES', 'Agnes AI', cause);

    expect(result).toBe(cause);
    expect(result.retryable).toBe(false);
    expect(result.status).toBe(401);
  });

  it('keeps a quota error non-retryable so the job fails instead of parking', () => {
    const cause = new ImageProviderError('GOOGLE', 'No quota left.', 429, false);
    expect(fanOutFailure('GOOGLE', 'Google', cause).retryable).toBe(false);
  });

  /**
   * A non-provider error is a transport failure, not a bad prompt. It must
   * never tell someone to reword something the model never saw.
   */
  it('never blames the prompt for an unrecognised failure', () => {
    const result = fanOutFailure('AGNES', 'Agnes AI', new Error('socket hang up'));
    expect(result.message).not.toMatch(/reword/i);
    expect(result.message).not.toMatch(/for this prompt/i);
  });

  it('keeps the underlying cause in the message', () => {
    const result = fanOutFailure(
      'AGNES',
      'Agnes AI',
      new Error('Unexpected token < in JSON'),
    );
    expect(result.message).toContain('Unexpected token');
  });

  /** A timeout is worth one more try; an unexplained failure is not. */
  it('marks a genuine timeout retryable', () => {
    const timeout = new Error('The operation timed out');
    timeout.name = 'TimeoutError';
    expect(fanOutFailure('AGNES', 'Agnes AI', timeout).retryable).toBe(true);
  });

  it('marks an unrecognised failure non-retryable rather than parking the job', () => {
    // The default on ImageProviderError is `true`; relying on it here is what
    // produced a QUEUED job nothing would ever pick up.
    const result = fanOutFailure('AGNES', 'Agnes AI', new Error('weird failure'));
    expect(result.retryable).toBe(false);
  });

  it('survives a non-Error being thrown', () => {
    const result = fanOutFailure('AGNES', 'Agnes AI', 'just a string');
    expect(result).toBeInstanceOf(ImageProviderError);
    expect(result.retryable).toBe(false);
  });

  it('names the provider so the failure panel can say which model failed', () => {
    expect(fanOutFailure('GOOGLE', 'Google', new Error('x')).provider).toBe('GOOGLE');
  });
});
