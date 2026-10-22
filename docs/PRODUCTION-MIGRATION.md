# Production migration: 16–21 October 2026

These four migrations take production from `20261015090000_instagram_carousel_reels` to the current schema:

| # | Migration | What it does |
| --- | --- | --- |
| 1 | `20261016090000_campaign_creation_context` | `Campaign`: 2 nullable columns (`recommendationId`, `creationContext`) + 1 index |
| 2 | `20261016100000_execution_handoff` | New enum `ExecutionHandoffStatus`, new table `ExecutionHandoff`; 2 values added to `AuditAction` |
| 3 | `20261017090000_connection_manager` | New enums `ConnectionHealth`, `ConnectionSetupStage`; 17 columns added to `Connection` (all nullable or with a default); new table `ConnectedAccount`; 5 values added to `AuditAction`, 1 to `ConnectionStatus`. **Backfill:** fills the new `Connection` columns, and adds a LinkedIn `Connection` record for each `LinkedInConnection` (no token copied; `ON CONFLICT DO NOTHING`). |
| 4 | `20261021090000_execution_engine` | New enum `ExecutionStatus`, new tables `Execution`, `ExecutionEvent`; `Company.timezone` (default `'UTC'`); 3 values added to `AuditAction`, 1 to `PerformanceSource`. **Backfill:** one `Execution` per existing publication and per approved draft, plus a first event each (`ON CONFLICT DO NOTHING`). |

They must run in this order: each builds on the previous one, and their timestamps order them that way.

## Readiness

**Ready, verified locally. Not yet verified against production**, because there is no production access from here.

| Check | Result |
| --- | --- |
| `prisma validate` | Valid |
| `prisma migrate status` (local database, PostgreSQL 18.6) | 49 migrations, up to date |
| Local database vs `schema.prisma` (`migrate diff --exit-code`) | Identical |
| **Rehearsal** (`pnpm db:rehearse`) | All checks pass; see below |
| Unit tests / end-to-end suites against the migrated schema | 1,961 pass / 16 of 16 Content Studio suites (22 Oct); 14 of 14 regression suites (21 Oct) |

**What the rehearsal does** (scratch database, dropped afterwards):

1. Builds the schema exactly as production has it, from the 45 earlier migrations.
2. Loads production-shaped data:
   - Meta, GA4 and an expired HubSpot connection
   - LinkedIn
   - published, scheduled, approved, failed and draft posts
   - a campaign
3. Applies the four migrations.
4. Checks:
   - all four apply in order, and a second run is a no-op
   - the result matches `schema.prisma`
   - **every pre-existing row and column is unchanged** (a fingerprint of all original columns)
   - existing connections stay confirmed and usable
   - LinkedIn gets its record without the token
   - existing posts get the right execution state, and drafts that aren't approved get none

## Destructive changes and data loss

**None.**

- There is no `DROP`, `RENAME`, `DELETE`, `TRUNCATE` or column type change.
- No existing column is altered or made `NOT NULL`. Every new required column has a constant default.
- The `UPDATE`s write only to the **new** columns of `Connection`.
- The `INSERT`s add rows to new tables, plus LinkedIn's `Connection` record. All use `ON CONFLICT DO NOTHING`.

**Locks and duration**

- Adding columns with constant defaults is a metadata-only change on PostgreSQL 11+ (no table rewrite).
- The `Campaign` index is created without `CONCURRENTLY`, so writes to `Campaign` pause briefly. The table is small.
- The backfills grow with the number of connections, publications and approved posts. Expect seconds; the rehearsal took under 3 s including Prisma's start-up.

## Risks

1. **Production may already be migrated, without anyone running a command.**
   - The Vercel build is `pnpm run vercel-build`, which runs `scripts/migrate-deploy.mjs` (`prisma migrate deploy`) **before** `next build`.
   - The commits containing these migrations (`6672bf3`, `73b0ad3`, `a68c4c8`) were pushed to `main`. If the repository is connected to Vercel, those production builds have already applied them. A failed build would show in Vercel as a red deployment, with the migration error in its build log.
   - **Check first (step 1) before doing anything.**
2. **Preview builds also run migrations.**
   - If Preview uses the **same** `DATABASE_URL` as Production, any preview deployment migrates the production database.
   - Give Preview its own database, for example a Neon branch.
3. **PostgreSQL 12 or newer is required.** Migrations 2–4 add enum values (`ALTER TYPE … ADD VALUE`) inside the migration. They were verified on PostgreSQL 18.6; Neon runs 14–17. Check the production version (step 1).
4. **Rolling back the code after migrating needs care.**
   - Once the new code writes new enum values (for example the new audit actions, or the `REVOKED` connection status), an older deployment's Prisma client cannot read those rows.
   - The audit log and connection pages would then error.
   - So after migrating: **roll forward** (fix and redeploy). Don't redeploy a build older than `a68c4c8` against the migrated database.
