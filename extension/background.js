/**
 * Botella Aura extension — background service worker (MV3).
 *
 * The single place the extension talks to the Botella Aura API. Holds the
 * extension-scoped bearer token (chrome.storage.local), performs all fetches,
 * and enforces the CLIENT-SIDE rate cap (a hard requirement — this is what keeps
 * even a power user from behaving like a bot). Content scripts and the popup
 * never call the API directly; they message this worker.
 */

const DEFAULT_API_BASE = 'http://localhost:3000';

// Client-side rate caps. Mirror lib/extension-constants.ts on the server.
const HOURLY_CAP = 8;
const DAILY_CAP = 25;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

async function getState() {
  const { token, apiBase } = await chrome.storage.local.get(['token', 'apiBase']);
  return { token: token || null, apiBase: apiBase || DEFAULT_API_BASE };
}

async function apiFetch(path, options = {}) {
  const { token, apiBase } = await getState();
  if (!token) return { ok: false, status: 401, data: { error: 'Not paired.' } };
  let res;
  try {
    res = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    return { ok: false, status: 0, data: { error: 'Network error — is Botella Aura running?' } };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ---- client-side rate limiter -------------------------------------------

async function getActionLog() {
  const { actionLog } = await chrome.storage.local.get('actionLog');
  const now = Date.now();
  // Prune anything older than a day.
  return (actionLog || []).filter((t) => now - t < DAY_MS);
}

async function rateUsage() {
  const log = await getActionLog();
  const now = Date.now();
  const hourly = log.filter((t) => now - t < HOUR_MS).length;
  const daily = log.length;
  return { hourly, daily, hourlyCap: HOURLY_CAP, dailyCap: DAILY_CAP };
}

async function recordAction() {
  const log = await getActionLog();
  log.push(Date.now());
  await chrome.storage.local.set({ actionLog: log });
}

async function checkRate() {
  const u = await rateUsage();
  if (u.hourly >= u.hourlyCap) {
    return { allowed: false, reason: `Hourly safety cap reached (${u.hourlyCap}/hr). Give it a little while.` };
  }
  if (u.daily >= u.dailyCap) {
    return { allowed: false, reason: `Daily safety cap reached (${u.dailyCap}/day). This keeps your account healthy.` };
  }
  return { allowed: true };
}

// ---- message hub ---------------------------------------------------------

async function handle(msg) {
  switch (msg.type) {
    case 'AURA_GET_STATE': {
      const { token, apiBase } = await getState();
      return { hasToken: Boolean(token), apiBase };
    }
    case 'AURA_SET_TOKEN': {
      if (!msg.token || !String(msg.token).startsWith('aura_ext_')) {
        return { ok: false, error: 'That does not look like a Botella Aura token.' };
      }
      await chrome.storage.local.set({ token: msg.token });
      return { ok: true };
    }
    case 'AURA_SET_CONFIG': {
      await chrome.storage.local.set({ apiBase: msg.apiBase || DEFAULT_API_BASE });
      return { ok: true };
    }
    case 'AURA_DISCONNECT': {
      await chrome.storage.local.remove(['token', 'actionLog']);
      return { ok: true };
    }
    case 'AURA_STATUS': {
      const r = await apiFetch('/api/extension/status');
      const rate = await rateUsage();
      return { ok: r.ok, status: r.status, data: r.data, rate };
    }
    case 'AURA_QUEUE': {
      const r = await apiFetch('/api/extension/queue');
      return { ok: r.ok, status: r.status, data: r.data };
    }
    case 'AURA_RATE': {
      return await rateUsage();
    }
    case 'AURA_SYNC_METRICS': {
      // Sync REAL metrics the user can see on their own post page. Not an
      // outbound action, so it is not counted against the send rate cap.
      const r = await apiFetch('/api/extension/metrics', {
        method: 'POST',
        body: JSON.stringify({
          postUrl: msg.postUrl,
          ...(msg.likes != null ? { likes: msg.likes } : {}),
          ...(msg.comments != null ? { comments: msg.comments } : {}),
          ...(msg.reposts != null ? { reposts: msg.reposts } : {}),
        }),
      });
      return { ok: r.ok, status: r.status, data: r.data };
    }
    case 'AURA_ENGAGE_DRAFT': {
      // Draft a comment for a post the user is already viewing. The post text is
      // captured client-side and sent up; the backend never reads LinkedIn.
      const r = await apiFetch('/api/extension/engagement/draft', {
        method: 'POST',
        body: JSON.stringify({
          postUrl: msg.postUrl,
          postText: msg.postText,
          ...(msg.author ? { author: msg.author } : {}),
        }),
      });
      return { ok: r.ok, status: r.status, data: r.data };
    }
    case 'AURA_COMPLETE': {
      const gate = await checkRate();
      if (!gate.allowed) return { ok: false, rateLimited: true, error: gate.reason };
      const r = await apiFetch('/api/extension/actions/complete', {
        method: 'POST',
        body: JSON.stringify({
          itemType: msg.itemType,
          itemId: msg.itemId,
          ...(msg.postedUrl ? { postedUrl: msg.postedUrl } : {}),
        }),
      });
      if (r.ok) await recordAction();
      return { ok: r.ok, status: r.status, data: r.data };
    }
    default:
      return { ok: false, error: `Unknown message: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // keep the message channel open for the async response
});
