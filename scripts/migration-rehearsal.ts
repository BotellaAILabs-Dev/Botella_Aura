/**
 * Migration rehearsal — applies pending migrations to a THROWAWAY copy of the
 * schema with production-shaped data, and checks that existing data is
 * untouched and the backfills are right. Never touches the database in
 * DATABASE_URL: it creates (and always drops) its own scratch database on the
 * same LOCAL server.
 *
 *   pnpm db:rehearse                       the four migrations of 16–21 Oct 2026
 *   pnpm db:rehearse --inspect             only print the columns the seed must fill
 *
 * Refuses to run unless the database host is local.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';

const PENDING = [
  '20261016090000_campaign_creation_context',
  '20261016100000_execution_handoff',
  '20261017090000_connection_manager',
  '20261021090000_execution_engine',
];

function loadDotEnv() {
  for (const file of ['.env', '.env.local']) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue;
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"(.*)"$/, '$1');
    }
  }
}

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) console.log(`  ok      ${label}`);
  else {
    failures++;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/** Run prisma with a given database; output is shown with any URL removed. */
function prisma(args: string[], url: string, schema: string | null): { code: number; out: string } {
  const r = spawnSync('npx', ['prisma', ...args, ...(schema ? ['--schema', schema] : [])], {
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.split(url).join('[url]');
  return { code: r.status ?? 1, out };
}

async function main() {
  loadDotEnv();
  const base = new URL(process.env.DIRECT_URL || process.env.DATABASE_URL || '');
  if (!/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(base.hostname)) {
    console.error(`Refusing: the database host is not local (${base.hostname}). This rehearsal only runs on a local server.`);
    process.exit(1);
  }
  const name = `aura_migration_rehearsal_${Date.now()}`;
  const scratch = new URL(base.toString());
  scratch.pathname = `/${name}`;
  scratch.searchParams.delete('schema');
  const admin = new URL(base.toString());
  admin.pathname = '/postgres';
  admin.search = '';

  const adminDb = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
  await adminDb.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  console.log(`Scratch database created (${name}) on the local server.`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-rehearsal-'));
  const schemaPath = path.join(tmp, 'schema.prisma');
  fs.copyFileSync(path.join('prisma', 'schema.prisma'), schemaPath);
  const migDir = path.join(tmp, 'migrations');
  fs.mkdirSync(migDir);
  const all = fs.readdirSync(path.join('prisma', 'migrations')).filter((d) => fs.statSync(path.join('prisma', 'migrations', d)).isDirectory()).sort();
  const copy = (d: string) => fs.cpSync(path.join('prisma', 'migrations', d), path.join(migDir, d), { recursive: true });
  fs.copyFileSync(path.join('prisma', 'migrations', 'migration_lock.toml'), path.join(migDir, 'migration_lock.toml'));
  all.filter((d) => !PENDING.includes(d)).forEach(copy);

  const db = new PrismaClient({ datasources: { db: { url: scratch.toString() } } });
  try {
    console.log(`\n1. Production as it is now: ${all.length - PENDING.length} migrations, up to ${all.filter((d) => !PENDING.includes(d)).at(-1)}`);
    const before = prisma(['migrate', 'deploy'], scratch.toString(), schemaPath);
    check('the existing migrations apply to an empty database', before.code === 0, before.out.slice(-400));

    if (process.argv.includes('--inspect')) {
      const cols = await db.$queryRawUnsafe<{ table_name: string; column_name: string; data_type: string }[]>(
        `SELECT table_name, column_name, udt_name AS data_type FROM information_schema.columns
         WHERE table_schema='public' AND is_nullable='NO' AND column_default IS NULL
           AND table_name IN ('Company','User','CompanyMember','ContentDraft','Connection','LinkedInConnection','ContentPublication','Campaign')
         ORDER BY table_name, ordinal_position`,
      );
      for (const c of cols) console.log(`  ${c.table_name}.${c.column_name} (${c.data_type})`);
      return;
    }

    console.log('\n2. Production-shaped data');
    await seed(db);
    const snapshot = await originalData(db);
    console.log(`  seeded: ${snapshot.counts}`);

    console.log('\n3. The four pending migrations');
    PENDING.forEach(copy);
    const t0 = Date.now();
    const run = prisma(['migrate', 'deploy'], scratch.toString(), schemaPath);
    const ms = Date.now() - t0;
    check(`all four apply in order (${ms} ms including Prisma start-up)`, run.code === 0 && PENDING.every((m) => run.out.includes(m)), run.out.slice(-600));
    const again = prisma(['migrate', 'deploy'], scratch.toString(), schemaPath);
    check('running deploy again is a no-op (nothing pending)', again.code === 0 && /No pending migrations/i.test(again.out), again.out.slice(-300));
    const drift = prisma(['migrate', 'diff', '--from-schema-datasource', schemaPath, '--to-schema-datamodel', schemaPath, '--exit-code'], scratch.toString(), null);
    check('the migrated database matches schema.prisma exactly (no drift)', drift.code === 0, drift.out.slice(-300));

    console.log('\n4. Existing data');
    const after = await originalData(db);
    check('every pre-existing row and column is unchanged (fingerprint of all original columns)', after.hash === snapshot.hash, `${snapshot.counts} → ${after.counts}`);

    const conns = await db.$queryRawUnsafe<Record<string, any>[]>(`SELECT "connectorId", status::text, provider, channels, scopes, "credentialRef", "setupStage"::text AS stage, health::text, "confirmedAt" IS NOT NULL AS confirmed, "accessTokenEnc" FROM "Connection" ORDER BY "connectorId"`);
    const by = Object.fromEntries(conns.map((c) => [c.connectorId, c]));
    check('existing connections stay usable: confirmed, not blocked', ['meta', 'ga4'].every((k) => by[k]?.stage === 'CONFIRMED' && by[k]?.confirmed && by[k]?.health === 'CONNECTED'), JSON.stringify(conns.map((c) => [c.connectorId, c.stage, c.health])));
    check('provider, channels and granted scopes filled in', by.meta?.provider === 'meta' && by.meta?.channels?.join() === 'FACEBOOK,INSTAGRAM' && by.meta?.scopes?.includes('pages_manage_posts') && by.ga4?.provider === 'google');
    check('an expired connection is marked Expired', by.hubspot?.health === 'EXPIRED');
    check('LinkedIn gets its Connection Manager record — without its token', by.linkedin?.credentialRef === 'linkedin_connection' && by.linkedin?.accessTokenEnc === null && by.linkedin?.stage === 'CONFIRMED');

    const ex = await db.$queryRawUnsafe<Record<string, any>[]>(`SELECT e."contentDraftId", e.platform::text, e.status::text, e.url FROM "Execution" e ORDER BY e."contentDraftId"`);
    const exBy = Object.fromEntries(ex.map((e) => [`${e.contentDraftId}:${e.platform}`, e]));
    check('a published post → its execution is Completed, with the link', exBy['d_published:LINKEDIN']?.status === 'COMPLETED' && Boolean(exBy['d_published:LINKEDIN']?.url));
    check('an approved, scheduled post → Scheduled', exBy['d_scheduled:FACEBOOK']?.status === 'SCHEDULED');
    check('an approved post without a time → Ready for execution', exBy['d_ready:LINKEDIN']?.status === 'READY_FOR_EXECUTION');
    check('a failed publication → Failed (its error kept on the publication)', exBy['d_failed:INSTAGRAM']?.status === 'FAILED');
    check('drafts not approved get no execution', !ex.some((e) => e.contentDraftId === 'd_draft'));
    const events = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "ExecutionEvent"`);
    check('every backfilled execution has its first recorded event', Number(events[0]!.n) === ex.length);
    const tz = await db.$queryRawUnsafe<{ timezone: string }[]>(`SELECT timezone FROM "Company"`);
    check('workspaces get the UTC timezone (scheduled instants unchanged)', tz.every((t) => t.timezone === 'UTC'));
  } finally {
    await db.$disconnect();
    await adminDb.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await adminDb.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n  ok      scratch database dropped (${name})`);
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nMigration rehearsal passed.');
  process.exit(failures ? 1 : 0);
}

/** A fingerprint of every pre-existing row, on its original columns only. */
async function originalData(db: PrismaClient) {
  const queries: Record<string, string> = {
    Company: `SELECT id, name, slug, "createdAt" FROM "Company" ORDER BY id`,
    ContentDraft: `SELECT id, status::text, platform::text, title, body::text, "scheduledFor", "publishedAt", "aiMetadata"::text FROM "ContentDraft" ORDER BY id`,
    Connection: `SELECT id, "connectorId", kind::text, status::text, "accountLabel", scope, "accessTokenEnc", "refreshTokenEnc", "expiresAt", metadata::text, "errorMessage" FROM "Connection" WHERE "connectorId" <> 'linkedin' ORDER BY id`,
    LinkedInConnection: `SELECT id, status::text, "accessTokenEnc", scope, "expiresAt" FROM "LinkedInConnection" ORDER BY id`,
    ContentPublication: `SELECT id, status::text, url, message, attempts FROM "ContentPublication" ORDER BY id`,
    Campaign: `SELECT id, name, status::text FROM "Campaign" ORDER BY id`,
  };
  const hash = crypto.createHash('sha256');
  const counts: string[] = [];
  for (const [t, q] of Object.entries(queries)) {
    const rows = await db.$queryRawUnsafe<unknown[]>(q);
    hash.update(t + JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    counts.push(`${t} ${rows.length}`);
  }
  return { hash: hash.digest('hex'), counts: counts.join(', ') };
}

async function seed(db: PrismaClient) {
  const now = `now()`;
  const sql = [
    `INSERT INTO "User" (id, email, "updatedAt") VALUES ('u1', 'owner@example.test', ${now})`,
    `INSERT INTO "Company" (id, name, slug, "updatedAt") VALUES ('c1', 'Prod-like Bakery', 'prod-like-bakery', ${now})`,
    `INSERT INTO "CompanyMember" (id, "userId", "companyId", role) VALUES ('m1', 'u1', 'c1', 'OWNER')`,
    `INSERT INTO "Campaign" (id, "companyId", name, goal, status, "updatedAt") VALUES ('camp1', 'c1', 'Autumn', 'Grow', 'ACTIVE', ${now})`,
    // Connections as production has them: Meta (scope string), GA4, an expired HubSpot.
    `INSERT INTO "Connection" (id, "companyId", "connectorId", kind, status, "accountLabel", scope, "accessTokenEnc", metadata, "updatedAt")
       VALUES ('k_meta', 'c1', 'meta', 'OAUTH', 'CONNECTED', '@bakery (Bakery)', 'pages_show_list pages_read_engagement pages_manage_posts instagram_basic instagram_content_publish business_management', 'cipher-meta', '{"pageId":"111","igUserId":"222"}', ${now}),
              ('k_ga4', 'c1', 'ga4', 'OAUTH', 'CONNECTED', 'Site', 'https://www.googleapis.com/auth/analytics.readonly', 'cipher-ga4', '{}', ${now}),
              ('k_hub', 'c1', 'hubspot', 'OAUTH', 'EXPIRED', 'Portal', 'oauth', 'cipher-hub', '{}', ${now})`,
    `INSERT INTO "LinkedInConnection" (id, "companyId", "linkedInUserId", "displayName", "accessTokenEnc", scope, status, "connectedAt", "updatedAt")
       VALUES ('li1', 'c1', 'member1', 'Dana', 'cipher-li', 'openid profile email w_member_social', 'ACTIVE', ${now}, ${now})`,
    // Drafts: published, approved+scheduled, approved (no time), failed publication, plain draft.
    `INSERT INTO "ContentDraft" (id, "companyId", type, status, platform, title, body, "scheduledFor", "publishedAt", "updatedAt") VALUES
       ('d_published', 'c1', 'LINKEDIN_POST', 'PUBLISHED', 'LINKEDIN', 'Published', '{"hook":"a"}', NULL, ${now}, ${now}),
       ('d_scheduled', 'c1', 'IMAGE_POST', 'APPROVED', 'FACEBOOK', 'Scheduled', '{"hook":"b"}', now() + interval '3 days', NULL, ${now}),
       ('d_ready', 'c1', 'LINKEDIN_POST', 'APPROVED', 'LINKEDIN', 'Ready', '{"hook":"c"}', NULL, NULL, ${now}),
       ('d_failed', 'c1', 'IMAGE_POST', 'APPROVED', 'INSTAGRAM', 'Failed', '{"hook":"d"}', NULL, NULL, ${now}),
       ('d_draft', 'c1', 'LINKEDIN_POST', 'DRAFT', 'LINKEDIN', 'Draft', '{"hook":"e"}', NULL, NULL, ${now})`,
    `INSERT INTO "ContentPublication" (id, "companyId", "contentDraftId", platform, status, "contentHash", attempts, url, "publishedAt", message, "updatedAt") VALUES
       ('p_pub', 'c1', 'd_published', 'LINKEDIN', 'PUBLISHED', 'h1', 1, 'https://www.linkedin.com/feed/update/1', ${now}, NULL, ${now}),
       ('p_fail', 'c1', 'd_failed', 'INSTAGRAM', 'FAILED', 'h2', 1, NULL, NULL, 'Instagram could not publish this post (HTTP 500).', ${now})`,
  ];
  for (const q of sql) await db.$executeRawUnsafe(q);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message.split(process.env.DATABASE_URL ?? '\u0000').join('[url]') : err);
  process.exit(1);
});
