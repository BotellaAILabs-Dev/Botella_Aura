import { Prisma, type AuditAction } from '@prisma/client';

import { db } from '@/lib/db';
import {
  BusinessContextConflictError,
  BusinessContextUpdateError,
  businessContextPatchSchema,
  type UpdateOrigin,
} from '@/lib/validations/business-context';
import { recordAudit } from '@/server/services/audit.service';
import { planBusinessContextWrite, type BusinessContextWrite } from './update';

/**
 * The only way business information is written to the trusted context.
 *
 * Onboarding, the company profile, audience, brand, formats and brand voice
 * screens, logo upload, AI voice generation and PATCH /api/business-context all
 * call updateBusinessContext, so a value can only enter the context through
 * the patch schema and the update rules in ./update.ts.
 *
 * Deliberately does not import the read service: brand voice generation calls
 * this, and the read service renders brand voice, so importing it here would
 * make a cycle. Callers that want the new context read it afterwards.
 */

export class CompanyNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('Company not found.');
    this.name = 'CompanyNotFoundError';
  }
}

export interface UpdateBusinessContextArgs {
  companyId: string;
  /** Null for system and AI writes with no person behind them. */
  userId: string | null;
  /** Raw patch. Validated here, whatever the caller already checked. */
  patch: unknown;
  origin: UpdateOrigin;
  /**
   * Fields a person has reviewed and vouches for as they stand. Records them
   * as confirmed now, which makes an AI-drafted value trusted and resets its
   * freshness. Not allowed from AI-originated writes.
   */
  confirm?: readonly string[];
  /** Refuse the write if the workspace changed after this `meta.revision`. */
  expectedRevision?: string;
  /** Context path → the caller's form field name, for error `details`. */
  aliases?: Record<string, string>;
  /** Audit action to record. Defaults to COMPANY_UPDATED. */
  auditAction?: AuditAction;
  auditMetadata?: Record<string, unknown>;
  requestMeta?: { ipAddress?: string | null; userAgent?: string | null };
}

export interface UpdateBusinessContextResult {
  /** Field paths that changed. Empty means nothing was written (rule R7). */
  changed: string[];
  /** Field paths confirmed without being changed. */
  confirmed: string[];
  /** The new `meta.revision`, or the unchanged one for a no-op. */
  revision: string;
}

export async function updateBusinessContext(
  args: UpdateBusinessContextArgs,
): Promise<UpdateBusinessContextResult> {
  // Shape first, outside the transaction: a ZodError becomes a 422 with the
  // offending fields named (handleRouteError).
  const patch = businessContextPatchSchema.parse(args.patch);

  /**
   * Compare-and-swap, retried.
   *
   * `preferences` is one JSON bag shared with other writers (autopilot
   * settings, and this service running concurrently — e.g. AI voice
   * generation saving while the user edits their goals). Each writer reads the
   * bag, merges its part and writes the whole bag back, so a plain update
   * would let the later write silently erase the earlier one. The update only
   * applies if the row is unchanged since it was read; otherwise the write is
   * re-planned from a fresh read, so both changes survive.
   */
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    try {
      return await writeOnce(args, patch);
    } catch (err) {
      if (!(err instanceof LostRace) || attempt === MAX_WRITE_ATTEMPTS) {
        if (err instanceof LostRace) throw new BusinessContextConflictError();
        throw err;
      }
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new BusinessContextConflictError();
}

const MAX_WRITE_ATTEMPTS = 3;

/** Another write landed between this write's read and its update. */
class LostRace extends Error {}

async function writeOnce(
  args: UpdateBusinessContextArgs,
  patch: ReturnType<typeof businessContextPatchSchema.parse>,
): Promise<UpdateBusinessContextResult> {
  return db.$transaction(async (tx) => {
    const row = await tx.company.findUnique({
      where: { id: args.companyId },
      select: {
        name: true,
        website: true,
        industry: true,
        brandVoiceNotes: true,
        brandVoiceProfile: true,
        preferences: true,
        updatedAt: true,
      },
    });
    if (!row) throw new CompanyNotFoundError();

    if (
      args.expectedRevision &&
      row.updatedAt.toISOString() !== args.expectedRevision
    ) {
      throw new BusinessContextConflictError();
    }

    const plan = planBusinessContextWrite(
      row,
      patch,
      args.origin,
      args.aliases,
      { confirm: args.confirm },
    );
    if (plan.changed.length === 0 && plan.confirmed.length === 0) {
      return {
        changed: [],
        confirmed: [],
        revision: row.updatedAt.toISOString(),
      };
    }

    // R5: a logo must be one of this workspace's own assets. Without this, any
    // asset id — including another workspace's — could be written in, and the
    // brand page would show a broken image the user cannot explain.
    if (plan.references.logoAssetId) {
      const asset = await tx.generatedAsset.findFirst({
        where: { id: plan.references.logoAssetId, companyId: args.companyId },
        select: { id: true },
      });
      if (!asset) {
        throw new BusinessContextUpdateError(
          [
            {
              field: 'identity.visual.logoAssetId',
              message:
                'That logo was not found in this workspace. Upload it again.',
            },
          ],
          args.aliases,
        );
      }
    }

    // Only if nobody wrote since our read; otherwise re-plan from fresh data.
    const swapped = await tx.company.updateMany({
      where: { id: args.companyId, updatedAt: row.updatedAt },
      data: toCompanyData(plan.data) as Prisma.CompanyUpdateManyMutationInput,
    });
    if (swapped.count === 0) throw new LostRace();
    const updated = await tx.company.findUnique({
      where: { id: args.companyId },
      select: { updatedAt: true },
    });
    if (!updated) throw new CompanyNotFoundError();

    await recordAudit(
      {
        action: args.auditAction ?? 'COMPANY_UPDATED',
        userId: args.userId,
        companyId: args.companyId,
        metadata: {
          ...args.auditMetadata,
          via: 'business-context',
          origin: args.origin,
          changedFields: plan.changed,
          ...(plan.confirmed.length ? { confirmedFields: plan.confirmed } : {}),
        },
        ...args.requestMeta,
      },
      tx,
    );

    return {
      changed: plan.changed,
      confirmed: plan.confirmed,
      revision: updated.updatedAt.toISOString(),
    };
  });
}

/** Map a planned write onto Prisma column inputs. */
export function toCompanyData(
  data: BusinessContextWrite,
): Prisma.CompanyUpdateInput {
  const out: Prisma.CompanyUpdateInput = {};
  if (data.name !== undefined) out.name = data.name;
  if (data.website !== undefined) out.website = data.website;
  if (data.industry !== undefined) out.industry = data.industry;
  if (data.brandVoiceNotes !== undefined)
    out.brandVoiceNotes = data.brandVoiceNotes;
  if (data.brandVoiceProfile !== undefined) {
    out.brandVoiceProfile =
      data.brandVoiceProfile === null
        ? Prisma.DbNull
        : (data.brandVoiceProfile as Prisma.InputJsonObject);
  }
  if (data.preferences !== undefined) {
    // Everything in here came through the patch schema or was already stored,
    // so it is JSON-safe; Prisma cannot see that through the `unknown` bag.
    out.preferences = data.preferences as Prisma.InputJsonObject;
  }
  return out;
}
