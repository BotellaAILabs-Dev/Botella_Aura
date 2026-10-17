import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { accountKey, type DiscoveredAccount } from '@/lib/connection-manager';

/**
 * Store the accounts/pages/profiles a connection reaches (ids and names only —
 * never a token). Accounts the provider no longer reports are removed, so the
 * list is always what the credential can reach now. A person's earlier choice
 * is kept when the account is still there (`keepSelection`).
 */
export async function recordDiscoveredAccounts(args: {
  connectionId: string;
  companyId: string;
  accounts: DiscoveredAccount[];
  keepSelection?: boolean;
}): Promise<void> {
  const { connectionId, companyId, accounts } = args;
  const existing = await db.connectedAccount.findMany({ where: { connectionId }, select: { id: true, kind: true, externalId: true, selected: true } });
  const wasSelected = new Set(existing.filter((a) => a.selected).map(accountKey));
  const anySelectedBefore = args.keepSelection && accounts.some((a) => a.selectable && wasSelected.has(accountKey(a)));
  const now = new Date();
  const idByKey = new Map<string, string>();

  // Parents first, so children can point at them.
  const ordered = [...accounts].sort((a, b) => Number(Boolean(a.parentKey)) - Number(Boolean(b.parentKey)));
  for (const a of ordered) {
    const key = accountKey(a);
    const selected = anySelectedBefore && a.selectable ? wasSelected.has(key) : Boolean(a.selected);
    const parentId = a.parentKey ? (idByKey.get(a.parentKey) ?? null) : null;
    const data = {
      name: a.name.slice(0, 200),
      channel: a.channel ?? null,
      selectable: Boolean(a.selectable),
      selected,
      parentId,
      lastSeenAt: now,
      metadata: (a.metadata ?? {}) as Prisma.InputJsonObject,
    };
    const row = await db.connectedAccount.upsert({
      where: { connectionId_kind_externalId: { connectionId, kind: a.kind, externalId: a.externalId } },
      create: { connectionId, companyId, kind: a.kind, externalId: a.externalId, ...data },
      update: data,
      select: { id: true },
    });
    idByKey.set(key, row.id);
  }
  // Children of a selected selectable account follow it (Page → its Instagram).
  if (anySelectedBefore) {
    for (const a of accounts.filter((x) => x.parentKey && !x.selectable)) {
      const parentSelected = wasSelected.has(a.parentKey!);
      await db.connectedAccount.updateMany({ where: { connectionId, kind: a.kind, externalId: a.externalId }, data: { selected: parentSelected } });
    }
  }
  const seen = new Set(accounts.map(accountKey));
  const gone = existing.filter((a) => !seen.has(accountKey(a))).map((a) => a.id);
  if (gone.length) await db.connectedAccount.deleteMany({ where: { id: { in: gone } } });
}

/** Mark one selectable account (and its children) as the one Aura uses. */
export async function selectDiscoveredAccount(connectionId: string, accountId: string): Promise<void> {
  const all = await db.connectedAccount.findMany({ where: { connectionId }, select: { id: true, parentId: true, selectable: true } });
  const chosen = new Set([accountId, ...all.filter((a) => a.parentId === accountId).map((a) => a.id)]);
  const parents = new Set(all.filter((a) => !a.selectable && !a.parentId).map((a) => a.id));
  await db.$transaction(
    all.map((a) =>
      db.connectedAccount.update({
        where: { id: a.id },
        data: { selected: chosen.has(a.id) || parents.has(a.id) },
      }),
    ),
  );
}
