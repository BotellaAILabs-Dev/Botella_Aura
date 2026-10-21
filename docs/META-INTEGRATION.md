# Meta integration — Facebook Pages, Instagram, WhatsApp

How Botella Aura connects to Meta, what it asks for and why, and what to do
before App Review. Nothing here claims approval: until Meta approves the app,
everything works only for people with a role on the Meta app (development
mode).

| Piece | Where |
| --- | --- |
| Rules (scopes, Graph version, Pages, signed requests) | `lib/meta.ts` |
| Connector (OAuth, long-lived token, Page discovery) | `server/connectors/providers.ts` (`meta`) |
| Page choice, deauthorize, data deletion | `server/connectors/meta.service.ts` |
| Publishing | `server/media/publishers/facebook.ts`, `instagram.ts` |
| WhatsApp (separate product, same Meta app) | `server/whatsapp/*`, `docs` in `.env.example` |
| Tests | `tests/meta.test.ts` |

## 1. Login model

**Instagram API with Facebook Login.** One Facebook Login grants the Facebook
Page and the Instagram professional account linked to it. Aura publishes to
both, so this is one login and one permission model. "Instagram API with
Instagram Login" (`instagram_business_*` scopes) cannot post to Facebook
Pages, so it would mean a second login for the same business; the two are not
mixed.

Consequences, stated to users in the product:

- Instagram must be a **Business or Creator** account **linked to the
  Facebook Page**. Personal Instagram accounts cannot be linked to a Page and
  are never offered.
- A Page with no Instagram linked publishes to Facebook only.

## 2. Permissions and justifications

| Permission | Why Aura needs it | Used by |
| --- | --- | --- |
| `pages_show_list` | List the Pages the person manages so they choose which one Aura publishes to | Connect, Page picker |
| `pages_read_engagement` | Read the chosen Page; Meta also requires it for Instagram content publishing | Connect, publishing |
| `pages_manage_posts` | Publish the post (text and photo) the business approved in Aura to its Page | Facebook publishing |
| `instagram_basic` | Read the Instagram professional account linked to the Page (id, username) | Connect, Page picker |
| `instagram_content_publish` | Publish the approved post — an image, a carousel (2–10 images/videos) or a Reel — to that Instagram account | Instagram publishing |
| `business_management` | Pages owned through a Business Portfolio are only listed with it | Connect |

**Optional, for detailed analytics** (requested only when
`META_REQUEST_INSIGHTS=true`, after App Review):

| Permission | Why | Used by |
| --- | --- | --- |
| `read_insights` | Impressions, unique impressions and clicks of the posts Aura published to the Page | Organic analytics |
| `instagram_manage_insights` | Reach, views, shares and saves of the posts Aura published to Instagram | Organic analytics |

Without them Aura still reads reactions, comments and shares (Facebook) and
likes and comments (Instagram) with the permissions above.

Never requested (out of V1 scope): `pages_manage_metadata`, `ads_*`,
`instagram_manage_comments`, `instagram_manage_messages`, `pages_messaging`.

**Human approval is built in.** Nothing is published without an owner or
admin approving it in Aura first (docs/APPROVAL-MODEL.md); the approval
covers the exact text, network and images. This is worth saying in every
App Review justification.

## 2a. What is published to Instagram

| Attached to the post | Published as | API |
| --- | --- | --- |
| 1 image | Feed post | image container → `media_publish` |
| 1 video (MP4/MOV, H.264/HEVC, 3 s – 15 min) | **Reel** (also shown on the grid: `share_to_feed=true`) | `media_type=REELS` container → wait → `media_publish` |
| 2–10 images and/or videos | **Carousel**, in the attached order | one `is_carousel_item` container each → `media_type=CAROUSEL` container with `children` → `media_publish` |

- Images go to Meta as a short-lived signed link to Aura; videos as the
  file-storage URL (`ASSET_S3_*` must be set and publicly readable — videos
  are never stored in the database or streamed through the app).
