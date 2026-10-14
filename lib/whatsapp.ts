import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * WhatsApp Cloud API — the pure part of Botella's WhatsApp Assistant: webhook
 * verification, signature checking, payload parsing and the messaging rules.
 * No network and no database here, so all of it is unit-tested.
 *
 * One central Botella number receives every conversation. Meta calls
 * /api/webhooks/whatsapp:
 *   GET  — the one-off subscription check (hub.verify_token → hub.challenge)
 *   POST — messages and delivery statuses, signed with the app secret
 *          (X-Hub-Signature-256: sha256=<hex HMAC of the raw body>)
 *
 * Official Cloud API only (graph.facebook.com) — no unofficial automation.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface WhatsAppConfig {
  /** System-user access token with whatsapp_business_messaging. */
  accessToken: string;
  /** The central number's phone number id (not the number itself). */
  phoneNumberId: string;
  /** App secret — signs every webhook. */
  appSecret: string;
  /** Our own string, echoed by Meta when the webhook is subscribed. */
  verifyToken: string;
  /** Graph API version, e.g. v23.0. */
  apiVersion: string;
}

export const DEFAULT_GRAPH_VERSION = 'v23.0';

type Env = Record<string, string | undefined>;

/** What is missing, by variable name — empty when everything is set. */
export function missingConfig(env: Env = process.env): string[] {
  return [
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
  ].filter((k) => !env[k]?.trim());
}