5. **Application compatibility.** The current code needs all four migrations; it reads `Execution`, `Connection.health`, `Company.timezone` and so on. Code and schema have to go out together. `vercel-build` guarantees that by migrating before building.

## Procedure

Run from a trusted machine that can reach the production database. Commands are for bash.

### 1. Find out where production stands (read-only)

Set the production connection strings in your shell only. Don't put them in a file or in chat. Use the **direct** (non-pooled) URL for `DIRECT_URL`:

```bash
export DATABASE_URL='<production pooled URL>'
export DIRECT_URL='<production direct URL>'
pnpm prisma migrate status
```

**Reading the result:**

- **"Database schema is up to date"**: all four are already applied, most likely by the Vercel build. Go to step 5 and verify.
- **"Following migrations have not yet been applied"** with these four: continue with step 2.
- **A failed migration:** stop. See the Recovery section.

Also check the server version with `psql "$DIRECT_URL" -c 'SHOW server_version'`. It must be 12 or newer.

### 2. Back up

Take **both** backups.

- **Provider snapshot.** On Neon, create a branch, or note the time for a point-in-time restore. On RDS or Supabase, take a manual snapshot.
- **Logical dump:**

  ```bash
  pg_dump --format=custom --no-owner --no-privileges --file="aura-pre-migration-$(date +%Y%m%d-%H%M).dump" "$DIRECT_URL"
  pg_restore --list aura-pre-migration-*.dump | head   # the dump is readable
  ```

  The dump contains customer data and encrypted tokens. Store it encrypted, outside the repository.

### 3. (Recommended) Rehearse on a copy of production

```bash
createdb aura_prod_copy && pg_restore --no-owner --dbname=aura_prod_copy aura-pre-migration-*.dump
COPY_URL='postgresql://<user>:<password>@localhost:5432/aura_prod_copy'
DATABASE_URL="$COPY_URL" DIRECT_URL="$COPY_URL" pnpm prisma migrate deploy
```

Then start the app against `aura_prod_copy` and open a post, the Publishing page and the Connection Manager.

### 4. Apply

Choose **one** of these:

- **Through the deployment (normal path):** deploy `main` to Production on Vercel. The build runs `prisma migrate deploy` first, and fails without building if a migration fails.
- **By hand** (for example before deploying, or if the build can't reach the database):

  ```bash
  pnpm db:migrate:deploy     # = prisma migrate deploy, using DATABASE_URL / DIRECT_URL from the shell
  ```

Use only `prisma migrate deploy`. **Never** use `prisma migrate dev`, `prisma db push` or `prisma migrate reset` against production: they can drop data or reset the database.

### 5. Verify

```bash
pnpm prisma migrate status      # "Database schema is up to date!"
```

Then:

1. **Deployment log:** check Vercel's runtime log for `environment: configuration` (no `ERROR` lines).
2. **In the app:**
   - Sign in, open a post and the **Publishing** page (`/dashboard/executions`).
   - Open the **Connection Manager** (`/dashboard/connections`): existing connections show as connected.
3. **Data spot-check (read-only):**

   ```sql
   SELECT status, count(*) FROM "Execution" GROUP BY status;
   SELECT "connectorId", health, "setupStage" FROM "Connection";
   ```

### 6. Unset the shell variables

```bash
unset DATABASE_URL DIRECT_URL
```

## Recovery and rollback

Prisma has **no automatic down-migrations**.

- **A migration fails while applying.**
  1. Prisma marks it failed in `_prisma_migrations`, and later deploys refuse to run until it's resolved.
  2. Run `prisma migrate status` and read the error.
  3. Check whether any of its changes landed: `\d "Execution"`, `\d "Connection"` and so on in psql.
  4. If nothing landed, fix the cause (for example the PostgreSQL version), then:

     ```bash
     pnpm prisma migrate resolve --rolled-back <migration_name>
     pnpm db:migrate:deploy
     ```

  5. If it partly landed, restore from the backup (step 2) rather than editing by hand.
- **Something is wrong after migrating, but the data is fine.** Roll forward: fix the code and redeploy. The changes are additive, so the schema itself doesn't need undoing.
- **You must return to the old schema.**
  - Restore the step 2 snapshot or dump into a new database, and point the app at it.
  - **Everything written after the backup is lost.** Do this only for a real failure, and deploy the matching older build at the same time.

## Exact commands

| Purpose | Command |
| --- | --- |
| Status (read-only) | `pnpm prisma migrate status` |
| Apply | `pnpm db:migrate:deploy` (= `prisma migrate deploy`), or deploy to Vercel Production (`vercel-build` runs it) |
| Rehearse locally | `pnpm db:rehearse` |
