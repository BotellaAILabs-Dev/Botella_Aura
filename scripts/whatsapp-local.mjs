/**
 * The WhatsApp assistant, running entirely on this machine.
 *
 * Two modes:
 *
 *   serve   starts the local Meta stand-in and a dev server wired to it
 *   say     sends a message to the assistant and prints what it replies
 *
 * Why this exists: the real WhatsApp demo (`npm run demo:whatsapp`) needs four
 * secrets from the Meta dashboard, a public HTTPS tunnel, and a phone number
 * Meta has approved. None of that is available on a laptop with no Meta
 * account — but the assistant itself can still be shown and tested, because
 * the only part that has to be faked is Meta.
 *
 * `scripts/load/meta-stub.ts` answers on localhost exactly as Meta's Cloud API
 * does, and `scripts/demo-whatsapp-local.ts` plays the phone: it signs an
 * inbound message the way Meta signs one and reads the reply back off the stub.
 * Everything between those two points is the real thing — signature check,
 * queue, worker, router, tools, reply.
 *
 * The WhatsApp values below are throwaway local strings. They are safe because
 * WHATSAPP_GRAPH_BASE_URL only accepts a localhost address
 * (server/whatsapp/client.ts enforces it), so nothing can reach Meta even by
 * mistake.
 *
 *   npm run whatsapp:local serve
 *   npm run whatsapp:local say "write a linkedin post about our new release"
 *   npm run whatsapp:local script          (the scripted demo conversation)
 */
import { spawn, spawnSync } from 'node:child_process';

try {
  process.loadEnvFile();
} catch {
  // .env is optional — the checks below report what is missing.
}

const PORT = process.env.WA_LOCAL_PORT ?? '3001';
const STUB_PORT = process.env.STUB_PORT ?? '4010';
const APP = `http://localhost:${PORT}`;
const STUB = `http://localhost:${STUB_PORT}`;

/**
 * Prisma opens num_cpus*2+1 connections per client by default, which is ~48
 * here. Two dev servers and a script will exhaust a 100-connection local
 * Postgres, and the first thing that breaks is /api/auth/csrf — i.e. it looks
 * like login is broken rather than like a database problem.
 */
function boundedDatabaseUrl(limit) {
  if (!process.env.DATABASE_URL) return undefined;
  const u = new URL(process.env.DATABASE_URL);
  u.searchParams.set('connection_limit', String(limit));
  u.searchParams.set('pool_timeout', '30');
  return u.toString();
}

function envFor(poolLimit) {
  const db = boundedDatabaseUrl(poolLimit);
  return {
    ...process.env,
    ...(db ? { DATABASE_URL: db } : {}),
    // Throwaway, local-only. The real demo uses Meta's own values.
    WHATSAPP_ACCESS_TOKEN: 'local-stub-token',
    WHATSAPP_PHONE_NUMBER_ID: '100000000000001',
    WHATSAPP_APP_SECRET: 'local-stub-app-secret',
    WHATSAPP_VERIFY_TOKEN: 'local-stub-verify-token',
    WHATSAPP_GRAPH_BASE_URL: STUB,
    DEMO_APP_URL: APP,
    STUB_URL: STUB,
  };
}

const mode = process.argv[2] ?? 'serve';

if (mode === 'serve') {
  console.log(`\nStarting the local Meta stand-in on ${STUB}`);
  const stub = spawn('npx', ['tsx', 'scripts/load/meta-stub.ts'], {
    env: { ...process.env, STUB_PORT },
    stdio: 'inherit',
    shell: true,
  });

  console.log(`Starting Aura on ${APP} (dashboard + WhatsApp webhook)\n`);
  const app = spawn('npx', ['next', 'dev', '-p', PORT], {
    env: envFor(10),
    stdio: 'inherit',
    shell: true,
  });

  const stop = () => {
    for (const child of [stub, app]) {
      if (child.pid && child.exitCode === null) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
      }
    }
  };
  process.on('SIGINT', () => {
    stop();
    process.exit(0);
  });
  app.on('exit', stop);
} else if (mode === 'say' || mode === 'script') {
  const args =
    mode === 'script'
      ? ['--script']
      : ['--say', process.argv.slice(3).join(' ') || 'hi'];
  // shell:true re-splits arguments, so a quoted sentence would arrive as
  // separate words. Quote anything containing a space back up.
  const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
  const extra = process.argv.slice(3).filter((a) => a.startsWith('--'));
  const r = spawnSync(
    'npx',
    ['tsx', 'scripts/demo-whatsapp-local.ts', ...quoted, ...extra],
    { env: envFor(4), stdio: 'inherit', shell: true },
  );
  process.exit(r.status ?? 1);
} else {
  console.error(`\nUnknown mode "${mode}". Use: serve | say "<message>" | script\n`);
  process.exit(1);
}
