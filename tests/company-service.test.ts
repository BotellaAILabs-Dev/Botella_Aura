import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit test for the company service with Prisma fully mocked. Verifies the
 * business logic we actually care about: unique-slug generation, OWNER
 * membership creation, and that BOTH audit entries (COMPANY_CREATED +
 * ONBOARDING_COMPLETED) are written inside the same transaction.
 */

// --- Mock the Prisma client module before importing the service. ---
const auditCreate = vi.fn().mockResolvedValue({});
const companyCreate = vi.fn();
const companyFindUnique = vi.fn();

const tx = {
  company: { create: companyCreate, findUnique: companyFindUnique },
  auditLog: { create: auditCreate },
};

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
  },
}));

import { createCompanyForUser } from '@/server/services/company.service';

beforeEach(() => {
  vi.clearAllMocks();
  // No slug collisions by default.
  companyFindUnique.mockResolvedValue(null);
  companyCreate.mockImplementation(({ data }: { data: { name: string; slug: string } }) => ({
    id: 'company_1',
    name: data.name,
    slug: data.slug,
  }));
});

describe('createCompanyForUser', () => {
  it('creates a company with a slugified name and OWNER membership', async () => {
    const company = await createCompanyForUser({
      userId: 'user_1',
      input: {
        name: 'Acme Inc.',
        website: 'https://acme.com',
        industry: 'SaaS',
        description: 'We sell payroll software to small startups.',
        offerings: 'Payroll runs, compliance filing',
        marketMode: 'B2B',
        audience: 'Founders at 10-200 person startups.',
        goals: '15 demos a month',
        brandVoiceNotes: 'Warm and practical.',
      },
    });

    expect(company.slug).toBe('acme-inc');

    const createArg = companyCreate.mock.calls[0]![0];
    expect(createArg.data.members.create).toEqual({
      userId: 'user_1',
      role: 'OWNER',
    });
    expect(createArg.data.onboardedAt).toBeInstanceOf(Date);

    // The wizard's answers to "what do you do" and "who buys from you" used to
    // be dropped on the floor here; every prompt downstream reads them.
    expect(createArg.data.preferences).toMatchObject({
      business: { description: 'We sell payroll software to small startups.' },
      marketingProfile: {
        marketMode: 'B2B',
        audience: 'Founders at 10-200 person startups.',
        goals: '15 demos a month',
      },
    });
  });

  it('appends a numeric suffix when the slug already exists', async () => {
    // First lookup: slug taken. Second lookup: free.
    companyFindUnique
      .mockResolvedValueOnce({ id: 'existing' })
      .mockResolvedValueOnce(null);

    const company = await createCompanyForUser({
      userId: 'user_1',
      input: {
        name: 'Acme',
        website: undefined,
        industry: '',
        description: 'We sell payroll software to small startups.',
        marketMode: 'B2B',
        audience: 'Founders at 10-200 person startups.',
        brandVoiceNotes: '',
      },
    });

    expect(company.slug).toBe('acme-1');
  });

  it('writes COMPANY_CREATED and ONBOARDING_COMPLETED audit entries', async () => {
    await createCompanyForUser({
      userId: 'user_1',
      input: {
        name: 'Acme',
        website: undefined,
        industry: '',
        description: 'We sell payroll software to small startups.',
        marketMode: 'B2B',
        audience: 'Founders at 10-200 person startups.',
        brandVoiceNotes: '',
      },
    });

    const actions = auditCreate.mock.calls.map((c) => c[0].data.action);
    expect(actions).toContain('COMPANY_CREATED');
    expect(actions).toContain('ONBOARDING_COMPLETED');
  });
});
