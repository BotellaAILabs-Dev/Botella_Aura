/** Botella Aura extension popup — pairing + status UI. */
const msg = (m) => new Promise((resolve) => chrome.runtime.sendMessage(m, resolve));
const $ = (id) => document.getElementById(id);

async function boot() {
  const state = await msg({ type: 'AURA_GET_STATE' });
  if (state && state.apiBase) $('apiBase').value = state.apiBase;
  if (state && state.hasToken) {
    await showConnected();
  } else {
    showPair();
  }
}

function showPair() {
  $('pair').classList.remove('hidden');
  $('connected').classList.add('hidden');
  $('dot').className = 'dot dot-off';
}

async function showConnected() {
  $('pair').classList.add('hidden');
  $('connected').classList.remove('hidden');

  const res = await msg({ type: 'AURA_STATUS' });
  if (!res || !res.ok) {
    // Token invalid/revoked — drop back to pairing.
    if (res && res.status === 401) {
      await msg({ type: 'AURA_DISCONNECT' });
      showPair();
      setMsg('That token is invalid or was revoked. Please re-pair.', true);
    }
    $('dot').className = 'dot dot-off';
    return;
  }
  $('dot').className = 'dot dot-on';
  const d = res.data || {};
  $('company').textContent = d.company || '—';
  $('queue').textContent = d.queueCount ?? '—';
  $('today').textContent = `${d.actionsToday ?? 0} / ${d.dailyCap ?? '—'}`;
  const rate = res.rate;
  if (rate) {
    $('usage').textContent = `Healthy usage — ${rate.daily}/${rate.dailyCap} today · ${rate.hourly}/${rate.hourlyCap} this hour`;
  }
}

function setMsg(text, isError) {
  const el = $('pairMsg');
  el.textContent = text;
  el.className = `msg ${isError ? 'msg-err' : 'msg-ok'}`;
}

$('save').addEventListener('click', async () => {
  const token = $('token').value.trim();
  if (!token) return setMsg('Paste your pairing token first.', true);
  const res = await msg({ type: 'AURA_SET_TOKEN', token });
  if (!res || !res.ok) return setMsg((res && res.error) || 'Could not save token.', true);
  $('token').value = '';
  setMsg('Paired!', false);
  await showConnected();
});

$('saveApi').addEventListener('click', async () => {
  const apiBase = $('apiBase').value.trim();
  await msg({ type: 'AURA_SET_CONFIG', apiBase });
  setMsg('Saved.', false);
});

$('disconnect').addEventListener('click', async () => {
  await msg({ type: 'AURA_DISCONNECT' });
  showPair();
  setMsg('Disconnected. Your token was removed from this browser.', false);
});

$('openLi').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.linkedin.com/feed/' });
});

boot();
