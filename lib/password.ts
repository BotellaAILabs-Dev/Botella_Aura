import bcrypt from 'bcryptjs';

/**
 * Password hashing/verification.
 * bcryptjs (pure-JS) is used deliberately: it avoids native build steps on
 * Windows/CI while remaining a well-vetted adaptive hash. Cost 12 is a sane
 * 2020s default (~250ms/hash) — raise as hardware improves.
 */
const BCRYPT_COST = 12;

/** Minimum length enforced here AND in the Zod schema (defense in depth). */
export const MIN_PASSWORD_LENGTH = 8;

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
