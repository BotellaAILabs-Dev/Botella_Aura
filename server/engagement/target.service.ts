import { db } from '@/lib/db';
import { recordAudit } from '@/server/services/audit.service';
import type { CreateTargetInput } from '@/lib/validations/engagement';

/**
 * Engagement targets = specific PUBLIC profiles/pages the user chose to monitor.
 * Monitoring itself happens entirely in the extension (DOM the user already
 * sees); this service just stores the user's chosen list.
 */
interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function listTargets(companyId: string) {
  return db.engagementTarget.findMany({
    where: { companyId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function addTarget(args: {
  companyId: string;
  userId: string;
  input: CreateTargetInput;
  requestMeta?: Meta;
}) {
  const { companyId, userId, input, requestMeta } = args;
  const target = await db.engagementTarget.upsert({
    where: { companyId_profileUrl: { companyId, profileUrl: input.profileUrl } },
    create: { companyId, label: input.label, profileUrl: input.profileUrl },
    update: { label: input.label },
  });
  await recordAudit({
    action: 'ENGAGEMENT_TARGET_ADDED',
    userId,
    companyId,
    metadata: { targetId: target.id, profileUrl: target.profileUrl },
    ...requestMeta,
  });
  return target;
}

export async function removeTarget(args: {
  companyId: string;
  userId: string;
  targetId: string;
  requestMeta?: Meta;
}) {
  const { companyId, userId, targetId, requestMeta } = args;
  const result = await db.engagementTarget.deleteMany({
    where: { id: targetId, companyId },
  });
  if (result.count > 0) {
    await recordAudit({
      action: 'ENGAGEMENT_TARGET_REMOVED',
      userId,
      companyId,
      metadata: { targetId },
      ...requestMeta,
    });
  }
}
