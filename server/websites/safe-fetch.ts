import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Outbound requests to a website a person typed in.
 *
 * Website integrations are the one place Aura's server calls an address
 * chosen by a user, so they are the one place it could be pointed at itself:
 * a "WordPress site" at http://169.254.169.254/ (cloud metadata),
 * http://localhost:5432, or a hostname that resolves to 10.0.0.5 would turn
 * Connect into a way to probe the private network. Every call therefore:
 *
 *   - must be https (http only for local development, see below)
 *   - is checked at CONNECT time, not just before: the socket's own DNS lookup
 *     goes through `guardedLookup`, so the address checked is the address
 *     used — a hostname that resolves to a public IP for the check and a
 *     private one for the connection (DNS rebinding) gets nowhere
 *   - follows at most 3 redirects, each re-checked, and drops the credential
 *     header when a redirect leaves the original host
 *   - is time- and size-limited
 *
 * `WEBSITE_ALLOW_PRIVATE_HOSTS=true` (ignored in production) allows a local
 * WordPress/Ghost in Docker during development, over http too.
 */

export class UnsafeUrlError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

function devPrivateAllowed(): boolean {
  return process.env.WEBSITE_ALLOW_PRIVATE_HOSTS === 'true' && process.env.NODE_ENV !== 'production';
}

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

/** Loopback, private, link-local, multicast, reserved — anything not the public internet. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return v4Blocked(ip);
  if (!net.isIPv6(ip)) return true;
  const a = ip.toLowerCase();
  // IPv4-mapped / NAT64 forms carry an IPv4 address: judge that.
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return v4Blocked(mapped[1]!);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(a)) {
    const [hi, lo] = a.slice(7).split(':').map((h) => parseInt(h, 16));
    return v4Blocked(`${hi! >> 8}.${hi! & 255}.${lo! >> 8}.${lo! & 255}`);
  }
  if (a === '::' || a === '::1') return true;
  const first = parseInt(a.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (a.startsWith('2001:db8:') || a.startsWith('2001:0db8:')) return true; // documentation
  return false;
}

/**
 * A site address as stored: scheme + host (+ port) + path, no trailing slash,
 * query or fragment. WordPress may live in a subdirectory, so the path stays.
 */
export function normaliseSiteUrl(raw: string): string {
  const input = raw.trim();
  if (!input) throw new UnsafeUrlError('Enter the site’s address.');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new UnsafeUrlError('That isn’t a web address. Enter it like https://www.example.com.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && devPrivateAllowed())) {
    throw new UnsafeUrlError('The site must use https://.');
  }
  if (url.username || url.password) throw new UnsafeUrlError('Remove the username and password from the address.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!devPrivateAllowed()) {
    if (net.isIP(host) && isPrivateAddress(host)) throw new UnsafeUrlError('That address is on a private network, which Aura cannot publish to.');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) {
      throw new UnsafeUrlError('Enter the site’s public address (a private or local hostname cannot be reached).');
    }
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** The socket's DNS lookup, refusing private addresses (checked as connected). */
export function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as dns.LookupAddress[];
    if (!devPrivateAllowed()) {
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (bad || list.length === 0) {
        return callback(Object.assign(new UnsafeUrlError(`${hostname} resolves to a private network address, which Aura cannot publish to.`), { code: 'EUNSAFEADDR' }), '');
      }
    }
    if (options.all) return callback(null, list);
    const first = list[0]!;
    callback(null, first.address, first.family);
  });
}

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  /** Largest response accepted (default 5 MB). */
  maxBytes?: number;
}

const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function once(url: URL, init: SafeFetchInit): Promise<{ status: number; statusText: string; headers: Headers; body: Buffer }> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // An IP literal never reaches the lookup: check it here.
  if (net.isIP(host) && isPrivateAddress(host) && !devPrivateAllowed()) {
    return Promise.reject(new UnsafeUrlError('That address is on a private network, which Aura cannot publish to.'));
  }
  const lib = url.protocol === 'https:' ? https : http;
  const maxBytes = init.maxBytes ?? 5 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: init.method ?? 'GET',
        headers: { 'user-agent': 'BotellaAura/1.0 (+website publishing)', ...init.headers },
        lookup: guardedLookup as unknown as net.LookupFunction,
        timeout: init.timeoutMs ?? 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error(`The site’s response was larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
            else if (v !== undefined) headers.set(k, v);
          }
          resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', headers, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('The site took too long to answer.'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** fetch(), for user-chosen hosts. Returns a standard Response. */
export async function safeFetch(rawUrl: string, init: SafeFetchInit = {}): Promise<Response> {
  let url = new URL(rawUrl);
  let current = { ...init, headers: { ...init.headers } };
  const origin = url.host;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && devPrivateAllowed())) {
      throw new UnsafeUrlError('The site redirected to an address that is not https://.');
    }
    const res = await once(url, current);
    if (REDIRECTS.has(res.status) && res.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw new Error('The site redirected too many times.');
      const next = new URL(res.headers.get('location')!, url);
      // Credentials stay with the host they were given for.
      if (next.host !== origin) {
        const { authorization: _a, Authorization: _b, ...rest } = current.headers;
        current = { ...current, headers: rest };
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && current.method && current.method !== 'GET')) {
        const { 'content-type': _c, 'Content-Type': _d, ...rest } = current.headers;
        current = { ...current, method: 'GET', body: undefined, headers: rest };
      }
      url = next;
      continue;
    }
    const noBody = res.status === 204 || res.status === 205 || res.status === 304 || res.status < 200;
    return new Response(noBody ? null : new Uint8Array(res.body), {
      status: res.status < 200 || res.status > 599 ? 502 : res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
}
