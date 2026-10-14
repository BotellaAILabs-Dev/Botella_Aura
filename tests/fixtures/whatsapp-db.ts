import { Prisma } from '@prisma/client';

/**
 * An in-memory stand-in for the Prisma client, covering exactly the models
 * and operations the WhatsApp Assistant uses. Unique keys are enforced as
 * Postgres enforces them (P2002), so the deduplication and single-use logic
 * is really exercised. Use it with:
 *
 *   vi.mock('@/lib/db', async () => ({ db: (await import('./fixtures/whatsapp-db')).db }));
 */

type Row = Record<string, any>;

export const store = {
  conversations: [] as any[],
  messages: [] as any[],
  jobs: [] as any[],
  challenges: [] as any[],
  links: [] as any[],
  users: [] as any[],
  companies: [] as any[],
  members: [] as any[],
  audits: [] as any[],
  seq: 0,
};

export function resetStore() {
  for (const k of Object.keys(store) as (keyof typeof store)[]) {
    if (Array.isArray(store[k])) (store[k] as Row[]).length = 0;
  }
}

const unique = (field: string) =>
  new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on ${field}`, {
    code: 'P2002',
    clientVersion: 'test',
  });

const same = (a: any, b: any) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

export function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      // The one relation filter used: a conversation with no account link.
      if (k === 'link' && 'is' in v && v.is === null) return !store.links.some((l) => l.conversationId === row.id);
      if ('in' in v) return v.in.includes(row[k]);
      if ('lte' in v) return row[k] != null && row[k] <= v.lte;
      if ('lt' in v) return row[k] != null && row[k] < v.lt;
      if ('gt' in v) return row[k] != null && row[k] > v.gt;
    }
    return same(row[k], v);
  });
}

// Strictly increasing timestamps, so "oldest first" is always well defined.
const stamp = () => new Date(Date.now() + ++store.seq);

function sorted(rows: Row[], orderBy?: Row) {
  const [[field, dir] = ['createdAt', 'asc']] = Object.entries(orderBy ?? {});
  return [...rows].sort((a, b) => (a[field] - b[field]) * (dir === 'desc' ? -1 : 1));
}

function table(opts: {
  rows: () => Row[];
  prefix: string;
  defaults: () => Row;
  uniques: string[];
  relations?: Record<string, (row: Row) => Row | null>;
}) {
  const withIncludes = (row: Row | undefined, include?: Row) => {
    if (!row) return null;
    const out: Row = { ...row };
    for (const [name, spec] of Object.entries(include ?? {})) {
      if (!spec || !opts.relations?.[name]) continue;
      const rel = opts.relations[name]!(row);
      out[name] = rel ? { ...rel } : null;
    }
    return out;
  };
  const find = (where: Row) => opts.rows().find((r) => matches(r, where));
  const assertUnique = (data: Row, self?: Row) => {
    for (const f of opts.uniques) {
      if (data[f] != null && opts.rows().some((r) => r !== self && r[f] === data[f])) throw unique(f);
    }
  };
  return {
    findUnique: async ({ where, include }: Row) => withIncludes(find(where), include),
    findUniqueOrThrow: async ({ where, include }: Row) => {
      const r = find(where);
      if (!r) throw new Error('not found');
      return withIncludes(r, include);
    },
    findFirst: async ({ where, orderBy, include }: Row) =>
      withIncludes(sorted(opts.rows().filter((r) => matches(r, where)), orderBy)[0], include),
    findMany: async ({ where, orderBy, take, include }: Row = {}) =>
      sorted(opts.rows().filter((r) => matches(r, where)), orderBy)
        .slice(0, take ?? Infinity)
        .map((r) => withIncludes(r, include)),
    count: async ({ where }: Row = {}) => opts.rows().filter((r) => matches(r, where)).length,
    create: async ({ data }: Row) => {
      assertUnique(data);
      const row = { id: `${opts.prefix}_${++store.seq}`, ...opts.defaults(), createdAt: stamp(), updatedAt: stamp(), ...data };
      opts.rows().push(row);
      return { ...row };
    },
    update: async ({ where, data }: Row) => {
      const r = find(where);
      if (!r) throw new Error('not found');
      assertUnique(data, r);
      Object.assign(r, data, { updatedAt: stamp() });
      return { ...r };
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = opts.rows().filter((r) => matches(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: Row = {}) => {
      const keep = opts.rows().filter((r) => !matches(r, where));
      const count = opts.rows().length - keep.length;
      opts.rows().length = 0;
      opts.rows().push(...keep);
      return { count };
    },
  };
}

const byId = (rows: () => Row[], key: string) => (row: Row) => rows().find((r) => r.id === row[key]) ?? null;

const conversations = table({
  rows: () => store.conversations,
  prefix: 'conv',
  uniques: ['waIdHash'],
  defaults: () => ({ profileName: null, lastInboundAt: null, optedOut: false, optedOutAt: null, leaseUntil: null }),
});

const messages = table({
  rows: () => store.messages,
  prefix: 'msg',
  uniques: ['wamid'],
  defaults: () => ({
    wamid: null, body: null, payload: null, replyToId: null, attempts: 0, nextAttemptAt: null,
    errorCode: null, errorMessage: null, sentAt: null, deliveredAt: null, readAt: null, failedAt: null,
  }),
  relations: { conversation: byId(() => store.conversations, 'conversationId') },
});
// The send-retry sweep orders by nextAttemptAt.
const findDueMessages = messages.findMany;
messages.findMany = async (args: Row = {}) => findDueMessages({ ...args, orderBy: args.orderBy ?? { nextAttemptAt: 'asc' } });

export const db: Row = {
  whatsAppConversation: conversations,
  whatsAppMessage: messages,
  whatsAppJob: table({
    rows: () => store.jobs,
    prefix: 'job',
    uniques: ['messageId'],
    defaults: () => ({ status: 'QUEUED', attempts: 0, runAfter: new Date(), startedAt: null, finishedAt: null, lastError: null }),
  }),
  whatsAppLinkChallenge: table({
    rows: () => store.challenges,
    prefix: 'chal',
    uniques: ['tokenHash'],
    defaults: () => ({ status: 'ISSUED', userId: null, codeHash: null, codeAttempts: 0, confirmedAt: null, completedAt: null }),
    relations: { conversation: byId(() => store.conversations, 'conversationId') },
  }),
  whatsAppAccountLink: table({
    rows: () => store.links,
    prefix: 'link',
    uniques: ['conversationId'],
    defaults: () => ({ activeCompanyId: null, linkedAt: new Date(), lastUsedAt: new Date(), revokedAt: null, revokedReason: null }),
    relations: {
      user: byId(() => store.users, 'userId'),
      conversation: byId(() => store.conversations, 'conversationId'),
    },
  }),
  user: table({ rows: () => store.users, prefix: 'user', uniques: ['email'], defaults: () => ({ name: null }) }),
  company: table({ rows: () => store.companies, prefix: 'co', uniques: [], defaults: () => ({ logoUrl: null }) }),
  companyMember: {
    findUnique: async ({ where }: Row) => {
      const k = where.userId_companyId;
      return store.members.find((m) => m.userId === k.userId && m.companyId === k.companyId) ?? null;
    },
    findMany: async ({ where }: Row) =>
      sorted(store.members.filter((m) => m.userId === where.userId)).map((m) => ({
        role: m.role,
        company: store.companies.find((c) => c.id === m.companyId),
      })),
  },
  auditLog: {
    create: async ({ data }: Row) => {
      store.audits.push(data);
      return data;
    },
  },
};
db.$transaction = async (fn: (tx: Row) => unknown) => fn(db);

/** A user with memberships, for the linking tests. */
export function seedUser(email: string, memberships: { company: string; role: string }[]) {
  const user = { id: `user_${++store.seq}`, email, name: null, createdAt: stamp() };
  store.users.push(user);
  const companies = memberships.map(({ company, role }) => {
    let c = store.companies.find((x) => x.name === company);
    if (!c) {
      c = { id: `co_${++store.seq}`, name: company, slug: company.toLowerCase(), logoUrl: null, createdAt: stamp() };
      store.companies.push(c);
    }
    store.members.push({ userId: user.id, companyId: c.id, role, createdAt: stamp() });
    return c;
  });
  return { user, companies };
}
