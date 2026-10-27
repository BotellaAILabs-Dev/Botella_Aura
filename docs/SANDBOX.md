# The sandbox: WhatsApp, Facebook and Instagram on one machine

```
npm run sandbox                      the stand-in and the app, wired together
npm run sandbox check                prove all three work, end to end
npm run sandbox say "<message>"      send a WhatsApp message, see the reply
npm run sandbox script               the scripted demo conversation
```

The app serves on `http://localhost:3001`, the Meta stand-in on
`http://localhost:4010`. Sign in as `demo@botella.ai` / `Password123`.

---

## 1. Why it exists

The three Meta integrations cannot be exercised on a laptop. Between them they
need a Meta app, a WhatsApp number Meta has approved, a Facebook Page, an
Instagram professional account linked to that Page, a public HTTPS URL for the
webhook, and an access token that expires in about 24 hours.

So one thing is replaced — Meta — and everything on Aura's side of that line
stays real:

| Real here | Not real here |
| --- | --- |
| the webhook signature check (`X-Hub-Signature-256`) | Meta's servers |
| the queue, the worker, the natural-language router | a phone receiving a message |
| the approval gate and the content-intact check | a post appearing on a Page |
| execution routing, permission and health checks | Meta's own validation of our payloads |
| the page-token exchange | a token that expires |
| the Instagram container → poll → publish cycle | Instagram fetching the image |
| what is recorded afterwards, and what the UI shows | |

**What it does not prove: that Meta accepts this traffic.** Nothing leaves the
machine. `npm run sandbox check` says so in its own output rather than letting a
green run imply otherwise. For the real thing you need the credentials in
[docs/META-APP-SETUP.md](META-APP-SETUP.md), then `npm run verify:meta` and
`npm run demo:whatsapp`.

---

## 2. The one rule that makes it safe

Two environment variables redirect the Graph API: `WHATSAPP_GRAPH_BASE_URL` and
`META_GRAPH_BASE_URL`. Every Graph request carries an access token, so a wrong
value in either would hand a business's token to whatever host was named, or
post as them.

Both are therefore honoured **only when they point at this machine**
(`lib/graph-base.ts`). Anything else is ignored in favour of `graph.facebook.com`
— including the strings that look local and are not:

| Value | Used |
| --- | --- |
| `http://localhost:4010`, `http://127.0.0.1:4010`, `http://[::1]:4010` | yes |
| `http://localhost.evil.example.com` | no — Meta |
| `http://notlocalhost` | no — Meta |
| `http://10.0.0.5:4010`, `http://192.168.1.9:4010` | no — Meta (the LAN is not this machine) |
| `localhost:4010` (no scheme) | no — Meta |

Those cases are pinned in `tests/graph-base.test.ts`. An ignored override is
also *not* reported as a sandbox, because a warning saying "traffic is local"
while it goes to Meta is the one wrong way round that matters.

`npm run env:check` warns when either is set. `env:check --production` makes it
an **error**: in production it would mean nothing is actually published while
the dashboard still reports success.

---

## 3. What the stand-in answers

`scripts/load/meta-stub.ts`, on `STUB_PORT` (default 4010). It also predates
the sandbox as the load-test target, and that behaviour is unchanged.

**WhatsApp** — `POST /:v/:phoneNumberId/messages`, answering after 80–200 ms.
`STUB_ERROR_RATE` (default `0.02`) of sends return Meta's throughput error
130429, so the retry path is exercised.

**Facebook Pages** — `me`, `me/accounts` (a Page with a page token and the
linked Instagram account), `me/permissions`, `oauth/access_token`,
`:pageId/feed` and `:pageId/photos`. A photo post returns both the photo id and
the story's `post_id`, as Meta does, because the app prefers the story.

**Instagram** — `:igUserId/media`, then `:containerId?fields=status_code` which
stays `IN_PROGRESS` for `STUB_IG_PROCESSING_MS` (default 1200) so the real
polling runs, then `:igUserId/media_publish`. Publishing a container early, or
twice, is refused exactly as Meta refuses it.

