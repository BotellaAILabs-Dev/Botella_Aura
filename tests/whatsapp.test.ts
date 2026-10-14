import { describe, it, expect } from 'vitest';

import {
  clampText,
  contentSummary,
  fitContent,
  INTERACTIVE_LIMITS,
  toApiMessage,
  MAX_TEXT_LENGTH,
  missingConfig,
  normalizeWaId,
  optKeyword,
  parseWebhook,
  shouldApplyStatus,
  signPayload,
  verifySignature,
  verifySubscription,
  whatsAppConfig,
  withinServiceWindow,
} from '@/lib/whatsapp';

/**
 * WhatsApp Assistant, Phase 1 — the pure layer: Meta's webhook handshake and
 * signatures, payload parsing, delivery-status ordering, the 24-hour window,
 * opt-out, and what the assistant says.
 */

import { PHONE_ID, SECRET, textWebhook } from './fixtures/whatsapp';

describe('webhook subscription (GET)', () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o);

  it('echoes the challenge for our verify token', () => {
    expect(
      verifySubscription(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '12345' }), 'tok'),
    ).toBe('12345');
  });

  it('refuses a wrong token, a wrong mode, or no challenge', () => {
    expect(verifySubscription(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' }), 'tok')).toBeNull();
    expect(verifySubscription(q({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'tok', 'hub.challenge': '1' }), 'tok')).toBeNull();
    expect(verifySubscription(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok' }), 'tok')).toBeNull();
    expect(verifySubscription(q({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }), '')).toBeNull();
  });
});

describe('webhook signatures (POST)', () => {
  const raw = JSON.stringify(textWebhook());

  it('accepts the body Meta signed with our app secret', () => {
    expect(verifySignature(raw, signPayload(raw, SECRET), SECRET)).toBe(true);
  });

  it('rejects a tampered body, another secret, a missing or malformed header', () => {
    const sig = signPayload(raw, SECRET);
    expect(verifySignature(raw.replace('ABC', 'XYZ'), sig, SECRET)).toBe(false);
    expect(verifySignature(raw, signPayload(raw, 'other'), SECRET)).toBe(false);
    expect(verifySignature(raw, null, SECRET)).toBe(false);
    expect(verifySignature(raw, sig.replace('sha256=', 'sha1='), SECRET)).toBe(false);
    expect(verifySignature(raw, 'sha256=short', SECRET)).toBe(false);
    expect(verifySignature(raw, sig, '')).toBe(false);
  });

  it('is over the raw bytes — re-serialised JSON does not verify', () => {
    const pretty = JSON.stringify(JSON.parse(raw), null, 2);
    expect(verifySignature(pretty, signPayload(raw, SECRET), SECRET)).toBe(false);
  });
});

describe('parseWebhook', () => {
  it('reads a text message with the sender’s profile name and Meta’s time', () => {
    const p = parseWebhook(textWebhook({ timestamp: 1_760_000_000 }), PHONE_ID);
    expect(p.messages).toEqual([
      {
        wamid: 'wamid.IN1',
        waId: '919876543210',
        profileName: 'Asha Rao',
        type: 'text',
        text: 'What time does ABC Store open?',
        replyId: null,
        occurredAt: new Date(1_760_000_000_000),
      },
    ]);
    expect(p.statuses).toEqual([]);
  });

  it('ignores changes for another phone number on the same account', () => {
    const p = parseWebhook(textWebhook({ phoneNumberId: '999' }), PHONE_ID);
    expect(p.messages).toEqual([]);
    expect(p.ignored).toBe(1);
  });

  it('reads button and list replies as text; media has no text', () => {
    const body = textWebhook();
    const value = body.entry[0]!.changes[0]!.value as Record<string, unknown>;
    value.messages = [
      { from: '919876543210', id: 'w1', timestamp: '1', type: 'button', button: { text: 'Opening hours' } },
      { from: '919876543210', id: 'w2', timestamp: '1', type: 'interactive', interactive: { list_reply: { id: 'x', title: 'Offers' } } },
      { from: '919876543210', id: 'w3', timestamp: '1', type: 'image', image: { id: 'media1' } },
    ];
    const p = parseWebhook(body, PHONE_ID);
    expect(p.messages.map((m) => [m.type, m.text, m.replyId])).toEqual([
      ['button', 'Opening hours', null],
      ['interactive', 'Offers', 'x'],
      ['image', null, null],
    ]);
  });

  it('reads delivery statuses, with the failure reason; unknown statuses are skipped', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: PHONE_ID },
                statuses: [
                  { id: 'wamid.OUT1', status: 'delivered', timestamp: '1760000000', recipient_id: '9198' },
                  {
                    id: 'wamid.OUT2',
                    status: 'failed',
                    timestamp: '1760000001',
                    errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'Window closed' } }],
                  },
                  { id: 'wamid.OUT3', status: 'deleted', timestamp: '1' },
                ],
              },
            },
          ],
        },
      ],
    };
    const p = parseWebhook(body, PHONE_ID);
    expect(p.statuses).toEqual([
      { wamid: 'wamid.OUT1', status: 'delivered', occurredAt: new Date(1_760_000_000_000), error: null },
      {
        wamid: 'wamid.OUT2',
        status: 'failed',
        occurredAt: new Date(1_760_000_001_000),
        error: { code: '131047', message: 'Window closed' },
      },
    ]);
  });

  it('ignores other objects and other fields', () => {
    expect(parseWebhook({ object: 'page', entry: [] }, PHONE_ID).messages).toEqual([]);
    const other = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'account_update', value: {} }] }] };
    expect(parseWebhook(other, PHONE_ID)).toEqual({ messages: [], statuses: [], ignored: 0 });
  });

  it('rejects a payload that is not Meta’s shape', () => {
    expect(() => parseWebhook({ hello: 'world' }, PHONE_ID)).toThrow();
  });
});

