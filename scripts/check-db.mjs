#!/usr/bin/env node
/**
 * Is this database connection string actually usable from this machine?
 *
 * Built for one specific question: a deployment fails with P1001 "Can't reach
 * database server", and nobody can tell whether the STRING is wrong or the
 * NETWORK is blocked. Those have opposite fixes, and the Prisma error looks
 * identical either way.
 *
 * Run it with the same value the deployment uses:
 *
 *   PowerShell:  $env:CHECK_DB_URL="<the URL>"; node scripts/check-db.mjs
 *   bash:        CHECK_DB_URL="<the URL>" node scripts/check-db.mjs
 *
 * It tests four layers in order and stops at the first one that breaks, so the
 * answer names the layer rather than the symptom. It never prints the password
 * — only the host, and whether each layer answered.
 */
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';

const raw = process.env.CHECK_DB_URL || process.argv[2];

if (!raw) {
  console.error(
    'No URL given.\n\n' +
      'PowerShell:\n' +
      '  $env:CHECK_DB_URL="<paste the DATABASE_URL from Vercel>"\n' +
      '  node scripts/check-db.mjs\n',
  );
  process.exit(2);
}

// Quotes and whitespace pasted into a dashboard field are a real and common
// cause of this failure, so detect them rather than silently tolerating them.
const trimmed = raw.trim().replace(/^["']|["']$/g, '');
const hadQuotes = trimmed !== raw.trim();
const hadWhitespace = raw !== raw.trim();

let url;
try {
  url = new URL(trimmed);
} catch {
  console.error('FAIL (string): this is not a valid URL at all.');
  process.exit(1);
}

const host = url.hostname;
const port = Number(url.port || 5432);
const sslmode = url.searchParams.get('sslmode');

console.log('host     :', host);
console.log('port     :', port);
console.log('database :', url.pathname.replace(/^\//, '') || '(none)');
console.log('sslmode  :', sslmode ?? '(not set)');
if (hadQuotes) console.log('WARNING  : the value has surrounding quotes — remove them in the dashboard.');
if (hadWhitespace) console.log('WARNING  : the value has leading/trailing whitespace or a newline — retype it.');
console.log('');

const verdict = (ok, layer, detail, advice) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${layer}  ${detail}`);
  if (!ok && advice) console.log('\n' + advice + '\n');
  if (!ok) process.exit(1);
};

// --- 1. DNS ---------------------------------------------------------------
let addresses;
try {
  addresses = await dns.lookup(host, { all: true });
  verdict(true, 'dns ', addresses.map((a) => `${a.address} (v${a.family})`).join(', '));
} catch (e) {
  verdict(
    false,
    'dns ',
    e.message,
    'The hostname does not resolve. The endpoint was renamed or deleted —\n' +
      'copy a fresh connection string from the Neon dashboard.',
  );
}

// --- 2. TCP ---------------------------------------------------------------
const tcpOk = await new Promise((resolve) => {
  const s = net.connect({ host, port, timeout: 10000 });
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('timeout', () => { s.destroy(); resolve(false); });
  s.on('error', () => resolve(false));
});
verdict(
  tcpOk,
  'tcp ',
  tcpOk ? `port ${port} open` : `port ${port} did not answer within 10s`,
  'The port never answered. Traffic is being dropped — this is a firewall or\n' +
    'IP allowlist, NOT a bad password. Check Neon > Settings > IP Allow and\n' +
    'make sure it is off (or set to 0.0.0.0/0). A build runner has rotating\n' +
    'IPs and can never be allowlisted individually.',
);

// --- 3. TLS + postgres auth handshake ------------------------------------
// Neon routes by SNI and answers an unknown endpoint before authentication,
// so this distinguishes "endpoint gone" from "password wrong".
const authResult = await new Promise((resolve) => {
  const sock = net.connect({ host, port, timeout: 15000 });
  const fail = (m) => resolve({ ok: false, message: m });

  sock.on('timeout', () => { sock.destroy(); fail('timed out'); });
  sock.on('error', (e) => fail(e.message));
  sock.on('connect', () => {
    const req = Buffer.alloc(8);
    req.writeInt32BE(8, 0);
    req.writeInt32BE(80877103, 4); // SSLRequest
    sock.write(req);
  });

  const startupPacket = () => {
    const params = `user\0${decodeURIComponent(url.username) || 'probe'}\0database\0${
      url.pathname.replace(/^\//, '') || 'postgres'
    }\0\0`;
    const len = 8 + Buffer.byteLength(params);
    const buf = Buffer.alloc(len);
    buf.writeInt32BE(len, 0);
    buf.writeInt32BE(196608, 4);
    buf.write(params, 8);
    return buf;
  };

  const readReply = (stream, transport) => {
    stream.once('data', (chunk) => {
      const type = String.fromCharCode(chunk[0]);
      stream.destroy();
      if (type === 'R') {
        return resolve({
          ok: true,
          message: `server asked for a password — endpoint is live (${transport})`,
        });
      }
      if (type === 'E') {
        const text = chunk.subarray(5).toString('utf8').split('\0').filter(Boolean).join(' | ');
        return resolve({ ok: false, message: text.slice(0, 300) });
      }
      resolve({ ok: false, message: 'unexpected reply type ' + type });
    });
  };

  sock.once('data', (d) => {
    // 'N' means the server does not speak TLS. That is wrong for Neon, which
    // mandates it — but perfectly normal for a local postgres, and calling it
    // a dead endpoint would be a false alarm. Fall back to plaintext and let
    // the handshake itself decide.
    if (String.fromCharCode(d[0]) !== 'S') {
      sock.write(startupPacket());
      readReply(sock, 'no TLS');
      return;
    }

    const secure = tls.connect(
      { socket: sock, servername: host, rejectUnauthorized: false },
      () => secure.write(startupPacket()),
    );
    secure.on('error', (e) => fail(e.message));
    readReply(secure, 'TLS');
  });
});

verdict(
  authResult.ok,
  'auth',
  authResult.message,
  'The server answered but rejected the connection before any password was\n' +
    'sent. Usually the endpoint no longer exists — copy a fresh connection\n' +
    'string from the Neon dashboard.',
);

// --- 4. Verdict -----------------------------------------------------------
console.log(
  '\n' +
    'This connection string WORKS from this machine.\n\n' +
    'So if the deployment still fails with P1001, the string is not the\n' +
    'problem — the build network is being blocked. Turn off\n' +
    'Neon > Settings > IP Allow, or set it to 0.0.0.0/0.\n',
);
if (!sslmode) {
  console.log(
    'Also worth setting: this URL has no sslmode. Add ?sslmode=require\n' +
      '(or &sslmode=require if it already has a query string).\n',
  );
}