- Instagram processes video for minutes. Aura waits about 30 seconds; if it
  is not ready, the publication is **PROCESSING** — not published — and the
  publish sweep (`/api/cron/publish`, and the more frequent
  `/api/cron/whatsapp`) or the open draft page finishes it. The person is
  told on WhatsApp when it is live or if Instagram rejected it. If the post
  is edited or its approval withdrawn meanwhile, it is not published.
  Instagram expires an unpublished container after 24 hours.
- Video is published to Instagram only. Facebook and LinkedIn get a plain
  "post it by hand" instead.
- Instagram's documented limit is 100 API-published posts per 24 hours per
  account (a carousel counts as one).
- Instagram's documentation states that JPEG is the only supported image
  format. Aura's PNG (and WebP) graphics are therefore served to Instagram
  re-encoded as JPEG (`server/media/jpeg.ts`, quality 90, transparency on
  white); the stored graphic is unchanged.

## 3. Tokens

- The code exchange returns a 1–2 hour user token. Aura immediately exchanges
  it (`grant_type=fb_exchange_token`) for the long-lived one (~60 days), and
  stores only that, encrypted (AES-256-GCM).
- Page tokens are never stored; the publishers derive a fresh one per post.
- Meta issues no refresh token. Aura warns 10 days before expiry (connector
  card and WhatsApp) and asks for a reconnect; reconnecting keeps the chosen
  Page.
- Graph API version: `META_GRAPH_VERSION`, default `v23.0`, in one place.

## 3a. OAuth protections (state, browser binding, PKCE)

- `state` is HMAC-signed, expires in 10 minutes, and names the workspace and
  the user; the callback also requires the same signed-in user with
  OWNER/ADMIN.
- **Browser binding (always on):** the start sets an encrypted, httpOnly
  cookie holding the state's nonce and a PKCE code verifier
  (`lib/pkce.ts`). The callback refuses a code without it, so an
  authorization code cannot be completed in another browser (forwarded
  callback links, login CSRF).
- **PKCE sent to Meta: `META_OAUTH_PKCE=true`.** Meta documents PKCE
  (`code_challenge` S256 + `code_verifier`) for its manually built login flow
  in the OIDC variant. Whether it applies to this permissions flow is not
  stated, so it is **off by default**. Turn it on, connect once in
  development mode, and keep it on if the connection succeeds.
- **PKCE sent to LinkedIn: `LINKEDIN_OAUTH_PKCE=true`.** LinkedIn enables
  PKCE per app on request; its documentation describes it for native apps.
  Turn it on only after LinkedIn has enabled PKCE for this app.

## 4. Revocation and deletion

| Meta app setting | URL | What Aura does |
| --- | --- | --- |
| Valid OAuth Redirect URI | `https://<host>/api/connectors/meta/callback` | Completes the connection (signed `state`, same user, OWNER/ADMIN) |
| Deauthorize callback URL | `https://<host>/api/meta/deauthorize` | Marks that person's Meta connections disconnected and forgets the tokens |
| Data deletion request URL | `https://<host>/api/meta/data-deletion` | Deletes that person's Meta connection data; answers with a status URL and confirmation code |
| (status page) | `https://<host>/meta/data-deletion?code=…` | Says whether the request was processed |

Both callbacks are authenticated by Meta's `signed_request` (HMAC-SHA256 with
the app secret); anything else is refused.

## 5. Testing before App Review (development mode)

1. In Meta for Developers, create a **Business** app; add **Facebook Login
   for Business** and **WhatsApp**.
2. Add yourself (and testers) under **App roles**. In development mode only
   they can connect.
3. Set the URLs in §4, and `META_CLIENT_ID` / `META_CLIENT_SECRET` in the
   deployment. `APP_URL` must be public — Meta fetches the images.
4. Create a **test Facebook Page** you administer. In the Instagram app,
   switch a test account to **Professional** (Business or Creator) and link
   it to the Page (Page settings → Linked accounts).
5. In Aura: Connectors → Facebook & Instagram → Connect. Choose the Page on
   the card. Approve a post and publish it.
