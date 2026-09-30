import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { slugify } from '@/lib/utils';
import { recordAudit } from '@/server/services/audit.service';
import { businessContextPatchSchema } from '@/lib/validations/business-context';
import {
  COMPANY_PROFILE_ALIASES,
  ONBOARDING_ALIASES,
  companyProfilePatch,
  onboardingPatch,
} from '@/server/business-context/adapters';
import {
  EMPTY_STORED_CONTEXT,
  planBusinessContextWrite,
} from '@/server/business-context/update';
import { updateBusinessContext } from '@/server/business-context/business-context-write.service';
import type {
  CreateCompanyInput,
  UpdateCompanyInput,
} from '@/lib/validations/company';
import type { CompanySummary } from '@/types';

/**
 * Generate a slug that is unique across companies by appending a short numeric
 * suffix on collision. Runs inside the same transaction as company creation.
 */
async function uniqueSlug(
  tx: Prisma.TransactionClient,
  name: string,
): Promise<string> {
  const base = slugify(name) || 'company';
  let candidate = base;
  let suffix = 1;
  // Bounded loop — collisions are rare; suffixes keep it deterministic.
  while (await tx.company.findUnique({ where: { slug: candidate } })) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

interface CreateCompanyArgs {
  userId: string;
  input: CreateCompanyInput;
  requestMeta?: { ipAddress?: string | null; userAgent?: string | null };
}

/**
 * Create a company, make the creating user its OWNER, mark onboarding complete,
 * and write COMPANY_CREATED + ONBOARDING_COMPLETED audit entries — all atomic.
 */
export async function createCompanyForUser({
  userId,
  input,
  requestMeta,
}: CreateCompanyArgs) {
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const slug = await uniqueSlug(tx, input.name);

    /**
     * Everything the wizard collected, through the Business Context rules.
     *
     * The same patch schema and update rules as every settings screen decide
     * what enters the trusted context (server/business-context/update.ts), so
     * onboarding cannot store a value the settings pages would refuse. It is
     * planned against an empty workspace and written as part of the create,
     * keeping workspace creation a single atomic step.
     */
    const plan = planBusinessContextWrite(
      EMPTY_STORED_CONTEXT,
      businessContextPatchSchema.parse(onboardingPatch(input)),
      'onboarding',
      ONBOARDING_ALIASES,
    );

    const company = await tx.company.create({
      data: {
        name: plan.data.name ?? input.name,
        slug,
        website: plan.data.website ?? null,
        industry: plan.data.industry ?? null,
        brandVoiceNotes: plan.data.brandVoiceNotes ?? null,
        preferences: (plan.data.preferences ?? {}) as Prisma.InputJsonObject,
        onboardedAt: new Date(),
        members: {
          create: { userId, role: 'OWNER' },
        },
      },
    });

    await recordAudit(
      {
        action: 'COMPANY_CREATED',
        userId,
        companyId: company.id,
        metadata: {
          name: company.name,
          slug: company.slug,
          changedFields: plan.changed,
        },
        ...requestMeta,
      },
      tx,
    );
    await recordAudit(
      {
        action: 'ONBOARDING_COMPLETED',
        userId,
        companyId: company.id,
        metadata: {},
        ...requestMeta,
      },
      tx,
    );

    return company;
  });
}

/** All companies a user belongs to, shaped for the topbar switcher + guards. */
export async function getCompaniesForUser(
  userId: string,
): Promise<CompanySummary[]> {
  /**
   * Five columns, not the whole row.
   *
   * This is the hottest query in the application: `resolveActiveCompany` calls
   * it on every dashboard navigation, for the layout's company switcher and
   * again for whatever the page itself needs (React `cache` collapses those
   * into one per request, but not into none).
   *
   * `include: { company: true }` is SELECT * — so each of those loads pulled
   * `preferences` and `brandVoiceProfile`, both JSON bags that grow with brand
   * assets, audience settings and an AI-written voice profile, plus the
   * free-text `brandVoiceNotes` — and then threw all of it away to build a
   * five-field summary. Same reasoning as the explicit column list on the
   * Content Studio board query in server/content/content.service.ts.
   */
  const memberships = await db.companyMember.findMany({
    where: { userId },
    select: {
      role: true,
      company: {
        select: { id: true, name: true, slug: true, logoUrl: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return memberships.map((m) => ({
    id: m.company.id,
    name: m.company.name,
    slug: m.company.slug,
    logoUrl: m.company.logoUrl,
    role: m.role,
  }));
}

/** The caller's membership in a company, or null if they don't belong to it. */
export async function getMembership(userId: string, companyId: string) {
  return db.companyMember.findUnique({
    where: { userId_companyId: { userId, companyId } },
  });
}

export async function getCompanyById(companyId: string) {
  return db.company.findUnique({ where: { id: companyId } });
}

export async function getCompanyMembers(companyId: string) {
  return db.companyMember.findMany({
    where: { companyId },
    include: {
      user: { select: { id: true, name: true, email: true, image: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
}

interface UpdateCompanyArgs {
  userId: string;
  companyId: string;
  input: UpdateCompanyInput;
  requestMeta?: { ipAddress?: string | null; userAgent?: string | null };
}

/**
 * Update the company profile from the settings page.
 *
 * Business fields go through the Business Context service, so they are held
 * to the same rules as onboarding and every other screen, and each change is
 * audited with the exact context fields it touched. `logoUrl` is the display
 * avatar, not business context, so it is written directly.
 */
export async function updateCompany({
  userId,
  companyId,
  input,
  requestMeta,
}: UpdateCompanyArgs) {
  await updateBusinessContext({
    companyId,
    userId,
    patch: companyProfilePatch(input),
    origin: 'settings',
    aliases: COMPANY_PROFILE_ALIASES,
    requestMeta,
  });

  if (input.logoUrl !== undefined) {
    await db.company.update({
      where: { id: companyId },
      data: { logoUrl: input.logoUrl || null },
    });
    await recordAudit({
      action: 'COMPANY_UPDATED',
      userId,
      companyId,
      metadata: { changedFields: ['logoUrl'] },
      ...requestMeta,
    });
  }

  return db.company.findUniqueOrThrow({ where: { id: companyId } });
}
