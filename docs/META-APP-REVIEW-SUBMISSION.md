# Meta App Review — submission package (Facebook & Instagram)

Status: **prepared, not submitted. No permission has been approved.** This is
the material to paste into App Review once the prerequisites in §1 are met.
Status tracking lives in [META-APP-REVIEW-CHECKLIST.md](META-APP-REVIEW-CHECKLIST.md).
Meta changes its review forms; check each field against the dashboard at
submission time.

`<host>` = the production domain (to confirm).

## 1. Prerequisites (submission is refused or rejected without them)

| Requirement | Status |
| --- | --- |
| App type **Business**, one app for Facebook + Instagram (+ WhatsApp) | To check in the dashboard ([META-APP-SETUP.md §3](META-APP-SETUP.md)) |
| **Business Verification** of the operating company | Not started (business) |
| Production deployment reachable at `<host>` with real `META_CLIENT_ID` / `META_CLIENT_SECRET` | Not done — no real credentials yet |
| Privacy Policy, Terms, Data deletion pages **final** (not draft) | Drafts built; awaiting business/legal approval (`lib/legal.ts`) |
| App icon 1024×1024, category, contact email, app domain | Not done |
| At least one successful API call per requested permission, made by the app (the dashboard asks for this before some permissions can be submitted) | Not possible until real credentials are configured |

## 2. Permissions to request

All with **Advanced Access** (Standard Access only works for people with a
role on the app).

| Permission | Product | Request? |
| --- | --- | --- |
| `pages_show_list` | Facebook Login | Yes |
| `pages_read_engagement` | Facebook Login | Yes |
| `pages_manage_posts` | Facebook Login | Yes |
| `instagram_basic` | Instagram (via Facebook Login) | Yes |
| `instagram_content_publish` | Instagram (via Facebook Login) | Yes |
| `business_management` | Facebook Login | Only if target customers' Pages are owned by a Business Portfolio (most are). Meta scrutinises it most — drop it if testing shows Pages are listed without it |
| `read_insights` | Facebook | **No, not in the first submission.** Insights stay off (`META_REQUEST_INSIGHTS` unset) |
| `instagram_manage_insights` | Instagram | **No, not in the first submission** |

Submitting the insights permissions later is a separate review; until then
Aura reports reactions, comments and shares only (verified by
`tests/meta-insights.test.ts`).

If `META_LOGIN_CONFIG_ID` is used (Facebook Login for Business), the
permissions come from that login configuration in the dashboard, not from
code — it must list exactly the permissions above.

## 3. Justifications (paste per permission)

Every one should state the human-approval step — it is Aura's strongest
answer to "why does this app publish on users' behalf".

**pages_show_list**
> Botella Aura is a marketing assistant that publishes posts a business has
> written and approved in Aura to the business's own Facebook Page. After the
> user connects Facebook, Aura lists the Pages they manage so they can choose
> which Page Aura publishes to. Aura stores only the chosen Page's ID and name.

**pages_read_engagement**
> Aura reads basic information about the Page the user selected, and the
> reactions, comments and share counts of posts Aura published to it, so the
> business can see how its approved posts performed. Meta also requires this
> permission for Instagram content publishing through a linked Page.

**pages_manage_posts**
> Aura publishes to the user's Facebook Page only posts that an owner or admin
> of the business approved in Aura — the exact text and image they reviewed.
> The user clicks "Approve and publish", or schedules the approved post, and
> Aura creates that post on the Page. Aura never posts without that approval
> and does not edit or delete existing Page content.

**instagram_basic**
> Aura reads the Instagram professional account linked to the selected Page
> (its ID and username) so the user can confirm which account Aura publishes
> to, and reads like and comment counts of posts Aura published.

**instagram_content_publish**
> Aura publishes to the user's Instagram professional account only posts
> approved by an owner or admin in Aura: a single image, a carousel of 2–10
> images/videos, or a Reel. Nothing is published without that approval.

**business_management** (only if requested)
> Many businesses own their Page through a Meta Business Portfolio. Without
> this permission those Pages are not returned, and the user cannot choose
> the Page Aura publishes to. Aura uses it only to list Pages the user can
> manage; it does not change business settings or assets.

## 4. Screen recordings

