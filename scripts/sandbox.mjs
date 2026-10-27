/**
 * The sandbox: WhatsApp, Facebook Pages and Instagram, all on this machine.
 *
 *   npm run sandbox                      the stub and the app, wired together
 *   npm run sandbox say "<message>"      send a WhatsApp message, see the reply
 *   npm run sandbox script               the scripted demo conversation
 *   npm run sandbox check                prove all three work end to end
 *
 * Why it exists: the real integrations need things a laptop cannot have — a
 * Meta app, an approved WhatsApp number, a Facebook Page with a linked
 * Instagram professional account, and tokens that expire in about 24 hours.
 * Everything on Aura's side of that boundary is real here: the webhook
 * signature check, the queue, the worker, the router, the approval rules, the
 * publishers and their polling. Only Meta is replaced, by
 * scripts/load/meta-stub.ts on localhost.
 *
 * What it does NOT prove: that Meta accepts this traffic. No message reaches a
 * phone and no post appears on a Page. For that you need the real credentials
 * and `npm run demo:whatsapp`. The check says so itself rather than letting a
 * green run imply otherwise.
 *
 * The credentials below are throwaway local strings, and they are safe because
 * both base-URL overrides are ignored unless they point at this machine
 * (lib/graph-base.ts) — so no token can leave it, even if one of these values
 * is wrong.
 */
import { spawn, spawnSync } from 'node:child_process';

try {
  process.loadEnvFile();
} catch {
  // .env is optional — the checks report what is missing.
}

const PORT = process.env.SANDBOX_PORT ?? process.env.WA_LOCAL_PORT ?? '3001';
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
    // Throwaway, local-only. The real thing uses Meta's own values.
    WHATSAPP_ACCESS_TOKEN: 'local-stub-token',
    WHATSAPP_PHONE_NUMBER_ID: '100000000000001',
    WHATSAPP_APP_SECRET: 'local-stub-app-secret',
    WHATSAPP_VERIFY_TOKEN: 'local-stub-verify-token',
    WHATSAPP_GRAPH_BASE_URL: STUB,
    // Facebook Pages + Instagram. The secret signs Meta's deauthorize and
    // data-deletion callbacks, which are verified locally, so a throwaway
    // value exercises that path exactly as a real one would.
    META_CLIENT_ID: process.env.META_CLIENT_ID || 'local-stub-meta-app',
    META_CLIENT_SECRET: process.env.META_CLIENT_SECRET || 'local-stub-meta-secret',
    META_GRAPH_BASE_URL: STUB,
    DEMO_APP_URL: APP,
    STUB_URL: STUB,
    VERIFY_BASE_URL: APP,
    AURA_URL: APP,
  };
}

/** shell:true re-splits arguments, so a quoted sentence must be quoted again. */
const requote = (args) => args.map((a) => (/\s/.test(a) ? `"${a}"` : a));

function run(args, poolLimit) {
  const r = spawnSync('npx', requote(args), {
    env: envFor(poolLimit),
    stdio: 'inherit',
    shell: true,
  });
  process.exit(r.status ?? 1);
}

const mode = process.argv[2] ?? 'serve';
const rest = process.argv.slice(3);

if (mode === 'serve') {
  console.log(`\nStarting the local Meta stand-in on ${STUB}`);
  console.log('  WhatsApp Cloud API · Facebook Pages · Instagram\n');
  const stub = spawn('npx', ['tsx', 'scripts/load/meta-stub.ts'], {
    env: { ...process.env, STUB_PORT },
    stdio: 'inherit',
    shell: true,
  });

  console.log(`Starting Aura on ${APP} (dashboard, webhook, publishing)\n`);
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
} else if (mode === 'say') {
  run(['tsx', 'scripts/demo-whatsapp-local.ts', '--say', rest.join(' ') || 'hi'], 4);
} else if (mode === 'script') {
  run(['tsx', 'scripts/demo-whatsapp-local.ts', '--script'], 4);
} else if (mode === 'check') {
  /**
   * Both halves, in one command. The Facebook and Instagram checks drive the
   * real publishers; the WhatsApp one signs an inbound message the way Meta
   * signs it and reads the reply back off the stand-in. Neither is much use
   * without the other when the question is "does the sandbox work".
   */
  const steps = [
    ['tsx', 'scripts/verify-sandbox.ts', ...rest],
    ['tsx', 'scripts/demo-whatsapp-local.ts', '--script'],
  ];
  for (const step of steps) {
    const r = spawnSync('npx', requote(step), {
      env: envFor(4),
      stdio: 'inherit',
      shell: true,
    });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  process.exit(0);
} else {
  console.error(
    `\nUnknown mode "${mode}". Use: serve | say "<message>" | script | check\n`,
  );
  process.exit(1);
}
