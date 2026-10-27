import { describe, it, expect } from 'vitest';

import { checkEnv, formatEnvReport } from '@/lib/env-check';

const KEY = Buffer.alloc(32, 1).toString('base64');
const core = {
  DATABASE_URL: 'postgres://u:SECRETPASS@db/x',
  DIRECT_URL: 'postgres://u:SECRETPASS@db/x',
  NEXTAUTH_SECRET: 'SECRET_NEXTAUTH_VALUE',
  NEXTAUTH_URL: 'https://aura.example.com',
  ENCRYPTION_KEY: KEY,
  CRON_SECRET: 'SECRET_CRON',
};

describe('environment check', () => {
  it('reports each integration as ready, off or partial — never a value', () => {
    const r = checkEnv({ ...core, META_CLIENT_ID: '123', META_CLIENT_SECRET: 'SECRET_META', WHATSAPP_ACCESS_TOKEN: 'EAA_SECRET_TOKEN' });
    const by = Object.fromEntries(r.groups.map((g) => [g.key, g]));
    expect(by.core!.status).toBe('ready');
    expect(by.meta!.status).toBe('ready');
    expect(by.linkedin!.status).toBe('off');
    expect(by.whatsapp!.status).toBe('partial');
    expect(by.whatsapp!.missing).toEqual(['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN']);
    const text = JSON.stringify(r) + formatEnvReport(r).join('\n');
    expect(text).not.toMatch(/SECRET_META|EAA_SECRET_TOKEN|SECRETPASS|SECRET_NEXTAUTH_VALUE|SECRET_CRON|AQEB/);
  });

  it('a partly pasted integration is an error; an unconfigured one is not', () => {
    expect(checkEnv({ ...core }).errors).toEqual([]);
    expect(checkEnv({ ...core, LINKEDIN_CLIENT_ID: 'x' }).errors[0]).toMatch(/LinkedIn: only partly configured — missing LINKEDIN_CLIENT_SECRET/);
  });

  it('missing core variables are errors', () => {
    const { DATABASE_URL: _d, ...rest } = core;
    expect(checkEnv(rest).errors[0]).toMatch(/Core: missing DATABASE_URL/);
  });

  it('secrets must not be NEXT_PUBLIC_', () => {
    expect(checkEnv({ ...core, NEXT_PUBLIC_WHATSAPP_ACCESS_TOKEN: 'x' }).errors).toContain('NEXT_PUBLIC_WHATSAPP_ACCESS_TOKEN is exposed to the browser (NEXT_PUBLIC_). Rename it without the prefix.');
    expect(checkEnv({ ...core, NEXT_PUBLIC_APP_NAME: 'Aura' }).errors).toEqual([]);
  });

  it('production rules: no localhost URLs, no Graph stand-in, https', () => {
    const local = checkEnv({ ...core, NEXTAUTH_URL: 'http://localhost:3000', WHATSAPP_GRAPH_BASE_URL: 'http://localhost:4010' }, { production: true });
    expect(local.errors.join(' ')).toMatch(/NEXTAUTH_URL points at localhost/);
    // Named by variable rather than by the wording of the sentence, which has
    // already changed once (the stub is the sandbox now, not only a load test).
    expect(local.errors.join(' ')).toMatch(/WHATSAPP_GRAPH_BASE_URL is set/);
    // Locally the same settings are fine (the stand-in is only a warning).
    expect(checkEnv({ ...core, NEXTAUTH_URL: 'http://localhost:3000' }).errors).toEqual([]);
  });

  /**
   * Facebook and Instagram have the same override now, and in production it
   * means posts are going nowhere while the dashboard reports success.
   */
  it('production rules: the Meta Graph stand-in is an error too', () => {
    const prod = checkEnv(
      { ...core, NEXTAUTH_URL: 'https://aura.example.com', META_GRAPH_BASE_URL: 'http://localhost:4010' },
      { production: true },
    );
    expect(prod.errors.join(' ')).toMatch(/META_GRAPH_BASE_URL is set/);
    expect(checkEnv({ ...core, META_GRAPH_BASE_URL: 'http://localhost:4010' }).errors).toEqual([]);
    expect(checkEnv({ ...core, META_GRAPH_BASE_URL: 'http://localhost:4010' }).warnings.join(' ')).toMatch(
      /META_GRAPH_BASE_URL is set/,
    );
  });

  it('a malformed ENCRYPTION_KEY is caught', () => {
    expect(checkEnv({ ...core, ENCRYPTION_KEY: 'replace-me-with-a-32-byte-base64-key' }).errors.join(' ')).toMatch(/ENCRYPTION_KEY must be 32 bytes/);
  });

  it('warns when Meta and LinkedIn redirects would use different hosts', () => {
    expect(checkEnv({ ...core, APP_URL: 'https://app.example.com' }).warnings.join(' ')).toMatch(/different hosts/);
  });
});
