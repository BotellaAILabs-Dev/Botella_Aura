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

    /**
     * Everything the wizard collected, persisted in one go.
     *
     * The business description, market mode, audience and goals live in the
     * `preferences` bag alongside brand assets and autopilot settings — the
     * established extension point for workspace profile data (see
     * lib/validations/profile.ts), so no migration is needed and older
     * workspaces keep parsing cleanly.
     *
     * Before this, the wizard's answers to these questions had nowhere to go:
     * createCompanyForUser wrote four columns and dropped the rest, so a user
     * who described their buyers during onboarding still arrived at a
     * dashboard that believed it had never been told.
     */
    const preferences: Prisma.InputJsonValue = {
      business: {
        ...(input.description ? { description: input.description } : {}),
        ...(input.offerings ? { offerings: input.offerings } : {}),
      },
      marketingProfile: {
        ...(input.marketMode ? { marketMode: input.marketMode } : {}),
        ...(input.audience ? { audience: input.audience } : {}),
        ...(input.goals ? { goals: input.goals } : {}),
      },
    };

    const company = await tx.company.create({
      data: {
        name: input.name,
        slug,
        website: input.website ?? null,
        industry: input.industry || null,
        brandVoiceNotes: input.brandVoiceNotes || null,
        preferences,
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

  const editsBusiness =
    input.description !== undefined || input.offerings !== undefined;

  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    /**
     * Merge, never replace.
     *
     * `preferences` is shared with brand assets, the marketing profile and
     * autopilot settings, so writing a fresh object here would silently delete
     * whatever else the workspace had configured. Read-modify-write inside the
     * same transaction keeps the other keys intact.
     */
    if (editsBusiness) {
      const current = await tx.company.findUnique({
        where: { id: companyId },
        select: { preferences: true },
      });
      const bag =
        current?.preferences &&
        typeof current.preferences === 'object' &&
        !Array.isArray(current.preferences)
          ? (current.preferences as Record<string, unknown>)
          : {};
      const business =
        bag.business && typeof bag.business === 'object' && !Array.isArray(bag.business)
          ? (bag.business as Record<string, unknown>)
          : {};

      data.preferences = {
        ...bag,
        business: {
          ...business,
          ...(input.description !== undefined
            ? { description: input.description || undefined }
            : {}),
          ...(input.offerings !== undefined
            ? { offerings: input.offerings || undefined }
            : {}),
        },
      } as Prisma.InputJsonValue;
    }

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
