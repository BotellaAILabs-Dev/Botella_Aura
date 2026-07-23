import type { AuditAction, Prisma, PrismaClient } from '@prisma/client';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

/**
 * Central audit-trail writer. Every meaningful business action routes through
 * here (see NON-NEGOTIABLE #4). Accepts an optional transaction client so an
 * audit entry can be written atomically with the action it describes.
 *
 * Audit writes must NEVER break the primary action: if logging fails we record
 * the failure and swallow it, rather than failing the user's request.
 */
type DbClient = PrismaClient | Prisma.TransactionClient;

export interface AuditInput {
  action: AuditAction;
  userId?: string | null;
  companyId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function recordAudit(
  input: AuditInput,
  client: DbClient = db,
): Promise<void> {
  try {
    await client.auditLog.create({
      data: {
        action: input.action,
        userId: input.userId ?? null,
        companyId: input.companyId ?? null,
        metadata: input.metadata ?? {},
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  } catch (error) {
    logger.error('Failed to write audit log', {
      action: input.action,
      userId: input.userId,
      companyId: input.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
