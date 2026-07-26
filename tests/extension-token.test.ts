import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sha256 } from '@/lib/crypto';

/**
 * Extension auth-token exchange (Sprint 4, Module 2) with Prisma fully mocked.
 * Verifies the security-critical properties: the raw token is never stored
 * (only its sha256 hash), issue→verify round-trips, and verify rejects unknown,
 * revoked, expired, and wrong-prefix tokens.
 */
const { store } = vi.hoisted(() => ({ store: [] as any[] }));

vi.mock('@/lib/db', () => ({
  db: {
    extensionToken: {
      create: async ({ data }: any) => {
        const rec = {
          id: `tok_${store.length + 1}`,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
          ...data,
        };
        store.push(rec);
        return rec;
      },
      findUnique: async ({ where }: any) =>
        store.find((r) => r.tokenHash === where.tokenHash) ?? null,
      update: async ({ where, data }: any) => {
        const r = store.find((x) => x.id === where.id);
        if (r) Object.assign(r, data);
        return r;
      },
    },
    auditLog: { create: async () => ({}) },
  },
}));

import {
  issueExtensionToken,
  verifyExtensionToken,
} from '@/server/extension/token.service';

beforeEach(() => {
  store.length = 0;
});

describe('extension token exchange', () => {
  it('issues an aura_ext_ token and stores only its sha256 hash', async () => {
    const { id, rawToken } = await issueExtensionToken({
      userId: 'u1',
      companyId: 'c1',
    });
    expect(rawToken.startsWith('aura_ext_')).toBe(true);

    const record = store.find((r) => r.id === id);
    // The raw token must NEVER be persisted — only its hash.
    expect(record.tokenHash).toBe(sha256(rawToken));
    expect(JSON.stringify(record)).not.toContain(rawToken);
  });

  it('verifies a freshly issued token and returns its scope', async () => {
    const { rawToken } = await issueExtensionToken({ userId: 'u1', companyId: 'c1' });
    const ctx = await verifyExtensionToken(rawToken);
    expect(ctx).toEqual(
      expect.objectContaining({ userId: 'u1', companyId: 'c1' }),
    );
  });

  it('rejects an unknown token', async () => {
    expect(await verifyExtensionToken('aura_ext_deadbeef')).toBeNull();
  });

  it('rejects a token without the aura_ext_ prefix', async () => {
    expect(await verifyExtensionToken('some-random-bearer')).toBeNull();
  });

  it('rejects a revoked token', async () => {
    const { rawToken } = await issueExtensionToken({ userId: 'u1', companyId: 'c1' });
    store[0].revokedAt = new Date();
    expect(await verifyExtensionToken(rawToken)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { rawToken } = await issueExtensionToken({ userId: 'u1', companyId: 'c1' });
    store[0].expiresAt = new Date(Date.now() - 1000);
    expect(await verifyExtensionToken(rawToken)).toBeNull();
  });
});
