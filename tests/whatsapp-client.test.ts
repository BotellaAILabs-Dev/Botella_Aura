import { describe, it, expect, afterEach } from 'vitest';

/**
 * The WhatsApp access token goes with every Graph request, so the load-test
 * host override (WHATSAPP_GRAPH_BASE_URL) may only point at this machine.
 */

import { sendMessage } from '@/server/whatsapp/client';

const config = { accessToken: 'EAAG-secret', phoneNumberId: '123', appSecret: 's', verifyToken: 'v', apiVersion: 'v23.0' };

async function hostUsed(): Promise<string> {
  let url = '';
  const fetchImpl = (async (u: string) => {
    url = String(u);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  await sendMessage(config, '15550001111', { type: 'text', text: { body: 'hi' } } as any, { fetchImpl });
  return new URL(url).origin;
}

afterEach(() => {
  delete process.env.WHATSAPP_GRAPH_BASE_URL;
});

describe('Graph host', () => {
  it('Meta by default', async () => {
    expect(await hostUsed()).toBe('https://graph.facebook.com');
  });

  it('a loopback override is used (load tests)', async () => {
    process.env.WHATSAPP_GRAPH_BASE_URL = 'http://localhost:4010';
    expect(await hostUsed()).toBe('http://localhost:4010');
  });

  it('any other host is ignored — the token is never sent elsewhere', async () => {
    for (const bad of ['https://evil.example', 'http://10.0.0.5:4010', 'not a url']) {
      process.env.WHATSAPP_GRAPH_BASE_URL = bad;
      expect(await hostUsed()).toBe('https://graph.facebook.com');
    }
  });
});
