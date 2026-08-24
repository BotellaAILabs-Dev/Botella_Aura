import { db } from '@/lib/db';
import { recordAudit } from '@/server/services/audit.service';
import type {
  CreateDiscoveryProfileInput,
  UpdateDiscoveryProfileInput,
} from '@/lib/validations/discovery';

/** DiscoveryProfile CRUD + run history (Sprint 5, Module 1). */
export class DiscoveryProfileNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('Discovery profile not found.');
    this.name = 'DiscoveryProfileNotFoundError';
  }
}

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function listProfiles(companyId: string) {
  return db.discoveryProfile.findMany({
    where: { companyId },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { leads: true, runs: true } },
      runs: { orderBy: { startedAt: 'desc' }, take: 1 },
    },
  });
}

export async function getProfileOrThrow(companyId: string, profileId: string) {
  const profile = await db.discoveryProfile.findFirst({
    where: { id: profileId, companyId },
  });
  if (!profile) throw new DiscoveryProfileNotFoundError();
  return profile;
}

export async function listRuns(companyId: string) {
  return db.discoveryRun.findMany({
    where: { companyId },
    orderBy: { startedAt: 'desc' },
    take: 20,
    include: { profile: { select: { name: true, category: true } } },
  });
}

export async function createProfile(args: {
  companyId: string;
  userId: string;
  input: CreateDiscoveryProfileInput;
  requestMeta?: Meta;
}) {
  const { companyId, userId, input, requestMeta } = args;
  return db.$transaction(async (tx) => {
    const profile = await tx.discoveryProfile.create({
      data: {
        companyId,
        name: input.name,
        // Falling back to the name guarantees every discovered lead carries a
        // requirement label, so results from different requirements never mix.
        category: input.category?.trim() || input.name,
        criteria: input.criteria,
        autoRun: input.autoRun,
      },
    });
    await recordAudit(
      {
        action: 'DISCOVERY_PROFILE_CREATED',
        userId,
        companyId,
        metadata: { profileId: profile.id, name: profile.name },
        ...requestMeta,
      },
      tx,
    );
    return profile;
  });
}

export async function updateProfile(args: {
  companyId: string;
  userId: string;
  profileId: string;
  input: UpdateDiscoveryProfileInput;
  requestMeta?: Meta;
}) {
  const { companyId, userId, profileId, input, requestMeta } = args;
  await getProfileOrThrow(companyId, profileId);

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.category !== undefined) data.category = input.category.trim() || null;
  if (input.criteria !== undefined) data.criteria = input.criteria;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.autoRun !== undefined) data.autoRun = input.autoRun;

  return db.$transaction(async (tx) => {
    const profile = await tx.discoveryProfile.update({
      where: { id: profileId },
      data,
    });
    await recordAudit(
      {
        action: 'DISCOVERY_PROFILE_UPDATED',
        userId,
        companyId,
        metadata: { profileId, changedFields: Object.keys(data) },
        ...requestMeta,
      },
      tx,
    );
    return profile;
  });
}

export async function deleteProfile(args: {
  companyId: string;
  userId: string;
  profileId: string;
  requestMeta?: Meta;
}) {
  const { companyId, userId, profileId, requestMeta } = args;
  await getProfileOrThrow(companyId, profileId);
  await db.$transaction(async (tx) => {
    await tx.discoveryProfile.delete({ where: { id: profileId } });
    await recordAudit(
      {
        action: 'DISCOVERY_PROFILE_DELETED',
        userId,
        companyId,
        metadata: { profileId },
        ...requestMeta,
      },
      tx,
    );
  });
}
