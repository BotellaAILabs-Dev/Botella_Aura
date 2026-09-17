import bcrypt from 'bcryptjs';
import { MIN_PASSWORD_LENGTH } from '@/lib/password-policy';

/**
 * Password hashing/verification.
 * bcryptjs (pure-JS) is used deliberately: it avoids native build steps on
 * Windows/CI while remaining a well-vetted adaptive hash. Cost 12 is a sane
 * 2020s default (~250ms/hash) — raise as hardware improves.
 */
const BCRYPT_COST = 12;

/**
 * Re-exported so existing server-side importers keep working. The value
 * itself lives in `lib/password-policy.ts`, which imports nothing — client
 * code must import it from there, never from this module, which pulls bcryptjs.
 */
export { MIN_PASSWORD_LENGTH };

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string' || plain.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(
  plain: string,
  hash: string | null | undefined,
): Promise<boolean> {
  // OAuth-only accounts have no local hash — never authenticate them here.
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}
