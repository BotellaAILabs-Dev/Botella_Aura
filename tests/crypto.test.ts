import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { encrypt, decrypt, sha256, generateToken } from '@/lib/crypto';

// Provide a valid 32-byte key for the encryption round-trip tests.
beforeAll(() => {
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
});

describe('crypto (token-at-rest encryption)', () => {
  it('round-trips a value through encrypt/decrypt', () => {
    const secret = 'linkedin-access-token-abc123';
    const cipher = encrypt(secret);
    expect(cipher).not.toContain(secret);
    expect(decrypt(cipher)).toBe(secret);
  });

  it('produces distinct ciphertexts for the same plaintext (random IV)', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('fails to decrypt tampered ciphertext (GCM auth tag)', () => {
    const cipher = encrypt('secret');
    const tampered = cipher.slice(0, -2) + (cipher.endsWith('A') ? 'BB' : 'AA');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('sha256 is deterministic and hex-encoded', () => {
    expect(sha256('token')).toBe(sha256('token'));
    expect(sha256('token')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('generateToken returns unique url-safe tokens', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
