import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
} from '@/lib/password';

describe('password hashing', () => {
  it('hashes a password to a non-plaintext bcrypt string', async () => {
    const plain = 'Password123';
    const hash = await hashPassword(plain);
    expect(hash).not.toBe(plain);
    expect(hash).toMatch(/^\$2[aby]\$/); // bcrypt hash prefix
  });

  it('produces a different hash each time (random salt)', async () => {
    const a = await hashPassword('Password123');
    const b = await hashPassword('Password123');
    expect(a).not.toBe(b);
  });

  it('verifies a correct password', async () => {
    const hash = await hashPassword('Password123');
    await expect(verifyPassword('Password123', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('Password123');
    await expect(verifyPassword('WrongPassword1', hash)).resolves.toBe(false);
  });

  it('rejects verification when there is no stored hash (OAuth-only user)', async () => {
    await expect(verifyPassword('anything', null)).resolves.toBe(false);
    await expect(verifyPassword('anything', undefined)).resolves.toBe(false);
  });

  it('refuses to hash passwords shorter than the minimum', async () => {
    await expect(hashPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).rejects.toThrow();
  });
});