One recording per permission is safest (one recording covering the full
flow, referenced from each, is often accepted). Requirements:

- English UI, or captions in English; readable resolution; no cuts that hide
  a step.
- Start signed out, show signing in to Aura, and show the **Meta login and
  permission dialog** with the permissions listed.
- Show where the data obtained by the permission appears in Aura.

Script (≈3–4 min):

1. Open `https://<host>/login`, sign in with the reviewer account.
2. Dashboard → **Your tools** → **Facebook & Instagram** → **Connect**.
3. Facebook login → the permission dialog (pause so each permission is
   visible) → continue.
4. Back in Aura, the setup page lists the Pages (`pages_show_list`,
   `business_management`) with each linked Instagram account
   (`instagram_basic`). Choose the test Page.
5. Open **Review & approve**, open the prepared draft, show the text and image,
   click **Approve and publish** (`pages_manage_posts`,
   `instagram_content_publish`).
6. Show the publishing result in Aura (**Publishing**), then the post live on
   the Facebook Page and on the Instagram account.
7. Return later (or show an older published post) with its reactions /
   comments counts in Aura (`pages_read_engagement`).
8. Show disconnecting (Your tools → Disconnect) and the
   `https://<host>/data-deletion` page.

## 5. Test account requirements

- **Aura reviewer account:** dedicated email + strong password (not a real
  person's), owner of a workspace with onboarding complete, one draft ready
  for approval with an image (and one Reel draft if Reels are shown). Given in
  the review form only — never committed or put in docs.
- **Facebook side:** reviewers use their own test users. Provide written steps
  for creating a Page and linking an Instagram professional account, or say the
  flow requires one. Our own test assets (a test Page owned by the business
  portfolio, an Instagram professional/creator account linked to it, an admin
  Facebook user with an app role) are needed to record the screencasts and to
  make the test API calls.
- Production must be reachable by reviewers: no Vercel password protection,
  no IP allow-list on `<host>`.

## 6. Reviewer instructions (paste into "How to test")

> 1. Go to https://<host>/login and sign in with the credentials provided.
> 2. In the left menu open "Your tools" and click Connect on "Facebook &
>    Instagram". Log in with a Facebook user that manages a Page with a
>    linked Instagram professional account and grant the permissions.
> 3. On the setup page, choose the Page. Its Instagram account is shown.
> 4. Open "Review & approve", open the draft "<title>", and click "Approve
>    and publish". Select Facebook and Instagram.
> 5. The post appears on the Page and the Instagram account within a minute;
>    its status is shown under "Publishing".
> 6. To remove access: "Your tools" → Disconnect, or remove the app in
>    Facebook settings. Data deletion instructions: https://<host>/data-deletion

## 7. URLs (App settings → Basic / Facebook Login settings)

| Field | Value | Notes |
| --- | --- | --- |
| Privacy Policy URL | `https://<host>/privacy` | Must be final, publicly reachable, and describe Meta data (it does: tokens encrypted, Page/IG IDs and names, post IDs and engagement, deletion) |
| Terms of Service URL | `https://<host>/terms` | Must be final |
| User data deletion | **Data deletion callback URL** `https://<host>/api/meta/data-deletion` | Meta requires either a callback or an instructions URL. Aura implements the callback (signed_request verified with the app secret, returns `{ url, confirmation_code }`, status page `/meta/data-deletion?code=`). `/data-deletion` is the instructions-page alternative |
| Deauthorize callback URL | `https://<host>/api/meta/deauthorize` | Deletes the stored token, marks the connection revoked |
| Valid OAuth Redirect URIs | `https://<host>/api/connectors/meta/callback` | Exact match, https |
| App domains | `<host>` | |

Before submitting: set `approved: true` in `lib/legal.ts` after the text is
final (removes the DRAFT banner and `noindex`), deploy, and open all three
URLs signed out.

## 8. Common rejection reasons to pre-empt

- Screencast does not show the permission dialog, or does not show where the
  data is used.
- Privacy policy unreachable, a placeholder, or silent about Meta data.
- Reviewer cannot sign in (expired password, 2FA, onboarding blocking).
- Requesting a permission the recording does not use (most often
  `business_management` or insights).
- App still in Development mode or the business not verified.
