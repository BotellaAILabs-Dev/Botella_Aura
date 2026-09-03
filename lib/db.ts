import { PrismaClient } from '@prisma/client';

/**
 * Prisma client singleton.
 * In dev, Next.js hot-reload would otherwise create a new client on every
 * reload and exhaust the connection pool, so we cache it on globalThis.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Query logging is OPT-IN, even in development.
 *
 * It used to be on by default, which meant every page render wrote a line per
 * query to stdout — a dashboard page issuing half a dozen queries paid for six
 * synchronous console writes on top of the work itself, and the useful output
 * (errors, warnings) was buried in the noise.
 *
 * Set PRISMA_LOG_QUERIES=1 when you actually want to see the SQL.
 */
const logLevels: Array<'query' | 'error' | 'warn'> =
  process.env.PRISMA_LOG_QUERIES === '1'
    ? ['query', 'error', 'warn']
    : process.env.NODE_ENV === 'development'
      ? ['error', 'warn']
      : ['error'];

export const db =
  globalForPrisma.prisma ?? new PrismaClient({ log: logLevels });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db;
}
