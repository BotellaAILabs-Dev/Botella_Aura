import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { slugify } from '@/lib/utils';
import { recordAudit } from '@/server/services/audit.service';
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

    const company = await tx.company.create({
      data: {
        name: input.name,
        slug,
        website: input.website ?? null,
        industry: input.industry || null,
        brandVoiceNotes: input.brandVoiceNotes || null,
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
        metadata: { name: company.name, slug: company.slug },
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
  const memberships = await db.companyMember.findMany({
    where: { userId },
    include: { company: true },
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

/** Update a company profile and audit exactly which fields changed. */
export async function updateCompany({
  userId,
  companyId,
  input,
  requestMeta,
}: UpdateCompanyArgs) {
  const data: Prisma.CompanyUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.website !== undefined) data.website = input.website || null;
  if (input.industry !== undefined) data.industry = input.industry || null;
  if (input.brandVoiceNotes !== undefined)
    data.brandVoiceNotes = input.brandVoiceNotes || null;
  if (input.logoUrl !== undefined) data.logoUrl = input.logoUrl || null;

  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const company = await tx.company.update({
      where: { id: companyId },
      data,
    });

    await recordAudit(
      {
        action: 'COMPANY_UPDATED',
        userId,
        companyId,
        metadata: { changedFields: Object.keys(data) },
        ...requestMeta,
      },
      tx,
    );

    return company;
  });
}