describe('rules', () => {
  it('statuses never move backwards, and a failure is final', () => {
    expect(shouldApplyStatus('PENDING', 'SENT')).toBe(true);
    expect(shouldApplyStatus('SENT', 'DELIVERED')).toBe(true);
    expect(shouldApplyStatus('DELIVERED', 'READ')).toBe(true);
    expect(shouldApplyStatus('READ', 'DELIVERED')).toBe(false);
    expect(shouldApplyStatus('SENT', 'SENT')).toBe(false);
    expect(shouldApplyStatus('READ', 'FAILED')).toBe(true);
    expect(shouldApplyStatus('FAILED', 'READ')).toBe(false);
  });

  it('free-form replies only within 24 hours of their last message', () => {
    const now = new Date('2026-10-14T12:00:00Z');
    expect(withinServiceWindow(new Date('2026-10-14T11:00:00Z'), now)).toBe(true);
    expect(withinServiceWindow(new Date('2026-10-13T12:00:01Z'), now)).toBe(true);
    expect(withinServiceWindow(new Date('2026-10-13T12:00:00Z'), now)).toBe(false);
    expect(withinServiceWindow(null, now)).toBe(false);
  });

  it('recognises opt-out and opt-in, and nothing else', () => {
    expect(optKeyword('stop')).toBe('stop');
    expect(optKeyword(' Unsubscribe! ')).toBe('stop');
    expect(optKeyword('START')).toBe('start');
    expect(optKeyword('please stop sending offers')).toBeNull();
    expect(optKeyword(null)).toBeNull();
  });

  it('WhatsApp ids are digits; text fits WhatsApp’s limit', () => {
    expect(normalizeWaId('+91 98765-43210')).toBe('919876543210');
    expect(normalizeWaId('12')).toBeNull();
    expect(clampText('x'.repeat(5000)).length).toBe(MAX_TEXT_LENGTH);
    expect(clampText('  hi  ')).toBe('hi');
  });

  it('configuration needs all four values; the API version has a default', () => {
    expect(missingConfig({})).toEqual([
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_VERIFY_TOKEN',
    ]);
    expect(whatsAppConfig({ WHATSAPP_ACCESS_TOKEN: 'a' })).toBeNull();
    const c = whatsAppConfig({
      WHATSAPP_ACCESS_TOKEN: 'a',
      WHATSAPP_PHONE_NUMBER_ID: 'p',
      WHATSAPP_APP_SECRET: 's',
      WHATSAPP_VERIFY_TOKEN: 'v',
    });
    expect(c?.apiVersion).toBe('v23.0');
  });
});

