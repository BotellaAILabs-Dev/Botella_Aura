import type { WhatsAppConfig } from '@/lib/whatsapp';
import { clampText } from '@/lib/whatsapp';
import { logger } from '@/lib/logger';

/**
 * The official WhatsApp Cloud API (graph.facebook.com) — sending a text reply
 * and marking a message read. Nothing else talks to Meta.
 *
 * Errors are classified so the caller knows whether to retry: a rate limit, a
 * Meta-side hiccup or a network failure is worth another attempt; a message
 * outside the 24-hour window, a bad number or a broken token is not.
 */

const TIMEOUT_MS = 15_000;

/**
 * The Graph API host. Only load tests change it (WHATSAPP_GRAPH_BASE_URL,
 * pointing at scripts/load/meta-stub.ts) — sending thousands of test replies
 * to Meta would be refused and could get the sender rate-limited. Unset in
 * every real deployment.
 */
function graphBase(): string {
  return (process.env.WHATSAPP_GRAPH_BASE_URL?.trim() || 'https://graph.facebook.com').replace(/\/$/, '');
}

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}

/**
 * Meta error codes worth retrying: throughput and pair rate limits, spam rate
 * limits, temporary/unknown errors and service unavailability.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
const RETRYABLE_CODES = new Set([
  '1', // API unknown
  '2', // API service temporarily unavailable
  '4', // too many calls (app)
  '80007', // rate limit (WABA)
  '130429', // throughput rate limit
  '131000', // something went wrong
  '131016', // service unavailable
  '131048', // spam rate limit
  '131056', // pair rate limit (same recipient too fast)
  '133004', // server temporarily unavailable
]);

/** Plain-language reasons for the errors a person will see on the dashboard. */
const KNOWN: Record<string, string> = {
  '131047': 'More than 24 hours since their last message — only an approved template can be sent.',
  '131026': 'The message could not be delivered to this number.',
  '131051': 'This message type is not supported.',
  '131049': 'Meta held this message back to protect the recipient experience.',
  '190': 'The WhatsApp access token is invalid or expired.',
  '100': 'Meta rejected the request parameters.',
  '133010': 'The phone number is not registered with the Cloud API.',
};

interface GraphError {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
    fbtrace_id?: string;
  };
}

function classify(status: number, body: GraphError, accessToken: string): WhatsAppApiError {
  const e = body.error ?? {};
  const code = String(e.code ?? status);
  const retryable = status === 429 || status >= 500 || RETRYABLE_CODES.has(code);
  const message =
    KNOWN[code] ?? (e.error_data?.details || e.message || `WhatsApp API error (HTTP ${status})`);
  // Meta's messages are shown on the dashboard and logged: never the token.
  const safe = accessToken ? message.split(accessToken).join('[redacted]') : message;
  return new WhatsAppApiError(safe.slice(0, 500), code, retryable, status);
}

async function post(
  config: WhatsAppConfig,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const url = `${graphBase()}/${config.apiVersion}/${encodeURIComponent(
    config.phoneNumberId,
  )}/messages`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new WhatsAppApiError(
      timedOut ? 'WhatsApp did not respond in time.' : 'Could not reach WhatsApp.',
      timedOut ? 'timeout' : 'network',
      true,
      null,
    );
  }
  const body = (await res.json().catch(() => ({}))) as GraphError & Record<string, unknown>;
  if (!res.ok) {
    const error = classify(res.status, body, config.accessToken);
    // The trace id lets Meta support find the request; the token never appears.
    logger.warn('whatsapp: API error', {
      status: res.status,
      code: error.code,
      retryable: error.retryable,
      fbtraceId: body.error?.fbtrace_id,
    });
    throw error;
  }
  return body;
}

/**
 * Send one message — text, an interactive menu or an image, already in the
 * Cloud API's shape (lib/whatsapp.ts `toApiMessage`). Returns Meta's message
 * id (wamid).
 */
export async function sendMessage(
  config: WhatsAppConfig,
  to: string,
  message: Record<string, unknown>,
  options: { replyTo?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const body = (await post(
    config,
    {
      recipient_type: 'individual',
      to,
      ...message,
      ...(options.replyTo ? { context: { message_id: options.replyTo } } : {}),
    },
    options.fetchImpl ?? fetch,
  )) as { messages?: { id?: string }[] };
  const id = body.messages?.[0]?.id;
  if (!id) {
    throw new WhatsAppApiError('WhatsApp accepted the request but returned no message id.', 'no_id', true, 200);
  }
  return id;
}

/** Send a text message; returns Meta's message id (wamid). */
export async function sendTextMessage(
  config: WhatsAppConfig,
  to: string,
  text: string,
  options: { replyTo?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  return sendMessage(
    config,
    to,
    { type: 'text', text: { preview_url: false, body: clampText(text) } },
    options,
  );
}

/** Mark an inbound message read (blue ticks). Best effort — never throws. */
export async function markRead(
  config: WhatsAppConfig,
  wamid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await post(config, { status: 'read', message_id: wamid }, fetchImpl);
  } catch {
    // A missing read receipt is cosmetic; the reply still goes out.
  }
}
