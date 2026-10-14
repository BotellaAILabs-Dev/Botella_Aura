import crypto from 'node:crypto';

/**
 * AES-256-GCM encryption for sensitive tokens at rest (e.g. the LinkedIn
 * access/refresh tokens scaffolded for Sprint 2). Format of the stored string:
 *
 *   base64(iv).base64(authTag).base64(ciphertext)
 *
 * The key comes from ENCRYPTION_KEY (32 bytes, base64-encoded). We validate it
 * lazily so the app can boot in Sprint 1 without token encryption configured,
 * but any attempt to actually encrypt/decrypt fails loudly if it is missing.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32`.',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
  return key;
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

export function decrypt(payload: string): string {
  const key = getKey();
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed ciphertext payload.');
  }
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/** SHA-256 hex digest — used for single-use password-reset token lookup. */
export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Cryptographically-random URL-safe token (for reset links, invites, etc.). */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Keyed SHA-256 (HMAC, with ENCRYPTION_KEY) — a stable lookup key for a value
 * that is stored encrypted, such as a WhatsApp number. Unlike a plain hash it
 * cannot be reversed by hashing every phone number. `purpose` keeps keys for
 * different kinds of value apart.
 */
export function keyedHash(value: string, purpose: string): string {
  return crypto
    .createHmac('sha256', getKey())
    .update(`${purpose}:${value}`)
    .digest('hex');
}
