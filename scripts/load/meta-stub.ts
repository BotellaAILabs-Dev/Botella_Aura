/**
 * A stand-in for Meta's WhatsApp Cloud API, for load tests only
 * (scripts/load/whatsapp-load.ts). The app is pointed at it with
 * WHATSAPP_GRAPH_BASE_URL — thousands of test replies must not go to Meta.
 *
 *   POST /:version/:phoneNumberId/messages   a send (or a read receipt):
 *        answers like the Cloud API after 80–200 ms; STUB_ERROR_RATE of sends
 *        (default 2%) get Meta's throughput error 130429, so retries are exercised
 *   GET  /stats                               what it received
 *   GET  /sent?to=<number>                    the last messages sent to a number
 *        (verify suites read a one-time link from here: once a link is
 *        sent, the app keeps only "[sent]" in its own history)
 *   POST /reset                               clear the counters
 *
 * Run: npx tsx scripts/load/meta-stub.ts   (port STUB_PORT, default 4010)
 */
import http from 'node:http';

/** Recent sends, for the verify suites (bounded). */
const sent: { to: string; body: unknown; at: number }[] = [];
const PORT = Number(process.env.STUB_PORT ?? 4010);
const ERROR_RATE = Number(process.env.STUB_ERROR_RATE ?? 0.02);

let stats = { sends: 0, reads: 0, rateLimited: 0, unauthorised: 0, inFlight: 0, maxInFlight: 0, byContext: {} as Record<string, number> };
let seq = 0;

const server = http.createServer((req, res) => {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/stats') {
    const dupes = Object.values(stats.byContext).filter((n) => n > 1).length;
    return json(200, { ...stats, byContext: undefined, threadedReplies: Object.keys(stats.byContext).length, inboundAnsweredMoreThanOnce: dupes });
  }
  if (req.method === 'GET' && req.url?.startsWith('/sent')) {
    const to = new URL(req.url, 'http://stub').searchParams.get('to')?.replace(/\D/g, '') ?? '';
    return json(200, { messages: sent.filter((m) => m.to === to).slice(-20) });
  }
  if (req.method === 'POST' && req.url === '/reset') {
    stats = { sends: 0, reads: 0, rateLimited: 0, unauthorised: 0, inFlight: 0, maxInFlight: 0, byContext: {} };
    return json(200, { ok: true });
  }
  if (req.method !== 'POST' || !/^\/v\d+\.\d+\/[^/]+\/messages$/.test(req.url ?? '')) return json(404, { error: { message: 'not found' } });

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (!req.headers.authorization?.startsWith('Bearer ')) {
      stats.unauthorised++;
      return json(401, { error: { code: 190, message: 'Invalid OAuth access token' } });
    }
    const body = JSON.parse(raw || '{}') as { status?: string; to?: string; context?: { message_id?: string } };
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    setTimeout(
      () => {
        stats.inFlight--;
        if (body.status === 'read') {
          stats.reads++;
          return json(200, { success: true });
        }
        if (Math.random() < ERROR_RATE) {
          stats.rateLimited++;
          return json(400, { error: { code: 130429, message: '(#130429) Rate limit hit' } });
        }
        stats.sends++;
        if (body.to) {
          sent.push({ to: String(body.to).replace(/\D/g, ''), body, at: Date.now() });
          if (sent.length > 500) sent.shift();
        }
        const ctx = body.context?.message_id;
        if (ctx) stats.byContext[ctx] = (stats.byContext[ctx] ?? 0) + 1;
        json(200, { messaging_product: 'whatsapp', contacts: [{ wa_id: 'x' }], messages: [{ id: `wamid.STUB${++seq}` }] });
      },
      80 + Math.random() * 120,
    );
  });
});

server.listen(PORT, () => console.log(`meta-stub listening on ${PORT} (error rate ${ERROR_RATE})`));
