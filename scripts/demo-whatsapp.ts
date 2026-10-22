/**
 * Local WhatsApp demo: runs Aura on this machine behind a free, temporary
 * Cloudflare tunnel, so Meta's WhatsApp Cloud API (test number) can reach it.
 *
 *   1. checks the four WHATSAPP_* values are in .env (never prints them)
 *   2. builds the app (skip with --no-build)
 *   3. opens a tunnel → https://<random>.trycloudflare.com
 *   4. starts Aura on it (APP_URL / NEXTAUTH_URL point at the tunnel for this
 *      run only — .env is not changed)
 *   5. tests the webhook handshake through the public URL
 *   6. prints what to paste into Meta, and the demo login
 *
 * The tunnel address changes every run: paste the new callback URL into
 * Meta each time. Ctrl+C stops everything.
 *
 * Run: npm run demo:whatsapp            (or: npm run demo:whatsapp -- --no-build)
 * Needs cloudflared (winget install Cloudflare.cloudflared). Free, no account.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

try {
  process.loadEnvFile();
} catch {
  // .env missing — the check below says what to add.
}

const PORT = Number(process.env.DEMO_PORT ?? 3000);
const REQUIRED = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'] as const;
const NEXT_BIN = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
const children: ChildProcess[] = [];

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  stopAll();
  process.exit(1);
}

function stopAll() {
  for (const child of children) {
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGTERM');
    }
  }
}

function cloudflaredPath(): string {
  const candidates = [
    process.env.CLOUDFLARED_PATH,
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ].filter(Boolean) as string[];
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) return found;
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8' });
  if (onPath.status === 0) return onPath.stdout.split(/\r?\n/)[0]!.trim();
  return fail('cloudflared is not installed. Run: winget install Cloudflare.cloudflared');
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

function startTunnel(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cloudflaredPath(), ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(proc);
    const timer = setTimeout(() => reject(new Error('the tunnel did not start within 60 s')), 60_000);
    const onData = (buf: Buffer) => {
      const match = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    proc.on('exit', (code) => reject(new Error(`cloudflared exited (${code})`)));
  });
}

async function waitFor(url: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      if (res.status < 500) return true;
    } catch {
      // not up yet (or DNS for the new tunnel still propagating)
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

async function main() {
  // 1. Credentials — names only, never values.
  const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
  if (missing.length) {
    fail(
      `Add these to .env first (values from Meta — see docs/WHATSAPP-DEMO.md):\n    ${missing.join('\n    ')}`,
    );
  }
  if (process.env.WHATSAPP_GRAPH_BASE_URL?.trim()) {
    fail('WHATSAPP_GRAPH_BASE_URL is set, which sends WhatsApp to the test stub instead of Meta. Remove it from .env for the demo.');
  }
  console.log('✓ WhatsApp values found (not shown)');

  if (!(await portFree(PORT))) fail(`Port ${PORT} is in use. Stop whatever is running there (or set DEMO_PORT).`);

  // 2. Build (a production build is much faster to click through than dev mode).
  if (!process.argv.includes('--no-build')) {
    console.log('… building Aura (2–4 minutes)');
    const build = spawnSync(process.execPath, [NEXT_BIN, 'build'], { stdio: 'inherit' });
    if (build.status !== 0) fail('The build failed — see the output above.');
  } else if (!fs.existsSync(path.join('.next', 'BUILD_ID'))) {
    fail('No build found. Run without --no-build.');
  }

  // 3. Tunnel.
  console.log('… opening the tunnel');
  const publicUrl = await startTunnel().catch((err: Error) => fail(`Tunnel failed: ${err.message}`));
  console.log(`✓ Public address: ${publicUrl}`);

  // 4. Aura, pointed at the tunnel for this run only.
  const app = spawn(process.execPath, [NEXT_BIN, 'start', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, APP_URL: publicUrl, NEXTAUTH_URL: publicUrl },
  });
  children.push(app);
  const logFile = fs.createWriteStream(path.join(process.cwd(), '.demo-whatsapp.log'));
  app.stdout!.pipe(logFile);
  app.stderr!.pipe(logFile);
  app.on('exit', (code) => {
    if (code !== null && code !== 0) fail(`Aura stopped (exit ${code}). See .demo-whatsapp.log`);
  });

  if (!(await waitFor(`http://localhost:${PORT}/login`, 90_000))) fail('Aura did not start. See .demo-whatsapp.log');
  console.log('✓ Aura is running');
  if (!(await waitFor(`${publicUrl}/login`, 90_000))) fail('Aura is running but the public address does not answer yet. Try again in a minute.');

  // 5. The exact handshake Meta performs, through the public URL.
  const challenge = String(Date.now());
  const verify = new URL(`${publicUrl}/api/webhooks/whatsapp`);
  verify.searchParams.set('hub.mode', 'subscribe');
  verify.searchParams.set('hub.verify_token', process.env.WHATSAPP_VERIFY_TOKEN!);
  verify.searchParams.set('hub.challenge', challenge);
  const handshake = await fetch(verify, { signal: AbortSignal.timeout(20_000) }).then((r) => r.text()).catch(() => '');
  if (handshake.trim() !== challenge) fail('The webhook handshake through the public URL failed. See .demo-whatsapp.log');
  console.log('✓ Webhook handshake works through the public address');

  // 6. What to do now.
  console.log(`
────────────────────────────────────────────────────────────────────
 In Meta: your app → WhatsApp → Configuration → Webhook → Edit

   Callback URL:  ${publicUrl}/api/webhooks/whatsapp
   Verify token:  the WHATSAPP_VERIFY_TOKEN value from your .env

   → Verify and save, then Webhook fields → "messages" → Subscribe
   (the address changes every run — update it each time)

 Aura (open on your computer AND phone — use this address, not localhost):
   ${publicUrl}/login
   demo@botella.ai  /  Password123     (local demo account)

 Demo: from a phone you added as a test recipient in Meta, send "Hi" to
 the test number → tap the sign-in link → log in → reply with the code →
 MENU → Pending Approvals / Campaigns / Dashboard → STOP / START.

 Logs: .demo-whatsapp.log      Stop: Ctrl+C
────────────────────────────────────────────────────────────────────
`);
}

process.on('SIGINT', () => {
  console.log('\nStopping the tunnel and Aura…');
  stopAll();
  process.exit(0);
});

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
