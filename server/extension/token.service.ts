import { db } from '@/lib/db';
import { generateToken, sha256 } from '@/lib/crypto';
import { recordAudit } from '@/server/services/audit.service';

/**
 * Extension token lifecycle (Sprint 4, Module 2).
 *
 * Security properties (mirrors auth-token.service.ts):
 *  - Only sha256(rawToken) is stored; the raw token exists only in the
 *    extension's chrome.storage.local. A DB leak exposes no usable token.
 *  - Tokens are revocable (revokedAt) and optionally expiring (expiresAt).
 *  - Scoped to one (userId, companyId); authorizes ONLY /api/extension/*.
 */
const TOKEN_PREFIX = 'aura_ext_';
const DEFAULT_TTL_DAYS = 180;

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Issue a new extension token. Returns the raw token ONCE (never stored raw). */
export async function issueExtensionToken(args: {
  userId: string;
  companyId: string;
  label?: string | null;
  requestMeta?: Meta;
}): Promise<{ id: string; rawToken: string; expiresAt: Date }> {
  const { userId, companyId, label, requestMeta } = args;
  const rawToken = `${TOKEN_PREFIX}${generateToken(32)}`;
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(Date.now() + DEFAULT_TTL_DAYS * 86_400_000);

  const token = await db.extensionToken.create({
    data: { userId, companyId, label: label || null, tokenHash, expiresAt },
  });

  await recordAudit({
    action: 'EXTENSION_TOKEN_ISSUED',
    userId,
    companyId,
    metadata: { tokenId: token.id, label: label || null },
    ...requestMeta,
  });

  return { id: token.id, rawToken, expiresAt };
}

export interface VerifiedExtensionToken {
  tokenId: string;
  userId: string;
  companyId: string;
}

/**
 * Verify a raw bearer token. Returns the scope context or null if the token is
 * unknown, revoked, or expired. Bumps lastUsedAt (best-effort) on success.
 */
export async function verifyExtensionToken(
  rawToken: string,
): Promise<VerifiedExtensionToken | null> {
  if (!rawToken || !rawToken.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = sha256(rawToken);
  const record = await db.extensionToken.findUnique({ where: { tokenHash } });
  if (!record) return null;
  if (record.revokedAt) return null;
  if (record.expiresAt && record.expiresAt < new Date()) return null;

  // Best-effort usage stamp; never block auth on this write.
  db.extensionToken
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { tokenId: record.id, userId: record.userId, companyId: record.companyId };
}

/** Non-secret list of a user's tokens for a company (settings UI). */
export async function listExtensionTokens(userId: string, companyId: string) {
  return db.extensionToken.findMany({
    where: { userId, companyId, revokedAt: null },
    select: {
      id: true,
      label: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

/** Revoke one of the caller's own tokens (the "Disconnect extension" action). */
export async function revokeExtensionToken(args: {
  userId: string;
  companyId: string;
  tokenId: string;
  requestMeta?: Meta;
}): Promise<void> {
  const { userId, companyId, tokenId, requestMeta } = args;
  const result = await db.extensionToken.updateMany({
    where: { id: tokenId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count > 0) {
    await recordAudit({
      action: 'EXTENSION_TOKEN_REVOKED',
      userId,
      companyId,
      metadata: { tokenId },
      ...requestMeta,
    });
  }
}
