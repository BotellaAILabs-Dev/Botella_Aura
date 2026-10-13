import type { ContentDraft, OutreachMessage, Prisma } from '@prisma/client';

import {
  addVersion,
  findVersion,
  legacyLog,
  markApproved,
  newLog,
  versionLogOf,
  type VersionLog,
  type VersionSource,
} from '@/lib/versions';

/**
 * Content versions (lib/versions.ts) on stored items, in aiMetadata.versions.
 *
 * Writers call these with the metadata they are about to save; the version
 * log is carried along, so every path that changes a body adds a version.
 */

type Meta = Record<string, unknown>;

type DraftLike = Pick<
  ContentDraft,
  'aiMetadata' | 'body' | 'createdAt' | 'status'
>;
type MessageLike = Pick<
  OutreachMessage,
  'aiMetadata' | 'draftText' | 'createdAt' | 'status'
>;

/** The draft's log — rebuilt from its undo history if it predates versions. */
export function contentLog(draft: DraftLike): VersionLog {
  const meta = (draft.aiMetadata ?? {}) as Meta;
  const existing = versionLogOf(meta);
  if (existing) return existing;
  const history = (Array.isArray(meta.history) ? meta.history : []) as {
    body: unknown;
    at?: string;
  }[];
  const log = legacyLog(
    draft.body,
    draft.createdAt.toISOString(),
    history.filter((h) => h && h.body !== undefined),
  );
  // Approved before versions were kept: the content as it stands is what was approved.
  return draft.status === 'APPROVED' || draft.status === 'PUBLISHED'
    ? markApproved(log, null, draft.createdAt.toISOString())
    : log;
}

/** `meta` with a new version of the draft's body added. */
export function withContentVersion(
  draft: DraftLike,
  meta: unknown,
  v: {
    body: unknown;
    source: VersionSource;
    by: string | null;
    basedOn?: number | null;
    note?: string | null;
  },
): Prisma.InputJsonValue {
  const log = addVersion(contentLog(draft), v);
  return {
    ...((meta ?? {}) as Meta),
    versions: log,
  } as unknown as Prisma.InputJsonValue;
}

/** `meta` with the draft's current version marked as approved. */
export function withApprovedContentVersion(
  draft: DraftLike,
  meta: unknown,
  by: string | null,
): Prisma.InputJsonValue {
  return {
    ...((meta ?? {}) as Meta),
    versions: markApproved(contentLog(draft), by),
  } as unknown as Prisma.InputJsonValue;
}

/** The first version of a newly generated draft. */
export function firstVersion(body: unknown): VersionLog {
  return newLog(body, new Date().toISOString(), null);
}

/** The version to restore, checked to belong to this draft. */
export function contentVersion(draft: DraftLike, n: number) {
  const v = findVersion(contentLog(draft), n);
  if (!v)
    throw Object.assign(new Error(`There is no version ${n}.`), {
      status: 404,
    });
  return v;
}

/** Which earlier version a body is (for an undo): the latest with the same content. */
export function versionMatching(
  draft: DraftLike,
  body: unknown,
  hashOf: (b: unknown) => string,
): number | null {
  const h = hashOf(body);
  const match = [...contentLog(draft).versions]
    .reverse()
    .find((v) => v.hash === h);
  return match?.n ?? null;
}

// ---------------------------------------------------------------------------
// Outreach messages
// ---------------------------------------------------------------------------

export function messageLog(m: MessageLike): VersionLog {
  const meta = (m.aiMetadata ?? {}) as Meta;
  const existing = versionLogOf(meta);
  if (existing) return existing;
  const history = (Array.isArray(meta.history) ? meta.history : []) as {
    text?: string;
    at?: string;
  }[];
  const log = legacyLog(
    m.draftText,
    m.createdAt.toISOString(),
    history
      .filter((h) => typeof h?.text === 'string')
      .map((h) => ({ body: h.text, at: h.at })),
  );
  return m.status === 'APPROVED' || m.status === 'SENT'
    ? markApproved(log, null, m.createdAt.toISOString())
    : log;
}

export function withMessageVersion(
  m: MessageLike,
  meta: unknown,
  v: {
    text: string;
    source: VersionSource;
    by: string | null;
    basedOn?: number | null;
    note?: string | null;
  },
): Prisma.InputJsonValue {
  const log = addVersion(messageLog(m), {
    body: v.text,
    source: v.source,
    by: v.by,
    basedOn: v.basedOn,
    note: v.note,
  });
  return {
    ...((meta ?? {}) as Meta),
    versions: log,
  } as unknown as Prisma.InputJsonValue;
}

export function withApprovedMessageVersion(
  m: MessageLike,
  meta: unknown,
  by: string | null,
): Prisma.InputJsonValue {
  return {
    ...((meta ?? {}) as Meta),
    versions: markApproved(messageLog(m), by),
  } as unknown as Prisma.InputJsonValue;
}

export function messageVersion(m: MessageLike, n: number) {
  const v = findVersion(messageLog(m), n);
  if (!v || typeof v.body !== 'string')
    throw Object.assign(new Error(`There is no version ${n}.`), {
      status: 404,
    });
  return v as typeof v & { body: string };
}
