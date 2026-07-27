# Botella Aura — Chrome Extension (v1)

The **action layer**. Every LinkedIn action in Botella Aura happens here —
executed by a real logged-in human clicking a real button in their own browser.
The backend never logs into LinkedIn, never stores LinkedIn cookies, and never
automates clicks or requests to linkedin.com. This extension only:

1. reads a queue of **approved** items the backend prepared,
2. **inserts** the approved text into LinkedIn's own composer when you click, and
3. syncs status back to Botella Aura after **you** post it.

It never auto-sends, never loops, never runs on a timer, and enforces a
client-side rate cap so even a power user can't behave like a bot.

## Architecture

```
manifest.json          MV3 manifest (permissions, content scripts, worker)
background.js          Service worker — holds the token, calls the API,
                       enforces the client-side rate cap (single API choke-point)
popup.html/.js/.css    Pair (paste token), see status + usage, disconnect
content/pairing.js     Runs on the Aura web origin — receives the token from the
                       settings page via window.postMessage
content/linkedin.js    Runs on linkedin.com — the action panel (insert + confirm)
content/linkedin.css   Panel styles (namespaced .aura-*)
```

### Auth
The extension authenticates with a **separate, revocable, workspace-scoped
bearer token** (`aura_ext_…`) — NOT your web session or password. The server
stores only a SHA-256 hash of it. It authorizes **only** the `/api/extension/*`
endpoints (read queue, sync action status), never your full account. Revoke it
anytime from **Settings → Browser extension → Disconnect**.

## Local development

1. Run the Botella Aura web app locally (`pnpm dev` → http://localhost:3000).
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select this `extension/` folder.
4. In the web app, go to **Settings → Browser extension**, click **Generate
   pairing token**, then either:
   - click **Send to extension** (uses `window.postMessage`; the `pairing.js`
     content script stores it automatically), or
   - copy the token and paste it into the extension popup.
5. Open LinkedIn and click the floating **✦ Aura** button (bottom-right) to see
   your approved items (posts from Content Studio, outreach messages). Click
   **Insert into composer**, review, click LinkedIn's own **Post/Send** button
   yourself, then **Mark as posted**.
6. **Engagement Copilot:** while viewing a post, open the panel and click
   **Draft a comment for this post**. The extension reads only the post text
   already rendered on your screen, sends it up for an on-brand draft, and you
   insert it into LinkedIn's own comment box and post it yourself. No server-side
   LinkedIn fetch happens — the post text is captured client-side.

### Pointing at a deployed backend
Pairing via **Send to extension** automatically pins the API base to whatever
origin you paired from. To set it manually, use the popup's **Advanced → Botella
Aura URL** field. For a published extension, pin the allowed origin server-side
with `EXTENSION_ALLOWED_ORIGIN`.

## Build / packaging

v1 is plain JS/CSS with **no bundler** — load the folder directly. To produce a
distributable zip:

```bash
cd extension && npm run zip     # → botella-aura-extension.zip
```

## Production build & Chrome Web Store submission

v1 is plain JS/CSS with no bundler, so the "production build" is just a zip of the
loadable folder:

```bash
cd extension && npm run zip     # → botella-aura-extension.zip
```

Before submitting to the Chrome Web Store (a manual, one-time step outside this
repo), check:

- [ ] **Pin the API origin** — set `EXTENSION_ALLOWED_ORIGIN` on the backend to
      the published extension id, and set the extension's default API base to the
      production URL (popup → Advanced, or bake it into `background.js`).
- [ ] **Host permissions** — `manifest.json` requests only `*.linkedin.com` and
      the Botella Aura origin(s). Replace the `localhost` host with your
      production domain for the store build.
- [ ] **Icons** — add 16/48/128px PNG icons and reference them in `manifest.json`
      (`icons` + `action.default_icon`). The store requires them.
- [ ] **Privacy policy URL** + a clear store description of the single narrow
      purpose ("review and send your approved Botella Aura items on LinkedIn").
- [ ] **Permissions justification** — `storage` (token + rate state), `activeTab`,
      and the host permissions above. No `tabs`, no broad `<all_urls>`.
- [ ] **Data-use disclosure** — the extension reads only content already rendered
      on the user's own screen and sends the user's approved text; it never
      collects browsing data. State this in the store listing.
- [ ] Screenshots of the action panel + popup.

Submission itself (developer account, review) is a manual follow-up.

## Safety guarantees (do not remove)

- No server-side LinkedIn access anywhere. The panel only reads what the backend
  prepared and what LinkedIn already rendered to your own screen.
- One human click per action. No loops, no timers, no auto-submit.
- Client-side rate cap (`background.js`) mirrored by a server-side cap.
- Token is revocable and scoped to `/api/extension/*` only.