**Both** — `:objectId?fields=…` for permalinks, like counts and insights.

**Its own, not Meta's** — `GET /stats`, `GET /sent?to=<number>`,
`GET /published[?kind=facebook|instagram]`, `POST /reset`.

### Knobs

| Variable | Default | What it does |
| --- | --- | --- |
| `STUB_PORT` | `4010` | the port |
| `STUB_ERROR_RATE` | `0.02` | WhatsApp sends that return 130429 |
| `STUB_META_ERROR_RATE` | `0` | publish calls that fail; opt-in, so a demo is not random |
| `STUB_IG_PROCESSING_MS` | `1200` | how long an Instagram container stays unready |
| `STUB_PAGE_ID` / `STUB_PAGE_NAME` | `111111111111111` / `Sandbox Page` | the Page it answers for |
| `STUB_IG_USER_ID` / `STUB_IG_USERNAME` | `222222222222222` / `sandbox.ig` | the Instagram account |
| `STUB_GRANTED_SCOPES` | all of `META_SCOPES` | drop one to see a permission gap |

---

## 4. What `npm run sandbox check` asserts

`scripts/verify-sandbox.ts`, then the WhatsApp loop
(`scripts/demo-whatsapp-local.ts`):

1. **Wiring** — the stand-in answers; this process is pointed at it; a base URL
   that is not this machine is refused; loopback spellings are accepted.
2. **Facebook** — a text post and a photo post publish through the real
   publisher; both arrive at the Page with the copy byte-for-byte as approved;
   the photo post reports the story rather than the photo; the permalink comes
   back.
3. **Instagram** — the container is created, polled and published, with the
   approved caption and a signed, app-served image URL.
4. **The approval gate** — `publishDraft` refuses a draft that is not APPROVED,
   even with a working connection.
5. **WhatsApp** — a signed inbound message goes through the signature check,
   the queue, the worker and the router, and the reply is read back off the
   stand-in; no message is answered twice.

The publish checks call `publishTo` (the per-network mechanic, which is what a
sandbox exists to exercise). The gate check calls `publishDraft`, one layer up,
because that is where the gate lives — asserting it against the mechanic would
say nothing about either.

---

## 5. Two modes, and which suite belongs to which

The sandbox and "real Meta" are mutually exclusive, because they test opposite
things. Neither is a substitute for the other.

| | a plain `npm run dev` | `npm run sandbox` |
| --- | --- | --- |
| Graph calls go to | Meta | the stand-in |
| A made-up token is | refused | accepted |
| What can be checked | that Aura never claims a publish that did not happen | that publishing works at all |
| Suites | `verify:meta`, `verify:connections`, `verify:instagram-api`, `verify:one-click` | `sandbox check` (`verify:sandbox` + the WhatsApp loop) |

The four refusal suites ask the app which mode it is in — `graphStub` on
`GET /api/connectors/preflight` — and stop with an explanation and exit code 2
rather than reporting failures that are only the wrong mode
(`scripts/lib/meta-mode.ts`). `verify:one-click` publishes in-process, so it
checks its own environment instead of the app's.

So: run the whole verify suite against a plain dev server, and
`npm run sandbox check` against the sandbox. Running everything in one shell
with `META_GRAPH_BASE_URL` set is what the guard exists to catch.

---

## 6. Pointing it at a different workspace

The check makes its own throwaway workspace and deletes it afterwards. To watch
it in the UI instead, connect Meta by hand with the stand-in's ids: a
`Connection` with `connectorId: 'meta'`, `metadata.pageId` =
`STUB_PAGE_ID`, `metadata.igUserId` = `STUB_IG_USER_ID`, and
`scopes` = `META_SCOPES`. `scripts/verify-sandbox.ts` builds exactly that, and
is the shortest reference for the shape.
