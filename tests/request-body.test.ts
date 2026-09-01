import { describe, expect, it } from 'vitest';

/**
 * A request body is a single-use stream.
 *
 * POST /api/companies read it with `await req.json()` and then called
 * `req.clone()` to look for a second field. Cloning a request whose body is
 * already disturbed throws `TypeError: unusable` — synchronously, so the
 * `.catch()` chained onto the following `.json()` never saw it. Every attempt
 * to create a workspace answered 500 with a one-word message.
 *
 * These pin the platform behaviour that caused it, so the "read it once"
 * pattern is not quietly undone later.
 */
describe('Request body is single-use', () => {
  it('throws when cloning after the body has been read', async () => {
    const req = new Request('https://example.test/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme' }),
    });

    await req.json();

    // The exact failure: a synchronous throw, not a rejected promise.
    expect(() => req.clone()).toThrow();
  });

  it('throws when reading the body twice', async () => {
    const req = new Request('https://example.test/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme' }),
    });

    await req.json();
    await expect(req.json()).rejects.toThrow();
  });

  it('reading once and reusing the parsed value is safe', async () => {
    const req = new Request('https://example.test/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme', confirmDuplicate: true }),
    });

    // The pattern the handler now uses: one read, many consumers.
    const raw = (await req.json()) as Record<string, unknown>;
    const name = raw.name;
    const confirmDuplicate = Boolean(raw.confirmDuplicate);

    expect(name).toBe('Acme');
    expect(confirmDuplicate).toBe(true);
  });

  it('treats a body with no confirmDuplicate as not confirmed', async () => {
    const req = new Request('https://example.test/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme' }),
    });
    const raw = (await req.json()) as { confirmDuplicate?: unknown } | null;
    expect(Boolean(raw?.confirmDuplicate)).toBe(false);
  });
});
