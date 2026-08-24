import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activeEmailTransport,
  describeEmailTransport,
  emailConfigProblems,
  isEmailConfigured,
  sendEmail,
} from '@/lib/email';

/**
 * The bug this guards against: `sendEmail` used to swallow every failure and
 * fall back to a console log, so the UI reported "Mail sent" while nothing left
 * the building. A send that did not happen must never report success.
 */
const ENV_KEYS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'RESEND_API_KEY',
  'EMAIL_FROM',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('transport selection', () => {
  it('reports "console" and not-configured when nothing is set', () => {
    expect(activeEmailTransport()).toBe('console');
    expect(isEmailConfigured()).toBe(false);
    expect(describeEmailTransport()).toMatch(/not configured/i);
  });

  it('prefers SMTP over Resend when both are set', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.RESEND_API_KEY = 're_test';
    expect(activeEmailTransport()).toBe('smtp');
  });

  it('uses Resend when only Resend is set', () => {
    process.env.RESEND_API_KEY = 're_test';
    expect(activeEmailTransport()).toBe('resend');
  });
});

describe('config diagnostics', () => {
  it('explains what is missing when nothing is configured', () => {
    expect(emailConfigProblems()[0]).toMatch(/no email provider/i);
  });

  it('flags SMTP without credentials', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    expect(emailConfigProblems().join(' ')).toMatch(/SMTP_USER/);
  });

  it('flags Resend without a verified sender', () => {
    process.env.RESEND_API_KEY = 're_test';
    expect(emailConfigProblems().join(' ')).toMatch(/EMAIL_FROM/);
  });

  it('reports no problems for a complete Resend setup', () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.EMAIL_FROM = 'Aura <no-reply@example.com>';
    expect(emailConfigProblems()).toEqual([]);
  });
});

describe('sendEmail reports the truth', () => {
  const message = { to: 'a@example.com', subject: 'Hi', text: 'Body' };

  it('never claims delivery with no provider configured', async () => {
    const result = await sendEmail(message);
    expect(result.delivered).toBe(false);
    expect(result.notConfigured).toBe(true);
    expect(result.transport).toBe('console');
    expect(result.error).toBeTruthy();
  });

  it('reports delivered when Resend accepts the message', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.EMAIL_FROM = 'Aura <no-reply@example.com>';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 }),
      ),
    );

    const result = await sendEmail(message);
    expect(result.delivered).toBe(true);
    expect(result.transport).toBe('resend');
    expect(result.providerId).toBe('msg_123');
  });

  it('reports the provider error instead of silently falling back', async () => {
    process.env.RESEND_API_KEY = 're_test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ message: 'domain is not verified' }), {
          status: 403,
        }),
      ),
    );

    const result = await sendEmail(message);
    expect(result.delivered).toBe(false);
    expect(result.notConfigured).toBeFalsy();
    expect(result.error).toMatch(/domain is not verified/);
  });

  it('reports a network failure as undelivered, and never throws', async () => {
    process.env.RESEND_API_KEY = 're_test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const result = await sendEmail(message);
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});
