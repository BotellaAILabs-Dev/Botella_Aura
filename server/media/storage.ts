import crypto from 'node:crypto';

import { httpRequest } from '@/lib/http';
import { logger } from '@/lib/logger';

/**
 * Where generated image bytes are kept.
 *
 * The default store is the database, and that is a deliberate choice rather
 * than a shortcut: this app deploys to Netlify/Vercel/Railway with no writable
 * filesystem, and every image provider hands back a URL that expires within
 * hours. A post scheduled for next week cannot depend on one. Postgres is
 * already the durable thing we have, MAX_ASSET_BYTES keeps the rows bounded,
 * and it means graphic generation needs no new infrastructure to work.
 *
 * When a workspace outgrows that, setting the ASSET_S3_* variables switches to
 * an S3-compatible bucket (AWS, Cloudflare R2, Backblaze B2, MinIO) with no
 * other change — same interface, and the asset row records which store holds
 * each image, so existing assets keep working after the switch.
 *
 * SigV4 is implemented here directly rather than pulling in the AWS SDK: it is
 * one signature over one PUT, and the SDK is a large dependency to add for it.
 */
export interface StoredObject {
  storage: 'DATABASE' | 'EXTERNAL';
  /** Set only for EXTERNAL — the durable URL in our own bucket. */
  storageUrl?: string;
  /** Set only for DATABASE — the bytes to persist on the asset row. */
  data?: Buffer;
}

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public base URL for reads, when the bucket is served from a CDN/domain. */
  publicBaseUrl?: string;
}

export function s3Config(): S3Config | null {
  const endpoint = process.env.ASSET_S3_ENDPOINT;
  const bucket = process.env.ASSET_S3_BUCKET;
  const accessKeyId = process.env.ASSET_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.ASSET_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    bucket,
    region: process.env.ASSET_S3_REGION || 'auto',
    accessKeyId,
    secretAccessKey,
    ...(process.env.ASSET_S3_PUBLIC_BASE_URL
      ? { publicBaseUrl: process.env.ASSET_S3_PUBLIC_BASE_URL.replace(/\/+$/, '') }
      : {}),
  };
}

export function activeStore(): 'DATABASE' | 'EXTERNAL' {
  return s3Config() ? 'EXTERNAL' : 'DATABASE';
}

const EXTENSION_FOR: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Persist image bytes and describe where they went.
 *
 * A bucket upload that fails falls back to the database rather than failing the
 * generation: the user has already paid for the image, and losing it to a
 * misconfigured bucket is the worse outcome. The failure is logged loudly.
 */
export async function putImage(args: {
  companyId: string;
  assetId: string;
  data: Buffer;
  mimeType: string;
}): Promise<StoredObject> {
  const config = s3Config();
  if (!config) return { storage: 'DATABASE', data: args.data };

  const extension = EXTENSION_FOR[args.mimeType] ?? 'png';
  const key = `graphics/${args.companyId}/${args.assetId}.${extension}`;
  try {
    const url = await s3Put(config, key, args.data, args.mimeType);
    return { storage: 'EXTERNAL', storageUrl: url };
  } catch (err) {
    logger.error('asset storage: bucket upload failed, keeping bytes in the database', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return { storage: 'DATABASE', data: args.data };
  }
}

/** Fetch an EXTERNAL asset's bytes back (used when publishing needs the file). */
export async function fetchExternal(url: string): Promise<Buffer | null> {
  const res = await httpRequest(url, { timeoutMs: 20_000, retries: 1 });
  if (!res.ok) {
    logger.error('asset storage: could not read stored object', {
      status: res.status,
    });
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Best-effort delete. A leftover object is preferable to a failed user action. */
export async function deleteExternal(url: string): Promise<void> {
  const config = s3Config();
  if (!config) return;
  const key = keyFromUrl(config, url);
  if (!key) return;
  try {
    await s3Request(config, 'DELETE', key);
  } catch (err) {
    logger.warn('asset storage: delete failed (object may remain)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// S3-compatible signing (AWS Signature Version 4)
// ---------------------------------------------------------------------------

function hash(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return crypto.createHmac('sha256', key).update(value).digest();
}

/**
 * The SigV4 signing key: a chain of HMACs over date, region, service and a
 * terminator. Deriving it per request (rather than caching) costs four cheap
 * hashes and avoids holding key material longer than the call.
 */
function signingKey(config: S3Config, date: string): Buffer {
  const kDate = hmac(`AWS4${config.secretAccessKey}`, date);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function objectUrl(config: S3Config, key: string): string {
  // Path-style addressing: it is what R2, B2 and MinIO all accept, and AWS
  // still honours it. Virtual-host style would need per-provider host rules.
  return `${config.endpoint}/${config.bucket}/${key}`;
}

function keyFromUrl(config: S3Config, url: string): string | null {
  const prefix = `${config.endpoint}/${config.bucket}/`;
  if (url.startsWith(prefix)) return url.slice(prefix.length);
  if (config.publicBaseUrl && url.startsWith(`${config.publicBaseUrl}/`)) {
    return url.slice(config.publicBaseUrl.length + 1);
  }
  return null;
}

async function s3Request(
  config: S3Config,
  method: 'PUT' | 'DELETE',
  key: string,
  body?: Buffer,
  contentType?: string,
): Promise<Response> {
  const url = new URL(objectUrl(config, key));
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = hash(body ?? '');

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) headers['content-type'] = contentType;

  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders
    .map((h) => `${h}:${headers[h]!.trim()}\n`)
    .join('');
  const signedHeaderList = signedHeaders.join(';');

  const canonicalRequest = [
    method,
    url.pathname,
    '', // no query string
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join('\n');

  const scope = `${date}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    hash(canonicalRequest),
  ].join('\n');

  const signature = crypto
    .createHmac('sha256', signingKey(config, date))
    .update(stringToSign)
    .digest('hex');

  const res = await httpRequest(url.toString(), {
    method,
    headers: {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaderList}, Signature=${signature}`,
    },
    // Uint8Array rather than the Buffer directly: Buffer is not part of the
    // DOM's BodyInit union, even though it is a Uint8Array at runtime.
    ...(body ? { body: new Uint8Array(body) } : {}),
    timeoutMs: 30_000,
    retries: 1,
  });

  if (!res.ok) {
    // The bucket's error body can name the bucket and key; keep it server-side.
    const detail = await res.text().catch(() => '');
    logger.error('asset storage: S3 request rejected', {
      method,
      status: res.status,
      detail: detail.slice(0, 200),
    });
    throw new Error(`Object storage rejected the ${method} (HTTP ${res.status}).`);
  }
  return res;
}

async function s3Put(
  config: S3Config,
  key: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  await s3Request(config, 'PUT', key, data, contentType);
  return config.publicBaseUrl
    ? `${config.publicBaseUrl}/${key}`
    : objectUrl(config, key);
}
