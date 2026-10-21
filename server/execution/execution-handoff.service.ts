import type { ContentDraft, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { connectionGate } from '@/server/connections/health.service';
import { syncFromHandoff } from '@/server/execution/engine.service';
import { logger } from '@/lib/logger';
import { approvalOf } from '@/lib/approval';
import { versionLogOf } from '@/lib/versions';
import { tokenHealth } from '@/lib/meta';
import { resolvePlatform } from '@/lib/platforms';
import { isCopyOnlyType, type ContentTypeKey } from '@/lib/validations/content';
import {
  buildExecutionHandoff,
  type ExecutionHandoff,
  type ExecutionPlatform,
  type HandoffFacts,
} from '@/lib/execution-handoff';
import { contentHash } from '@/server/approval/approval.service';
import { renderForManual, renderLinkedInCommentary } from '@/server/content/render';
import { canAutoPublishTo } from '@/server/content/publish.service';
import { validateForPlatform, validateMediaSet } from '@/server/media/validate';
import { recordAudit } from '@/server/services/audit.service';
import { executionService } from '@/server/execution/execution.service';

/**
 * Approval → Execution handoff on the server (lib/execution-handoff.ts holds
 * the contract and rules).
 *
 *   prepareExecutionHandoff   on approval (and schedule changes): gather the
 *                             facts, build and validate the package, keep it
 *                             (ExecutionHandoff), pass a READY one to the
 *                             execution service (server/execution/execution.service.ts)
 *   getExecutionHandoff       the package as it stands NOW — re-validated, so
 *                             an expired connection shows as soon as it expires
 *   markHandoffExecuted       published by any path
 *
 * Everything is scoped to the workspace. A failure here never fails the
 * approval that triggered it: it is logged, and the next read re-prepares.
 */

const META_PLATFORMS = new Set(['FACEBOOK', 'INSTAGRAM']);

function textFor(draft: ContentDraft, platform: ExecutionPlatform): string {
  if (platform === 'LINKEDIN') return renderLinkedInCommentary(draft) ?? renderForManual(draft);
  if (META_PLATFORMS.has(platform)) return renderForManual(draft).slice(0, 2200);
  return renderForManual(draft);
}

async function gatherFacts(companyId: string, draft: ContentDraft, platform: ExecutionPlatform): Promise<HandoffFacts> {
  const meta = (draft.aiMetadata ?? {}) as Record<string, unknown>;
  const [media, company, linkedin, metaConn, currentHash, gate] = await Promise.all([
    db.contentMedia.findMany({
      where: { companyId, contentDraftId: draft.id },
      orderBy: { position: 'asc' },
      include: { asset: { select: { id: true, kind: true, mimeType: true, width: true, height: true, fileSize: true, metadata: true } } },
    }),
    db.company.findUnique({ where: { id: companyId }, select: { website: true } }),
    db.linkedInConnection.findUnique({ where: { companyId } }),
    db.connection.findUnique({ where: { companyId_connectorId: { companyId, connectorId: 'meta' } } }),
    contentHash(draft),
    connectionGate(companyId, platform, draft.scheduledFor ? 'scheduling' : 'organic_publishing'),
  ]);
  const type = draft.type as ContentTypeKey;
  const mediaProblems =
    media.length > 0 && platform !== 'X'
      ? [
          ...validateMediaSet(media.map((m) => m.asset), platform),
          ...media.flatMap((m) => validateForPlatform(m.asset, platform).problems),
        ]
      : [];
  const rec = (meta.recommendation ?? null) as { recommendationId?: string; id?: string; opportunityId?: string; audience?: string | null } | null;
  const metaMeta = (metaConn?.metadata ?? {}) as { pageId?: string; pageName?: string; igUserId?: string; igUsername?: string };
  const body = (draft.body ?? {}) as { cta?: string };
  return {
    companyId,
    draft: {
      id: draft.id,
      type: draft.type,
      status: draft.status,
      title: draft.title ?? null,
      scheduledFor: draft.scheduledFor,
      body: draft.body,
      currentHash,
      cta: typeof body.cta === 'string' ? body.cta : null,
    },
    approval: approvalOf(draft.aiMetadata),
    versions: versionLogOf(draft.aiMetadata),
    platform,
    text: textFor(draft, platform),
    media: media.map((m) => ({
      assetId: m.assetId,
      kind: m.asset.kind,
      mimeType: m.asset.mimeType,
      width: m.asset.width,
      height: m.asset.height,
      altText: m.altText,
      position: m.position,
    })),
    mediaProblems: [...new Set(mediaProblems)],
    formatSupported: platform === 'X' ? false : canAutoPublishTo(type, platform),
    copyOnly: isCopyOnlyType(type),
    recommendation: rec
      ? { recommendationId: rec.recommendationId ?? rec.id ?? null, opportunityId: rec.opportunityId ?? null, audience: rec.audience ?? null }
      : null,
    businessWebsite: company?.website ?? null,
    connections: {
      linkedin: linkedin
        ? {
            connected: linkedin.status === 'ACTIVE' && Boolean(linkedin.accessTokenEnc),
            expired: Boolean(linkedin.expiresAt && linkedin.expiresAt < new Date()),
            scopes: (linkedin.scope ?? '').split(/[\s,]+/).filter(Boolean),
            memberName: linkedin.displayName,
            memberId: linkedin.linkedInUserId,
            orgUrn: process.env.LINKEDIN_ORG_URN?.trim() || null,
          }
        : null,
      meta: metaConn
        ? {
            connected: metaConn.status === 'CONNECTED' && Boolean(metaConn.accessTokenEnc),
            expired: tokenHealth(metaConn.expiresAt) === 'expired',
            pageId: metaMeta.pageId ?? null,
            pageName: metaMeta.pageName ?? null,
            igUserId: metaMeta.igUserId ?? null,
            igUsername: metaMeta.igUsername ?? null,
          }
        : null,
    },
    connectionGate: gate.noRecord ? null : { allowed: gate.allowed, reason: gate.reason, fix: gate.fix },
  };
}

const STATUS = { ready: 'READY', blocked: 'BLOCKED', superseded: 'SUPERSEDED', executed: 'EXECUTED' } as const;

/**
 * Build, validate and keep the handoff for an approved draft (its own target
 * network unless one is given). Null when it has never been approved.
 */
export async function prepareExecutionHandoff(args: {
  companyId: string;
  draftId: string;
  platform?: ExecutionPlatform;
  userId?: string | null;
  now?: Date;
}): Promise<ExecutionHandoff | null> {
  const draft = await db.contentDraft.findFirst({ where: { id: args.draftId, companyId: args.companyId } });
  if (!draft) return null;
  if (!approvalOf(draft.aiMetadata)?.approved || draft.status !== 'APPROVED' && draft.status !== 'PUBLISHED') {
    // Not (or no longer) approved: executions waiting on it are cancelled.
    try {
      const waiting = await db.execution.findMany({ where: { contentDraftId: draft.id }, select: { platform: true } });
      for (const w of waiting) await syncFromHandoff({ companyId: args.companyId, draftId: draft.id, platform: w.platform, userId: args.userId });
    } catch (err) {
      logger.warn('execution handoff: executions not updated', { draftId: draft.id, error: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }
  const platform = (args.platform ?? resolvePlatform(draft.type as ContentTypeKey, draft.platform)) as ExecutionPlatform;
  const facts = await gatherFacts(args.companyId, draft, platform);
  const handoff = buildExecutionHandoff(facts, args.now);
  const status = STATUS[handoff.readiness.status];

  const key = { contentDraftId_platform: { contentDraftId: draft.id, platform } };
  const before = await db.executionHandoff.findUnique({ where: key, select: { status: true, contentHash: true } });
  const data = {
    status,
    payload: handoff as unknown as Prisma.InputJsonObject,
    issues: handoff.readiness.issues as unknown as Prisma.InputJsonArray,
    contentVersion: handoff.contentVersion.version,
    contentHash: handoff.contentVersion.hash,
    scheduledFor: draft.scheduledFor,
    preparedAt: args.now ?? new Date(),
  };
  await db.executionHandoff.upsert({
    where: key,
    create: { companyId: args.companyId, contentDraftId: draft.id, platform, ...data },
    update: data,
  });

  // A change worth recording: it became ready (handed over), or blocked (why).
  const changed = before?.status !== status || before?.contentHash !== handoff.contentVersion.hash;
  if (changed && (status === 'READY' || status === 'BLOCKED')) {
    await recordAudit({
      action: status === 'READY' ? 'EXECUTION_HANDOFF_READY' : 'EXECUTION_HANDOFF_BLOCKED',
      userId: args.userId ?? null,
      companyId: args.companyId,
      metadata: {
        draftId: draft.id,
        platform,
        contentVersion: handoff.contentVersion.version,
        ...(status === 'BLOCKED' ? { issues: handoff.readiness.issues.map((i) => i.code) } : {}),
      },
    });
    if (status === 'READY') await executionService().accept(handoff);
  }
  // The execution follows the handoff (lib/execution-state.ts).
  await syncFromHandoff({ companyId: args.companyId, draftId: draft.id, platform, userId: args.userId });
  return handoff;
}

/**
 * Best effort, for hooks (approval, scheduling): never throws — a handoff
 * problem must not fail the approval itself. The next read re-prepares.
 */
export async function refreshExecutionHandoff(args: { companyId: string; draftId: string; userId?: string | null }): Promise<void> {
  try {
    await prepareExecutionHandoff(args);
  } catch (err) {
    logger.warn('execution handoff: could not prepare', {
      draftId: args.draftId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The handoff as it stands now (re-validated), or null if never approved. */
export function getExecutionHandoff(companyId: string, draftId: string): Promise<ExecutionHandoff | null> {
  return prepareExecutionHandoff({ companyId, draftId });
}

/** Published by any path: its handoffs are done. */
export async function markHandoffExecuted(companyId: string, draftId: string): Promise<void> {
  try {
    await db.executionHandoff.updateMany({ where: { companyId, contentDraftId: draftId }, data: { status: 'EXECUTED' } });
  } catch (err) {
    logger.warn('execution handoff: could not mark executed', { draftId, error: err instanceof Error ? err.message : String(err) });
  }
}
