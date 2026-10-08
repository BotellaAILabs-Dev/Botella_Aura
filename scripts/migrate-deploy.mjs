#!/usr/bin/env node
/**
 * `prisma migrate deploy`, with retries and an explicit escape hatch.
 *
 * WHY THIS EXISTS
 * ---------------
 * The build used to run `prisma migrate deploy && next build`, which makes
 * every deployment depend on the database being reachable from the build
 * runner at that exact moment. When it is not, the whole deploy dies before
 * Next.js compiles a single file — so a CSS fix cannot ship because a database
 * was briefly unreachable, and the hosted site silently keeps serving a
 * month-old build while every new deployment goes red.
 *
 * Two distinct failures were being treated identically:
 *
 *   - A CONNECTION failure (P1001). Says nothing about the migrations. Often
 *     transient: a Neon compute cold-starting, a network blip. Worth retrying.
 *   - A MIGRATION failure. The SQL is wrong, or the database has drifted.
 *     Retrying cannot help, and shipping past it would deploy code against a
 *     schema it does not match.
 *
 * So: connection failures retry with backoff. Migration failures fail the
 * build immediately, exactly as before.
 *
 * THE ESCAPE HATCH
 * ----------------
 * Set ALLOW_DEPLOY_WITHOUT_MIGRATIONS=1 to downgrade an unreachable database
 * from "fail the build" to "warn loudly and continue". This is deliberately
 * opt-in and deliberately not the default, because it ships code whose schema
 * has not been applied.
 *
 * It is for one situation: the database is unreachable from the BUILD network
 * but fine from the RUNTIME network — which is possible, because Vercel builds
 * and Vercel functions run on different infrastructure, and an IP allowlist
 * can admit one and not the other. In that case the migrations still have to
 * be run, by hand, from somewhere that can reach the database:
 *
 *     pnpm db:migrate:deploy
 *
 * If you set this flag and forget that step, the app will deploy and then
 * throw at runtime on any table the pending migrations were meant to create.
 * That is a worse failure than a red build, so leave it unset unless you are
 * actively working around a network restriction.
 */
import { spawn } from 'node:child_process';

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2000;

/** Prisma's connection-failure codes. Everything else is a real migration error. */
const CONNECTION_ERROR_CODES = ['P1001', 'P1002', 'P1017'];

const allowSkip = process.env.ALLOW_DEPLOY_WITHOUT_MIGRATIONS === '1';

function runMigrate() {
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['prisma', 'migrate', 'deploy'],
      { shell: true, env: process.env },
    );

    let output = '';
    const capture = (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

function isConnectionFailure(output) {
  return CONNECTION_ERROR_CODES.some((code) => output.includes(code));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { code, output } = await runMigrate();

    if (code === 0) {
      if (attempt > 1) console.log(`\nmigrate: succeeded on attempt ${attempt}.`);
      return;
    }

    // A real migration error. Retrying runs the same SQL against the same
    // database and fails the same way, so stop now and say so.
    if (!isConnectionFailure(output)) {
      console.error(
        '\nmigrate: the migrations themselves failed — this is not a ' +
          'connectivity problem, and the build must not continue past it.',
      );
      process.exit(code);
    }

    if (attempt < MAX_ATTEMPTS) {
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `\nmigrate: cannot reach the database (attempt ${attempt}/${MAX_ATTEMPTS}). ` +
          `Retrying in ${delay / 1000}s — a suspended compute may still be waking.`,
      );
      await sleep(delay);
    }
  }

  // Out of attempts, and every failure was a connection failure.
  if (allowSkip) {
    console.warn(
      '\n' +
        '='.repeat(72) +
        '\nmigrate: DATABASE UNREACHABLE — CONTINUING WITHOUT MIGRATING.\n' +
        '='.repeat(72) +
        '\nALLOW_DEPLOY_WITHOUT_MIGRATIONS=1 is set, so the build continues.\n' +
        'The schema has NOT been applied. Any pending migration is still\n' +
        'pending, and code that expects it will throw at runtime.\n\n' +
        'Run this from somewhere that can reach the database:\n' +
        '    pnpm db:migrate:deploy\n' +
        '='.repeat(72) +
        '\n',
    );
    return;
  }

  console.error(
    '\nmigrate: could not reach the database after ' +
      `${MAX_ATTEMPTS} attempts.\n\n` +
      'This is a NETWORK problem, not a schema problem. The usual causes:\n' +
      '  - an IP allowlist on the database that excludes the build runner\n' +
      '  - a connection string missing sslmode=require\n' +
      '  - quotes or a trailing newline pasted into the env var value\n\n' +
      'To ship the build anyway and migrate separately, set\n' +
      'ALLOW_DEPLOY_WITHOUT_MIGRATIONS=1 — read scripts/migrate-deploy.mjs\n' +
      'first, because it has consequences.\n',
  );
  process.exit(1);
}

main().catch((err) => {
  console.error('migrate: unexpected failure', err);
  process.exit(1);
});
