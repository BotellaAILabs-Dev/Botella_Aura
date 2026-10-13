import { describe, it, expect } from 'vitest';

import {
  addVersion,
  bodyFingerprint,
  findVersion,
  legacyLog,
  markApproved,
  MAX_VERSIONS,
  newLog,
  summarizeVersions,
  type VersionLog,
} from '@/lib/versions';
import {
  contentLog,
  messageLog,
  versionMatching,
  withContentVersion,
} from '@/server/versions/version.service';

/**
 * Edit & version management: the original AI version stays recoverable,
 * every edit and regeneration is a new numbered version with its editor and
 * time, and the approved version is always identifiable.
 */

const v1 = { caption: 'New rye on the shelf.', cta: 'Visit us' };
const v2 = { caption: 'New small-batch rye on the shelf.', cta: 'Visit us' };
const v3 = { caption: 'Meet our new rye.', cta: 'Book a tasting' };

describe('versions', () => {
  it('version 1 is the original AI version; each change adds the next number and becomes current', () => {
    let log = newLog(v1, '2026-10-13T08:00:00Z');
    log = addVersion(log, { body: v2, source: 'edited', by: 'user_1' });
    log = addVersion(log, {
      body: v3,
      source: 'regenerated',
      by: 'user_1',
      note: 'regenerate',
    });
    expect(log.versions.map((v) => [v.n, v.source])).toEqual([
      [1, 'generated'],
      [2, 'edited'],
      [3, 'regenerated'],
    ]);
    expect(log.current).toBe(3);
    expect(findVersion(log, 1)!.body).toEqual(v1);
    expect(log.versions[1]).toMatchObject({ by: 'user_1' });
    expect(log.versions[1]!.at).toMatch(/^\d{4}-/);
  });

  it('saving the same content adds nothing — whatever order the keys come back in', () => {
    const log = newLog(v1, 'x');
    expect(
      addVersion(log, {
        body: { cta: 'Visit us', caption: 'New rye on the shelf.' },
        source: 'edited',
        by: 'u',
      }),
    ).toBe(log);
    expect(bodyFingerprint({ a: 1, b: 2 })).toBe(
      bodyFingerprint({ b: 2, a: 1 }),
    );
  });

  it('restoring brings an old version back as a NEW version — nothing is overwritten', () => {
    let log = addVersion(newLog(v1, 'x'), {
      body: v2,
      source: 'edited',
      by: 'u',
    });
    log = addVersion(log, {
      body: v1,
      source: 'restored',
      by: 'u',
      basedOn: 1,
    });
    expect(log.versions).toHaveLength(3);
    expect(log.versions[2]).toMatchObject({
      n: 3,
      source: 'restored',
      basedOn: 1,
    });
    expect(findVersion(log, 2)!.body).toEqual(v2);
  });

  it('the approved version is marked and stays identifiable after later edits', () => {
    let log = addVersion(newLog(v1, 'x'), {
      body: v2,
      source: 'edited',
      by: 'u',
    });
    log = markApproved(log, 'owner_1');
    log = addVersion(log, { body: v3, source: 'edited', by: 'u' });
    const s = summarizeVersions(log);
    expect(s[0]).toMatchObject({ n: 3, isCurrent: true, isApproved: false });
    expect(s.find((x) => x.isApproved)).toMatchObject({ n: 2 });
    expect(s.find((x) => x.isOriginal)).toMatchObject({ n: 1 });
    expect(log.approved).toMatchObject({ n: 2, by: 'owner_1' });
  });

  it('over the cap, the oldest versions go — never the original, the approved or the current one', () => {
    let log: VersionLog = newLog({ i: 0 }, 'x');
    log = addVersion(log, { body: { i: 1 }, source: 'edited', by: 'u' });
    log = markApproved(log, 'o'); // v2 approved
    for (let i = 2; i < MAX_VERSIONS + 20; i++)
      log = addVersion(log, { body: { i }, source: 'edited', by: 'u' });
    expect(log.versions).toHaveLength(MAX_VERSIONS);
    const ns = log.versions.map((v) => v.n);
    expect(ns).toContain(1);
    expect(ns).toContain(2);
    expect(ns).toContain(log.current);
  });

  it('an item made before versions existed is rebuilt from its undo history, oldest first', () => {
    const log = legacyLog(v3, '2026-10-01T00:00:00Z', [
      { body: v2, at: '2026-10-02T00:00:00Z' },
      { body: v1, at: '2026-10-01T12:00:00Z' },
    ]);
    expect(log.versions.map((v) => v.body)).toEqual([v1, v2, v3]);
    expect(log.current).toBe(3);
  });
});

describe('on stored items', () => {
  const draft = (over: Record<string, unknown> = {}) =>
    ({
      status: 'DRAFT',
      body: v3,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      aiMetadata: { history: [{ body: v2 }, { body: v1 }] },
      ...over,
    }) as never;

  it('a draft approved before versions existed has its current content marked approved', () => {
    expect(contentLog(draft({ status: 'APPROVED' })).approved).toMatchObject({
      n: 3,
      by: null,
    });
    expect(contentLog(draft()).approved).toBeNull();
  });

  it('a new version is written into the metadata being saved, keeping the rest', () => {
    const meta = withContentVersion(
      draft(),
      { quality: { ok: true } },
      { body: { caption: 'v4' }, source: 'edited', by: 'u' },
    ) as unknown as { quality: unknown; versions: VersionLog };
    expect(meta.quality).toEqual({ ok: true });
    expect(meta.versions.current).toBe(4);
  });

  it('an undo is linked to the version it went back to', () => {
    expect(versionMatching(draft(), v2, bodyFingerprint)).toBe(2);
  });

  it('outreach messages keep versions too, rebuilt from their history', () => {
    const log = messageLog({
      status: 'APPROVED',
      draftText: 'Hi Priya!',
      createdAt: new Date(),
      aiMetadata: { history: [{ text: 'Hi Priya' }] },
    } as never);
    expect(log.versions.map((v) => v.body)).toEqual(['Hi Priya', 'Hi Priya!']);
    expect(log.approved?.n).toBe(2);
  });
});
