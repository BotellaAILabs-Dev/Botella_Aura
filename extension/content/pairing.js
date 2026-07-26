/**
 * Pairing content script — runs ONLY on the Botella Aura web origin.
 *
 * The settings page (components/dashboard/extension/extension-manager.tsx) posts
 * a window.postMessage with the one-time token when the user clicks "Send to
 * extension". This script (running in the isolated content-script world on that
 * same page) receives it and hands it to the background worker, which stores it.
 * It also pins the extension's API base to this origin, so pairing from the
 * deployed site "just works" without any manual URL entry.
 */
window.addEventListener('message', (event) => {
  // Only accept messages from this same page/origin.
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;

  const data = event.data;
  if (
    !data ||
    data.source !== 'botella-aura' ||
    data.type !== 'AURA_EXT_TOKEN' ||
    typeof data.token !== 'string'
  ) {
    return;
  }

  chrome.runtime.sendMessage(
    { type: 'AURA_SET_CONFIG', apiBase: window.location.origin },
    () => {
      chrome.runtime.sendMessage(
        { type: 'AURA_SET_TOKEN', token: data.token },
        (res) => {
          window.postMessage(
            {
              source: 'botella-aura-ext',
              type: 'AURA_EXT_PAIRED',
              ok: Boolean(res && res.ok),
              error: res && res.error,
            },
            window.location.origin,
          );
        },
      );
    },
  );
});