6. Remove the app in Facebook settings → the connector shows "Access was
   removed"; reconnect works.

Real publishing in development mode posts publicly to the test Page and
Instagram account — use test accounts.

## 6. App Review checklist

- [ ] **Business verification** completed in Meta Business Manager.
- [ ] **Privacy Policy URL** (public) describing what Aura stores from Meta:
      encrypted access token, Page and Instagram account ids and names, and
      what is published; retention; how to request deletion.
- [ ] **Terms of Service URL**.
- [ ] **Data deletion URL** set (§4) — verify it answers with a code.
- [ ] **App icon**, category, contact email.
- [ ] **Reviewer access**: a test Aura account (email + password) with a
      workspace, an approved post ready to publish, and instructions. Meta
      reviewers use their own test Facebook user and Page.
- [ ] **One screencast per permission**, showing: login to Aura → Connectors
      → Connect Facebook & Instagram → the Facebook permission dialog → the
      Page picker → approving a post in Aura → publishing → the post on the
      Page and on Instagram. Include `business_management` only with a Page
      owned by a Business Portfolio.
- [ ] **Permission descriptions** — use §2's "Why" column, mention the human
      approval step.
- [ ] **Advanced Access** requested for each permission (Standard Access is
      only for people with an app role).

## 7. V1 scope

| In scope (V1) | Out of scope — blocked by the capability framework (`lib/capabilities.ts`) |
| --- | --- |
| Facebook organic publishing (text, photo) | Ads |
| Instagram organic publishing (image, carousel, Reel) | DMs / inbox |
| Basic publishing status (the execution record: scheduled, publishing, published, failed, action required) | Social listening |
| Organic analytics where supported (§2) | Influencer and competitor monitoring |
| | Autonomous posting (every post is approved by a person) |

## 8. Readiness — Code Complete → Integration Tested → Meta Review/Verification → Production Ready

Production use depends on Meta: **until App Review and Business
Verification are granted, the integration works only for people with a
role on the Meta app** (development mode). This is a Meta dependency, not
an engineering one.

| Capability | Code complete | Integration tested | Meta review / verification | Production ready |
| --- | --- | --- | --- | --- |
| Connect (login, long-lived token, Page + Instagram discovery, permissions read from `/me/permissions`) | Yes | Automated (Graph mocked); a real Graph call with a refused token is exercised by `verify:connections`. A real successful login: **not yet** (needs `META_CLIENT_ID/SECRET` and a test Page) | Not submitted | No — needs review |
| Correct Page / Instagram account identified (provider routing) | Yes | Automated, against the real database (`verify:execution`) | n/a | With the above |
| Permissions validated (missing ones block publishing, named) | Yes | Automated (`verify:connections`, `verify:execution`) | n/a | With the above |
| Facebook publishing | Yes | Automated (Graph mocked); a real call with a refused token handled (`verify:execution`). A real post: **not yet** | `pages_manage_posts` — not submitted | No |
| Instagram publishing (image, carousel, Reel) | Yes | Automated (Graph mocked). A real post: **not yet** | `instagram_content_publish` — not submitted | No |
| Basic publishing status | Yes | Automated (`verify:execution`) | n/a | Yes, once publishing is |
| Organic analytics (engagement) | Yes | Automated (Graph mocked) | Uses the publishing permissions | With publishing |
| Organic analytics (impressions, reach) | Yes, behind `META_REQUEST_INSIGHTS` | Automated (Graph mocked) | `read_insights`, `instagram_manage_insights` — not submitted | No |
| Unsupported capabilities blocked | Yes | Automated | n/a | Yes |
| Deauthorize / data deletion callbacks | Yes | Automated (signed requests) | Required for review | With review |

To move a row to "Integration tested": set `META_CLIENT_ID`,
`META_CLIENT_SECRET` (and `APP_URL` public), follow §5 with a test Page and
a linked Instagram professional account, then run `pnpm verify:meta`.
