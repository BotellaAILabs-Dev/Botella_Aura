import type { CompanyRole } from '@prisma/client';

import { db } from '@/lib/db';
import { can } from '@/lib/rbac';
import { bodyToFields, type ReviewKind } from '@/lib/review-item';
import { summarizeVersions, type VersionSummary } from '@/lib/versions';
import { updateDraftBody } from '@/server/content/content.service';
import { updateMessageText } from '@/server/outreach/outreach.service';
import {
  contentLog,
  contentVersion,
  messageLog,
  messageVersion,
} from '@/server/versions/version.service';

/**
 * Listing and restoring versions for the review screen, the same way for a
 * content draft and an outreach message.
 */

export interface VersionView extends VersionSummary {
  byName: string;
  /** The version as a reader sees it. */
  text: string;
}

const textOf = (body: unknown) =>
  typeof body === 'string'
    ? body
    : bodyToFields(body)
        .map((f) =>
          f.list && f.value
            ? f.value
                .split(' ')
                .map((t) => `#${t}`)
                .join(' ')
            : f.value,
        )
        .filter(Boolean)
        .join('\n\n');

async function names(ids: (string | null)[]) {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const users = list.length
    ? await db.user.findMany({
        where: { id: { in: list } },
        select: { id: true, name: true, email: true },
      })
    : [];
  return (id: string | null) =>
    id
      ? (users.find((u) => u.id === id)?.name ??
        users.find((u) => u.id === id)?.email ??
        'A former member')
      : 'Aura';
}

export async function listVersions(
  kind: ReviewKind,
  companyId: string,
  id: string,
): Promise<{
  versions: VersionView[];
  current: number;
  approved: number | null;
} | null> {
  const log =
    kind === 'content'
      ? await db.contentDraft
          .findFirst({ where: { id, companyId } })
          .then((d) => (d ? contentLog(d) : null))
      : await db.outreachMessage
          .findFirst({ where: { id, companyId } })
          .then((m) => (m ? messageLog(m) : null));
  if (!log) return null;
  const name = await names([
    ...log.versions.map((v) => v.by),
    log.approved?.by ?? null,
  ]);
  const bodies = new Map(log.versions.map((v) => [v.n, v.body]));
  return {
    versions: summarizeVersions(log).map((v) => ({
      ...v,
      byName: name(v.by),
      text: textOf(bodies.get(v.n)),
    })),
    current: log.current,
    approved: log.approved?.n ?? null,
  };
}

/**
 * Make an earlier version current: it comes back as a NEW version ("restored
 * from vN"), so nothing is overwritten. Approved work is reopened, as with
 * any change.
 */
export async function restoreVersion(args: {
  kind: ReviewKind;
  companyId: string;
  userId: string;
  role: CompanyRole;
  id: string;
  version: number;
}): Promise<{ status: string; current: number }> {
  if (args.kind === 'content') {
    if (!can(args.role, 'content:create'))
      throw Object.assign(new Error('Your role is read-only.'), {
        status: 403,
      });
    const draft = await db.contentDraft.findFirst({
      where: { id: args.id, companyId: args.companyId },
    });
    if (!draft) throw Object.assign(new Error('Not found.'), { status: 404 });
    const v = contentVersion(draft, args.version);
    if (contentLog(draft).current === v.n)
      throw Object.assign(new Error('That is already the current version.'), {
        status: 409,
      });
    const updated = await updateDraftBody({
      companyId: args.companyId,
      userId: args.userId,
      draftId: draft.id,
      body: v.body,
      versionSource: 'restored',
      basedOn: v.n,
    });
    return { status: updated.status, current: contentLog(updated).current };
  }
  if (!can(args.role, 'content:approve'))
    throw Object.assign(
      new Error('Only owners and admins can work on outreach.'),
      { status: 403 },
    );
  const msg = await db.outreachMessage.findFirst({
    where: { id: args.id, companyId: args.companyId },
  });
  if (!msg) throw Object.assign(new Error('Not found.'), { status: 404 });
  const v = messageVersion(msg, args.version);
  if (messageLog(msg).current === v.n)
    throw Object.assign(new Error('That is already the current version.'), {
      status: 409,
    });
  const updated = await updateMessageText({
    companyId: args.companyId,
    userId: args.userId,
    messageId: msg.id,
    draftText: v.body,
    versionSource: 'restored',
    basedOn: v.n,
  });
  return { status: updated.status, current: messageLog(updated).current };
}