describe('interactive content (Meta’s limits)', () => {
  it('fits buttons: at most 3, titles shortened, text clamped', () => {
    const c = fitContent({
      kind: 'buttons',
      body: 'x'.repeat(2000),
      buttons: [
        { id: 'a', title: 'A very long button title indeed' },
        { id: 'b', title: 'B' },
        { id: 'c', title: 'C' },
        { id: 'd', title: 'D' },
      ],
      header: 'h'.repeat(100),
    });
    if (c.kind !== 'buttons') throw new Error('kind');
    expect(c.buttons.map((b) => b.id)).toEqual(['a', 'b', 'c']);
    expect(c.buttons[0]!.title.length).toBeLessThanOrEqual(INTERACTIVE_LIMITS.buttonTitle);
    expect(c.body.length).toBeLessThanOrEqual(INTERACTIVE_LIMITS.body);
    expect(c.header!.length).toBeLessThanOrEqual(INTERACTIVE_LIMITS.header);
  });

  it('fits lists: at most 10 rows across sections, in order; empty sections dropped', () => {
    const rows = (p: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, title: `${p} option ${i} with a long name`, description: 'd'.repeat(100) }));
    const c = fitContent({
      kind: 'list',
      body: 'Pick one',
      button: 'Open the Aura menu now',
      sections: [{ title: 'First', rows: rows('a', 7) }, { title: 'Second', rows: rows('b', 7) }, { title: 'Third', rows: rows('c', 2) }],
    });
    if (c.kind !== 'list') throw new Error('kind');
    const ids = c.sections.flatMap((s) => s.rows.map((r) => r.id));
    expect(ids).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'b0', 'b1', 'b2']);
    expect(c.sections.map((s) => s.title)).toEqual(['First', 'Second']);
    expect(c.button.length).toBeLessThanOrEqual(INTERACTIVE_LIMITS.listButton);
    for (const r of c.sections.flatMap((s) => s.rows)) {
      expect(r.title.length).toBeLessThanOrEqual(INTERACTIVE_LIMITS.rowTitle);
      expect(r.description!.length).toBeLessThanOrEqual(INTERACTIVE_LIMITS.rowDescription);
    }
  });

  it('refuses what Meta would reject: no options, duplicate ids, untitled sections', () => {
    expect(() => fitContent({ kind: 'buttons', body: 'x', buttons: [] })).toThrow();
    expect(() => fitContent({ kind: 'buttons', body: 'x', buttons: [{ id: 'a', title: '1' }, { id: 'a', title: '2' }] })).toThrow(/unique/);
    expect(() => fitContent({ kind: 'list', body: 'x', button: 'b', sections: [{ rows: [] }] })).toThrow();
    expect(() =>
      fitContent({ kind: 'list', body: 'x', button: 'b', sections: [{ rows: [{ id: '1', title: 'a' }] }, { rows: [{ id: '2', title: 'b' }] }] }),
    ).toThrow(/title/);
  });

  it('builds the Cloud API body; an image needs its link', () => {
    expect(toApiMessage({ kind: 'text', text: 'hi' })).toEqual({ type: 'text', text: { preview_url: false, body: 'hi' } });
    expect(toApiMessage({ kind: 'image', assetId: 'a', caption: 'c' }, 'https://x/img')).toEqual({
      type: 'image',
      image: { link: 'https://x/img', caption: 'c' },
    });
    expect(() => toApiMessage({ kind: 'image', assetId: 'a' })).toThrow();
    const list = toApiMessage({ kind: 'list', body: 'b', button: 'Menu', sections: [{ rows: [{ id: '1', title: 'One' }] }] });
    expect(list).toMatchObject({ type: 'interactive', interactive: { type: 'list', action: { button: 'Menu', sections: [{ rows: [{ id: '1', title: 'One' }] }] } } });
  });

  it('keeps paragraphs in message bodies; titles stay on one line', () => {
    const c = fitContent({
      kind: 'buttons',
      body: 'Welcome!\n\n\n\nYour  assistant.\r\nLine two',
      buttons: [{ id: 'a', title: 'Two\nlines' }],
    });
    if (c.kind !== 'buttons') throw new Error('kind');
    expect(c.body).toBe('Welcome!\n\nYour assistant.\nLine two');
    expect(c.buttons[0]!.title).toBe('Two lines');
  });

  it('a link button only takes https links', () => {
    expect(() => fitContent({ kind: 'cta', body: 'x', buttonText: 'Go', url: 'javascript:alert(1)' })).toThrow(/https/);
    expect(() => fitContent({ kind: 'cta', body: 'x', buttonText: 'Go', url: 'http://evil.example/' })).toThrow(/https/);
    const c = fitContent({ kind: 'cta', body: 'x', buttonText: 'A very long button label', url: 'https://aura.example/x' });
    expect(c.kind === 'cta' && c.buttonText.length).toBeLessThanOrEqual(20);
    expect(toApiMessage(c)).toMatchObject({
      type: 'interactive',
      interactive: { type: 'cta_url', action: { name: 'cta_url', parameters: { url: 'https://aura.example/x' } } },
    });
    expect(contentSummary(c)).not.toContain('aura.example');
  });

  it('summarises content for the history', () => {
    expect(contentSummary({ kind: 'image', assetId: 'a', caption: 'Diwali post' })).toBe('[image] Diwali post');
    expect(contentSummary({ kind: 'list', body: 'Pick', button: 'Menu', sections: [{ rows: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }] }] })).toBe('Pick\n[Menu: One, Two]');
  });
});
