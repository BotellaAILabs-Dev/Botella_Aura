import { logger } from '@/lib/logger';

/**
 * Shared HTTP client for all outbound third-party calls (Reddit, HN, Google
 * News, LinkedIn). NON-NEGOTIABLE #2: no inline fetch() scattered in route
 * handlers — everything goes through here so timeouts, retries, and error
 * handling are consistent and each source stays a thin wrapper.
 *
 * Rate-limit posture: this helper does NOT hammer on 429. It surfaces the
 * status to the caller, which is responsible for respecting each API's
 * documented limits (see the per-source comments in server/trends/sources/*).
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body?: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

interface RequestOptions extends RequestInit {
  /** Per-attempt timeout in ms (default 10s). */
  timeoutMs?: number;
  /** Retry count for transient failures (network / 5xx). Default 2. */
  retries?: number;
}

async function fetchWithTimeout(
  url: string,
  { timeoutMs = 10_000, ...init }: RequestOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Low-level request with retry on network errors and 5xx. Returns the Response. */
export async function httpRequest(
  url: string,
  options: RequestOptions = {},
): Promise<Response> {
  const { retries = 2, ...rest } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, rest);
      // Retry 5xx once more; 4xx (incl. 429) is returned to the caller as-is.
      if (res.status >= 500 && attempt < retries) {
        lastError = new HttpError(res.status, url);
        await backoff(attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await backoff(attempt);
        continue;
      }
    }
  }
  logger.warn('httpRequest exhausted retries', {
    url,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  throw lastError instanceof Error
    ? lastError
    : new Error(`Request failed: ${url}`);
}

/** JSON GET helper. Throws HttpError on non-2xx. */
export async function getJson<T>(
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const res = await httpRequest(url, {
    ...options,
    headers: { accept: 'application/json', ...options.headers },
  });
  if (!res.ok) {
    throw new HttpError(res.status, url, await safeText(res));
  }
  return (await res.json()) as T;
}

/** Text GET helper (for RSS/XML). Throws HttpError on non-2xx. */
export async function getText(
  url: string,
  options: RequestOptions = {},
): Promise<string> {
  const res = await httpRequest(url, options);
  if (!res.ok) {
    throw new HttpError(res.status, url, await safeText(res));
  }
  return res.text();
}

async function backoff(attempt: number): Promise<void> {
  // Exponential-ish: 250ms, 500ms, ... (jitter kept out for test determinism).
  const ms = 250 * 2 ** attempt;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(res: Response): Promise<string | undefined> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return undefined;
  }
}