/** The configuration, or null when any required variable is missing. */
export function whatsAppConfig(
  env: Env = process.env,
): WhatsAppConfig | null {
  if (missingConfig(env).length) return null;
  return {
    accessToken: env.WHATSAPP_ACCESS_TOKEN!.trim(),
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!.trim(),
    appSecret: env.WHATSAPP_APP_SECRET!.trim(),
    verifyToken: env.WHATSAPP_VERIFY_TOKEN!.trim(),
    apiVersion: env.WHATSAPP_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Webhook verification (GET) and signatures (POST)
// ---------------------------------------------------------------------------

/** Constant-time string comparison; false for different lengths. */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Meta's subscription handshake: the challenge to echo back, or null when the
 * request is not a subscribe with our verify token.
 */
export function verifySubscription(
  params: URLSearchParams,
  verifyToken: string,
): string | null {
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token') ?? '';
  const challenge = params.get('hub.challenge');
  if (mode !== 'subscribe' || !challenge || !verifyToken) return null;
  return safeEqual(token, verifyToken) ? challenge : null;
}

/** The X-Hub-Signature-256 Meta would send for this body. */
export function signPayload(rawBody: string, appSecret: string): string {
  return `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')}`;
}

/**
 * Whether the body was signed with our app secret. The HMAC is over the raw
 * bytes exactly as received — parse only after this passes.
 */
export function verifySignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): boolean {
  if (!header || !appSecret || !header.startsWith('sha256=')) return false;
  return safeEqual(header, signPayload(rawBody, appSecret));
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

const errorSchema = z
  .object({
    code: z.coerce.number().optional(),
    title: z.string().optional(),
    message: z.string().optional(),
    error_data: z.object({ details: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const messageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string().optional(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    button: z
      .object({ text: z.string().optional(), payload: z.string().optional() })
      .passthrough()
      .optional(),
    interactive: z
      .object({
        button_reply: z.object({ id: z.string().optional(), title: z.string() }).passthrough().optional(),
        list_reply: z.object({ id: z.string().optional(), title: z.string() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const statusSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    timestamp: z.string().optional(),
    recipient_id: z.string().optional(),
    errors: z.array(errorSchema).optional(),
  })
  .passthrough();

const valueSchema = z
  .object({
    messaging_product: z.string().optional(),
    metadata: z
      .object({ phone_number_id: z.string(), display_phone_number: z.string().optional() })
      .passthrough()
      .optional(),
    contacts: z
      .array(
        z
          .object({
            wa_id: z.string(),
            profile: z.object({ name: z.string().optional() }).passthrough().optional(),
          })
          .passthrough(),
      )
      .optional(),
    messages: z.array(messageSchema).optional(),
    statuses: z.array(statusSchema).optional(),
    errors: z.array(errorSchema).optional(),
  })
  .passthrough();

export const webhookPayloadSchema = z
  .object({
    object: z.string(),
    entry: z
      .array(
        z
          .object({
            id: z.string().optional(),
            changes: z
              .array(z.object({ field: z.string(), value: valueSchema }).passthrough())
              .default([]),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export interface InboundMessage {
  wamid: string;
  /** The sender's WhatsApp id (their number, digits only). */
  waId: string;
  profileName: string | null;
  /** Meta's type: text, image, audio, button, interactive, … */
  type: string;
  /** What they wrote — text, a button's label or a list choice — else null. */
  text: string | null;
  /** The id of the menu option they tapped (ours), else null. */
  replyId: string | null;
  occurredAt: Date;
}

export interface StatusUpdate {
  wamid: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  occurredAt: Date;
  error: { code: string; message: string } | null;
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
  /** Changes for another phone number on the same account — ignored. */
  ignored: number;
}

const fromUnix = (ts: string | undefined): Date => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
};

const KNOWN_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

/**
 * The messages and statuses in a verified webhook, for our number only. A
 * change addressed to another phone number on the same business account is
 * counted and ignored, never answered from ours.
 */
export function parseWebhook(body: unknown, phoneNumberId: string): ParsedWebhook {
  const payload = webhookPayloadSchema.parse(body);
  const out: ParsedWebhook = { messages: [], statuses: [], ignored: 0 };
  if (payload.object !== 'whatsapp_business_account') return out;

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const v = change.value;
      if (v.metadata?.phone_number_id !== phoneNumberId) {
        out.ignored++;
        continue;
      }
      const names = new Map(
        (v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name?.trim() || null]),
      );
      for (const m of v.messages ?? []) {
        out.messages.push({
          wamid: m.id,
          waId: m.from,
          profileName: names.get(m.from) ?? null,
          type: m.type,
          text:
            m.text?.body ??
            m.button?.text ??
            m.interactive?.button_reply?.title ??
            m.interactive?.list_reply?.title ??
            null,
          replyId:
            m.interactive?.button_reply?.id ??
            m.interactive?.list_reply?.id ??
            m.button?.payload ??
            null,
          occurredAt: fromUnix(m.timestamp),
        });
      }
      for (const s of v.statuses ?? []) {
        if (!KNOWN_STATUSES.has(s.status)) continue;
        const e = s.errors?.[0];
        out.statuses.push({
          wamid: s.id,
          status: s.status as StatusUpdate['status'],
          occurredAt: fromUnix(s.timestamp),
          error: e
            ? {
                code: String(e.code ?? 'unknown'),
                message: (e.error_data?.details || e.message || e.title || 'Delivery failed').slice(0, 500),
              }
            : null,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type MessageStatus = 'RECEIVED' | 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

const RANK: Record<MessageStatus, number> = {
  RECEIVED: 0,
  PENDING: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  FAILED: 4,
};

/**
 * Whether a status update should replace the current one. Meta can deliver
 * statuses out of order; "delivered" arriving after "read" must not undo it.
 * A failure always wins.
 */
export function shouldApplyStatus(current: MessageStatus, next: MessageStatus): boolean {
  if (current === 'FAILED') return false;
  return RANK[next] > RANK[current];
}

/** Meta's customer-service window: free-form replies within 24h of their last message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function withinServiceWindow(
  lastInboundAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastInboundAt) return false;
  const age = now.getTime() - lastInboundAt.getTime();
  return age >= 0 && age < SERVICE_WINDOW_MS;
}

/** Opt-out and opt-in keywords (Meta policy: honour an opt-out at once). */
export function optKeyword(text: string | null): 'stop' | 'start' | null {
  const t = (text ?? '').trim().toUpperCase().replace(/[.!]+$/, '');
  if (['STOP', 'UNSUBSCRIBE', 'STOP ALL', 'OPT OUT', 'OPTOUT'].includes(t)) return 'stop';
  if (['START', 'SUBSCRIBE', 'OPT IN', 'UNSTOP'].includes(t)) return 'start';
  return null;
}

/** WhatsApp's text-message limit. */
export const MAX_TEXT_LENGTH = 4096;

export function clampText(text: string): string {
  const t = text.trim();
  return t.length <= MAX_TEXT_LENGTH ? t : `${t.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}

/** Digits only, as WhatsApp ids are; null when it cannot be a number. */
export function normalizeWaId(waId: string): string | null {
  const d = waId.replace(/\D/g, '');
  return d.length >= 7 && d.length <= 15 ? d : null;
}

/** For the dashboard: never the full number. */
export function maskWaId(last4: string): string {
  return `•••• ${last4}`;
}

// ---------------------------------------------------------------------------
// Outbound content
// ---------------------------------------------------------------------------

/**
 * What the assistant can send. Interactive menus are how a person picks a
 * feature without typing; an image carries an asset id (not a URL) so every
 * attempt signs a fresh link — a retry never sends one that has expired.
 */
export type OutboundContent =
  | { kind: 'text'; text: string }
  | {
      kind: 'buttons';
      body: string;
      buttons: { id: string; title: string }[];
      header?: string;
      footer?: string;
    }
  | {
      kind: 'list';
      body: string;
      /** The label on the button that opens the list. */
      button: string;
      sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[];
      header?: string;
      footer?: string;
    }
  | { kind: 'image'; assetId: string; caption?: string }
  /** A message with one button that opens a web page (Meta's cta_url). */
  | { kind: 'cta'; body: string; buttonText: string; url: string; header?: string; footer?: string };

/**
 * Meta's limits for interactive messages. A message over any of them is
 * rejected outright (error 131009), so content is fitted before sending.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages
 */
export const INTERACTIVE_LIMITS = {
  body: 1024,
  header: 60,
  footer: 60,
  buttons: 3,
  buttonTitle: 20,
  listButton: 20,
  listRows: 10,
  sections: 10,
  rowTitle: 24,
  rowDescription: 72,
  sectionTitle: 24,
  id: 200,
  caption: 1024,
  ctaText: 20,
} as const;

/** Single-line text (titles, labels): all whitespace collapsed. */
const cut = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

/** Multi-line text (bodies, captions): paragraphs kept, runs of blank lines and spaces tidied. */
const cutBody = (s: string, max: number) => {
  const t = s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

/**
 * The content, fitted to Meta's limits: text clamped, titles shortened,
 * extra buttons or rows dropped (never silently reordered). Throws for
 * content that cannot be sent at all — no buttons, no rows, duplicate ids.
 */
export function fitContent(c: OutboundContent): OutboundContent {
  const L = INTERACTIVE_LIMITS;
  switch (c.kind) {
    case 'text':
      return { kind: 'text', text: clampText(c.text) };
    case 'image':
      return {
        kind: 'image',
        assetId: c.assetId,
        ...(c.caption ? { caption: cutBody(c.caption, L.caption) } : {}),
      };
    case 'cta':
      // Only our own https pages go behind a button.
      if (!/^https:\/\/[^\s]+$/.test(c.url) && !/^http:\/\/localhost(:\d+)?\//.test(c.url)) {
        throw new Error('A link button needs an https URL.');
      }
      return {
        kind: 'cta',
        body: cutBody(c.body, L.body),
        buttonText: cut(c.buttonText, L.ctaText),
        url: c.url,
        ...(c.header ? { header: cut(c.header, L.header) } : {}),
        ...(c.footer ? { footer: cut(c.footer, L.footer) } : {}),
      };
    case 'buttons': {
      const buttons = c.buttons.slice(0, L.buttons).map((b) => ({
        id: b.id.slice(0, L.id),
        title: cut(b.title, L.buttonTitle),
      }));
      if (!buttons.length) throw new Error('A button message needs at least one button.');
      assertUniqueIds(buttons.map((b) => b.id));
      return {
        kind: 'buttons',
        body: cutBody(c.body, L.body),
        buttons,
        ...(c.header ? { header: cut(c.header, L.header) } : {}),
        ...(c.footer ? { footer: cut(c.footer, L.footer) } : {}),
      };
    }
    case 'list': {
      let room: number = L.listRows;
      const sections = c.sections
        .slice(0, L.sections)
        .map((s) => {
          const rows = s.rows.slice(0, Math.max(room, 0)).map((r) => ({
            id: r.id.slice(0, L.id),
            title: cut(r.title, L.rowTitle),
            ...(r.description ? { description: cut(r.description, L.rowDescription) } : {}),
          }));
          room -= rows.length;
          return { ...(s.title ? { title: cut(s.title, L.sectionTitle) } : {}), rows };
        })
        .filter((s) => s.rows.length > 0);
      if (!sections.length) throw new Error('A list message needs at least one row.');
      assertUniqueIds(sections.flatMap((s) => s.rows.map((r) => r.id)));
      // With more than one section, Meta requires every section to have a title.
      if (sections.length > 1 && sections.some((s) => !s.title)) {
        throw new Error('Every section needs a title when a list has more than one.');
      }
      return {
        kind: 'list',
        body: cutBody(c.body, L.body),
        button: cut(c.button, L.listButton),
        sections,
        ...(c.header ? { header: cut(c.header, L.header) } : {}),
        ...(c.footer ? { footer: cut(c.footer, L.footer) } : {}),
      };
    }
  }
}

function assertUniqueIds(ids: string[]) {
  if (new Set(ids).size !== ids.length) throw new Error('Menu option ids must be unique.');
}

/** A readable one-line version, stored as the message body for history. */
export function contentSummary(c: OutboundContent): string {
  switch (c.kind) {
    case 'text':
      return c.text;
    case 'buttons':
      return `${c.body}\n[${c.buttons.map((b) => b.title).join('] [')}]`;
    case 'list':
      return `${c.body}\n[${c.button}: ${c.sections.flatMap((s) => s.rows.map((r) => r.title)).join(', ')}]`;
    case 'image':
      return `[image]${c.caption ? ` ${c.caption}` : ''}`;
    case 'cta':
      // Not the URL: a sign-in link must not sit readable in the history.
      return `${c.body}\n[${c.buttonText} →]`;
  }
}

/** The Cloud API message body for content (an image needs its signed link). */
export function toApiMessage(
  c: OutboundContent,
  imageLink?: string,
): Record<string, unknown> {
  switch (c.kind) {
    case 'text':
      return { type: 'text', text: { preview_url: false, body: c.text } };
    case 'image':
      if (!imageLink) throw new Error('An image message needs a link.');
      return { type: 'image', image: { link: imageLink, ...(c.caption ? { caption: c.caption } : {}) } };
    case 'cta':
      return {
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          ...(c.header ? { header: { type: 'text', text: c.header } } : {}),
          body: { text: c.body },
          ...(c.footer ? { footer: { text: c.footer } } : {}),
          action: { name: 'cta_url', parameters: { display_text: c.buttonText, url: c.url } },
        },
      };
    case 'buttons':
      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          ...(c.header ? { header: { type: 'text', text: c.header } } : {}),
          body: { text: c.body },
          ...(c.footer ? { footer: { text: c.footer } } : {}),
          action: { buttons: c.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
        },
      };
    case 'list':
      return {
        type: 'interactive',
        interactive: {
          type: 'list',
          ...(c.header ? { header: { type: 'text', text: c.header } } : {}),
          body: { text: c.body },
          ...(c.footer ? { footer: { text: c.footer } } : {}),
          action: { button: c.button, sections: c.sections },
        },
      };
  }
}
