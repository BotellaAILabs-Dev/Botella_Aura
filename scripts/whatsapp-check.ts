/**
 * WhatsApp Cloud API connectivity check — against the REAL Meta Graph API,
 * with the credentials in .env (or the environment). Prints what Meta
 * answered; never prints the token or app secret.
 *
 *   pnpm whatsapp:check                         configuration + credentials check
 *   pnpm whatsapp:check --to 447700900123       + send a text through Aura's own
 *                                               sending service (needs an open
 *                                               24-hour window: message the
 *                                               test number from that phone first)
 *   pnpm whatsapp:check --to 447700900123 --template
 *                                               + send Meta's "hello_world" test
 *                                               template instead (works without a
 *                                               window, to an allowed test recipient)
 *
 * Delivery status ("sent", "delivered", "read") arrives only by webhook, at
 * https://<host>/api/webhooks/whatsapp. Until that is reachable, confirm
 * delivery on the phone.
 */
import fs from 'node:fs';
import path from 'node:path';

import { missingConfig, whatsAppConfig, DEFAULT_GRAPH_VERSION } from '@/lib/whatsapp';
import { sendMessage, sendTextMessage, WhatsAppApiError } from '@/server/whatsapp/client';

/** Load .env without overriding what is already set; values are never printed. */
function loadDotEnv() {
  for (const file of ['.env', '.env.local']) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      const value = m[2]!.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
    }
  }
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

const ok = (s: string) => console.log(`  ok      ${s}`);
const bad = (s: string) => console.log(`  FAILED  ${s}`);
const info = (s: string) => console.log(`  info    ${s}`);

async function main() {
  loadDotEnv();
  let failed = false;

  console.log('\n1. Configuration (names only — values are never shown)');
  for (const k of ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN']) {
    if (process.env[k]?.trim()) ok(`${k} is set`);
    else {
      bad(`${k} is missing`);
      failed = true;
    }
  }
  if (process.env.WHATSAPP_GRAPH_BASE_URL?.trim()) {
    bad('WHATSAPP_GRAPH_BASE_URL is set — that sends to the load-test stub, not Meta. Remove it.');
    failed = true;
  }
  const config = whatsAppConfig();
  if (!config) {
    console.log(`\nMissing: ${missingConfig().join(', ')}. Add them to .env (see docs/WHATSAPP-TEST-SETUP.md) and run again.`);
    process.exit(1);
  }
  info(`Graph API version: ${config.apiVersion}${config.apiVersion === DEFAULT_GRAPH_VERSION ? ' (default)' : ''}`);
  if (/^EAA/.test(config.accessToken) === false) info('The access token does not look like a Meta token (they start with "EAA") — check you copied the whole value.');
  if (!/^\d{6,20}$/.test(config.phoneNumberId)) {
    bad('WHATSAPP_PHONE_NUMBER_ID should be the numeric Phone number ID from API Setup, not the phone number itself.');
    failed = true;
  }

  console.log('\n2. Credentials, asked of Meta');
  const url = `https://graph.facebook.com/${config.apiVersion}/${encodeURIComponent(config.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${config.accessToken}` }, signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (res.ok) {
      ok(`Meta answered HTTP ${res.status}: number ${body.display_phone_number ?? '?'} ("${body.verified_name ?? '?'}"), quality ${body.quality_rating ?? 'n/a'}`);
    } else {
      const e = body.error ?? {};
      const hint =
        e.code === 190
          ? 'the token is invalid or expired (temporary tokens last 24 hours — copy a new one from API Setup)'
          : e.code === 100 && /does not exist|missing permissions/i.test(e.message ?? '')
            ? 'the Phone number ID is wrong, or the token belongs to another app/WhatsApp account'
            : e.code === 10 || e.code === 200
              ? 'the token lacks whatsapp_business_management (fine for sending; this lookup just cannot run)'
              : 'see Meta’s message';
      bad(`Meta answered HTTP ${res.status}, code ${e.code ?? '?'}${e.error_subcode ? `/${e.error_subcode}` : ''}: ${String(e.message ?? '').slice(0, 200)} — ${hint}${e.fbtrace_id ? ` (fbtrace_id ${e.fbtrace_id})` : ''}`);
      if (e.code !== 10 && e.code !== 200) failed = true;
    }
  } catch (err) {
    bad(`Could not reach graph.facebook.com: ${err instanceof Error ? err.message : String(err)}`);
    failed = true;
  }

  const to = arg('to');
  if (to) {
    const recipient = to.replace(/[^\d]/g, '');
    console.log(`\n3. Outgoing message to …${recipient.slice(-4)}`);
    try {
      const wamid = arg('template') !== null
        ? await sendMessage(config, recipient, { type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } })
        : await sendTextMessage(config, recipient, arg('text') || 'Botella Aura test message — WhatsApp Cloud API is connected.');
      ok(`Meta accepted the message (HTTP 200). Message id: ${wamid}`);
      info('Accepted is not delivered: check the phone, or the webhook status (sent → delivered → read).');
    } catch (err) {
      failed = true;
      if (err instanceof WhatsAppApiError) {
        bad(`Meta refused it: code ${err.code}, HTTP ${err.httpStatus ?? 'n/a'}, retryable ${err.retryable} — ${err.message}`);
        if (err.code === '131047') info('No open 24-hour window: send any message to the test number from this phone first, or run again with --template.');
        if (err.code === '131030') info('Add and verify this number under WhatsApp → API Setup → "To" → Manage phone number list.');
        if (err.code === '190') info('Copy a fresh temporary token from WhatsApp → API Setup into WHATSAPP_ACCESS_TOKEN.');
      } else {
        bad(err instanceof Error ? err.message : String(err));
      }
    }
  } else {
    info('No --to given: no message sent.');
  }

  console.log(failed ? '\nNot connected yet — see the FAILED lines.' : '\nMeta answered successfully for every step that ran.');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
