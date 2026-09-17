import { describe, it, expect } from 'vitest';
import { signUpSchema, passwordSchema } from '@/lib/validations/auth';
import {
  createCompanySchema,
  companyStep1Schema,
} from '@/lib/validations/company';

describe('auth validation schemas', () => {
  it('accepts a valid signup and lowercases the email', () => {
    const parsed = signUpSchema.parse({
      name: 'Ada Lovelace',
      email: 'ADA@Example.com',
      password: 'Password123',
    });
    expect(parsed.email).toBe('ada@example.com');
  });

  it('rejects an invalid email', () => {
    expect(
      signUpSchema.safeParse({
        name: 'Ada',
        email: 'not-an-email',
        password: 'Password123',
      }).success,
    ).toBe(false);
  });

  it('requires a letter and a number in passwords', () => {
    expect(passwordSchema.safeParse('allletters').success).toBe(false);
    expect(passwordSchema.safeParse('12345678').success).toBe(false);
    expect(passwordSchema.safeParse('Password123').success).toBe(true);
  });

  it('rejects passwords under the minimum length', () => {
    expect(passwordSchema.safeParse('Ab1').success).toBe(false);
  });
});

describe('company validation schemas', () => {
  it('normalizes a bare domain to an https URL', () => {
    const parsed = companyStep1Schema.parse({
      name: 'Acme Inc.',
      website: 'acme.com',
      industry: 'SaaS',
      description: 'We roast coffee in small batches and ship within 48 hours.',
    });
    expect(parsed.website).toBe('https://acme.com');
  });

  it('leaves an existing protocol untouched', () => {
    const parsed = companyStep1Schema.parse({
      name: 'Acme',
      website: 'http://acme.io',
      description: 'We roast coffee in small batches and ship within 48 hours.',
    });
    expect(parsed.website).toBe('http://acme.io');
  });

  it('treats an empty website as undefined (optional)', () => {
    const parsed = companyStep1Schema.parse({
      name: 'Acme',
      website: '',
      description: 'We roast coffee in small batches and ship within 48 hours.',
    });
    expect(parsed.website).toBeUndefined();
  });

  it('rejects a company name shorter than 2 chars', () => {
    expect(
      companyStep1Schema.safeParse({ name: 'A', description: 'We roast coffee in small batches and ship within 48 hours.' }).success,
    ).toBe(false);
  });

  it('accepts a full onboarding payload', () => {
    const parsed = createCompanySchema.parse({
      name: 'Botella',
      website: 'botella.ai',
      industry: 'B2B SaaS',
      description: 'We build an AI marketing co-pilot for small teams.',
      marketMode: 'B2B',
      audience: 'Marketing leads at 10-200 person companies.',
      brandVoiceNotes: 'Warm, practical, no hype.',
    });
    expect(parsed.name).toBe('Botella');
    expect(parsed.brandVoiceNotes).toBe('Warm, practical, no hype.');
    expect(parsed.marketMode).toBe('B2B');
  });

  /**
   * The wizard must not be able to create a workspace that cannot be written
   * for. These two fields are the ones every generation prompt reads first.
   */
  it('rejects an onboarding payload with no business description', () => {
    const result = companyStep1Schema.safeParse({
      name: 'Acme',
      website: 'acme.com',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a too-vague business description', () => {
    const result = companyStep1Schema.safeParse({
      name: 'Acme',
      description: 'we sell stuff',
    });
    expect(result.success).toBe(false);
  });
});
