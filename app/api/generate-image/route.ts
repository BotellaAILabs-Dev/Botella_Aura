import { z } from 'zod';

import { requireUser } from '@/lib/auth-helpers';
import { rateLimit } from '@/lib/rate-limit';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { logger } from '@/lib/logger';

/**
 * POST /api/generate-image — text-to-image via Agnes AI.
 *
 * WHY THIS ROUTE EXISTS AT ALL
 * ----------------------------
 * The browser must never hold AGNES_API_KEY. A key shipped to the client is a
 * key published: it appears in the bundle, in devtools, and in any copy of the
 * page someone saves. So the browser posts a prompt here, this route adds the
 * credential server-side, and only the resulting image URL goes back.
 *
 * That is also why the key is read from `process.env.AGNES_API_KEY` with no
 * NEXT_PUBLIC_ prefix — Next inlines any NEXT_PUBLIC_* value into the client
 * bundle at build time, which would defeat the whole arrangement.
 *
 * AUTHENTICATION IS PART OF KEEPING THE KEY PRIVATE
 * -------------------------------------------------
 * Hiding the key behind an endpoint anyone can call does not protect it — it
 * just means the whole internet spends your quota through your server instead
 * of holding the string. So this route requires a signed-in user and is rate
 * limited per user, the same as every other route here that spends money.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Image generation is slow; the platform default (~10s) is far too tight. */
export const maxDuration = 60;

const DEFAULT_BASE_URL = 'https://api.agnes-ai.com/v1';
const DEFAULT_MODEL = 'agnes-image-2.0-flash';
const TIMEOUT_MS = 45_000;

const bodySchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, 'Enter a prompt describing the image you want.')
    .max(2000, 'Keep the prompt under 2000 characters.'),
});

/**
 * The provider's response shape, defensively typed.
 *
 * Every field is optional because this is someone else's JSON: a provider that
 * changes its envelope, or returns an error body with a 200, must produce a
 * clear message here rather than a `cannot read property of undefined`.
 */
interface AgnesResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
  error?: { message?: string; code?: string } | string;
  message?: string;
  code?: string;
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();

    // Missing-key handling: a configuration gap is a 503 that names the
    // variable to set, not a 500 that looks like the service is broken.
    const apiKey = process.env.AGNES_API_KEY;
    if (!apiKey) {
      return jsonError(
        'Image generation is not configured on this deployment. Add AGNES_API_KEY to the server environment.',
        503,
      );
    }

    // Generating an image costs money, so it is throttled per user like the
    // other paid paths in this app.
    const limit = rateLimit(`agnes-image:${user.id}`, {
      limit: 10,
      windowMs: 60_000,
    });
    if (!limit.allowed) {
      return jsonError(
        `Too many image requests. Try again in ${limit.retryAfterSeconds}s.`,
        429,
      );
    }

    const raw = await req.json().catch(() => null);
    if (raw === null) {
      return jsonError('Send a JSON body of the form { "prompt": "..." }.', 400);
    }
    const { prompt } = bodySchema.parse(raw);

    const baseUrl = (process.env.AGNES_API_BASE_URL || DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    );
    const model = process.env.AGNES_IMAGE_MODEL || DEFAULT_MODEL;
    const endpoint = `${baseUrl}/images/generations`;

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, prompt, n: 1, size: '1024x1024' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // A timeout and a DNS failure are different problems for the person
      // reading this, so they are not collapsed into one message.
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      logger.error('agnes: request failed before a response', {
        endpoint,
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError(
        timedOut
          ? 'The image service took too long to respond. Try again.'
          : 'Could not reach the image service. Check AGNES_API_BASE_URL and your network.',
        timedOut ? 504 : 502,
      );
    }

    const payload = (await res.json().catch(() => ({}))) as AgnesResponse;

    if (!res.ok) {
      const providerMessage =
        (typeof payload.error === 'string'
          ? payload.error
          : payload.error?.message) ??
        payload.message ??
        '';

      logger.error('agnes: image generation failed', {
        status: res.status,
        endpoint,
        model,
        code: payload.code,
        detail: providerMessage.slice(0, 200),
      });

      // Each of these is a different thing to go and fix, so each says so.
      if (res.status === 401 || res.status === 403) {
        return jsonError(
          'The image service rejected the API key. Check AGNES_API_KEY on the server.',
          res.status,
        );
      }
      if (res.status === 404) {
        return jsonError(
          `The image service has no endpoint at ${endpoint}. Check AGNES_API_BASE_URL and the model name.`,
          502,
        );
      }
      if (res.status === 429) {
        return jsonError(
          'The image service is rate limiting or out of quota. Wait a moment and try again.',
          429,
        );
      }
      return jsonError(
        providerMessage ||
          `The image service could not generate this image (HTTP ${res.status}).`,
        502,
      );
    }

    const first = payload.data?.[0];

    // Providers return either a hosted URL or inline base64. Both are handed
    // back as something an <img src> can render, so the client needs no
    // special case for which one arrived.
    const imageUrl =
      first?.url ??
      (first?.b64_json ? `data:image/png;base64,${first.b64_json}` : null);

    if (!imageUrl) {
      logger.error('agnes: response contained no image', {
        endpoint,
        model,
        keys: Object.keys(payload),
      });
      return jsonError(
        'The image service returned no image for this prompt. Try rewording it.',
        502,
      );
    }

    return jsonOk({ imageUrl });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const first = error.issues[0]?.message;
      return jsonError(first ?? 'That request was not valid.', 422);
    }
    return handleRouteError(error);
  }
}
