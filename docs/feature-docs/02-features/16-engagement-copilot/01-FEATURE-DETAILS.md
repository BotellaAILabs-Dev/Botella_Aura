# Engagement Copilot

> Engagement Copilot drafts a brand-voice comment for a LinkedIn post the user is already looking at, from inside the Chrome extension. The user edits it, inserts it into LinkedIn's own comment box, posts it themselves and clicks "Mark as posted". It exists so a small team can stay visible in the conversations that matter without writing every comment from scratch, and without automation or scraping. The post text is read client-side from the page the user has open. The server never fetches LinkedIn content. The web app stores the user's list of profiles to engage with and keeps a read-only history of every drafted and posted comment.

## 1. Overview

- **Drafting happens in the extension.** The panel's "Draft a comment for this post" button reads the visible post nearest the viewport centre (`readVisiblePost` in `extension/content/linkedin.js`). It sends the post text, author and page URL to `POST /api/extension/engagement/draft`.
- **The server writes the comment** (`server/engagement/comment.service.ts`, `draftComment`):
  - Clips the excerpt to 2,000 characters.
  - Asks the AI for a 1-3 sentence comment grounded in the company's Business Context (`engagement` preset) and brand voice.
  - Stores an `EngagementComment(DRAFT)` and audits `ENGAGEMENT_COMMENT_DRAFTED`.
  - Falls back to a deterministic comment when no AI provider is configured or the call fails.
- **The human posts it.** "Insert into comment box" fills LinkedIn's Quill editor (clipboard fallback). The user clicks LinkedIn's own post button, then "Mark as posted". That calls `POST /api/extension/actions/complete` with `itemType: 'engagement_comment'`, which sets `POSTED` and `postedAt` (`server/extension/action.service.ts`).
- **Engagement targets** (`server/engagement/target.service.ts`): a workspace list of public LinkedIn profiles/pages the team wants to engage with, managed in the web app.
- **History**: `/dashboard/engagement` shows the 50 most recent comments with their status, post excerpt, author and link.

## 2. User-facing behaviour

| Screen | Route | What the user can do | Roles |
|---|---|---|---|
| Engagement Copilot | `/dashboard/engagement` (`app/dashboard/engagement/page.tsx`) | Read-only history of drafted comments: status badge (`DRAFT`, `POSTED` success, `DISCARDED` muted), post author, excerpt, draft text, link to the post. Also shows the monitored targets (`TargetManager`). Empty state: "No comments yet". | View: any member. Manage targets: OWNER, ADMIN (`company:update`). |
| Engagement targets | `/dashboard/settings/engagement` (`app/dashboard/settings/engagement/page.tsx` + `components/dashboard/engagement/target-manager.tsx`) | Add a target (label + profile URL; `classifyLinkedInUrl` labels it person/company and flags invalid URLs). Remove a target. Re-adding an existing URL updates its label. | View: any member. Edit: OWNER, ADMIN. |
| Extension panel (LinkedIn) | `https://www.linkedin.com/*` (`extension/content/linkedin.js`) | **Draft a comment for this post**, then edit the draft in a textarea, **Insert into comment box**, and **Mark as posted**. | Draft: `content:create` (OWNER, ADMIN, MEMBER). Mark posted: `content:approve` (OWNER, ADMIN). |

## 3. How it works

1. **Read the post.** `readVisiblePost()` scans `.feed-shared-update-v2, .fie-impression-container`, skips elements shorter than 40px or off-screen, and picks the one closest to the vertical centre. Text comes from `.update-components-text`, `.feed-shared-inline-show-more-text` or `.update-components-update-v2__commentary` (or the container), up to 5,000 chars. The author comes from `.update-components-actor__title` / `__name`. The URL is `location.href`.
2. **Send it up.** The background worker (`AURA_ENGAGE_DRAFT`) posts `{ postUrl, postText, author? }` with the extension bearer token. The request is validated by `draftCommentSchema`: `postUrl` must be a URL, `postText` 1-6,000 chars, `author` ≤ 160 chars.
3. **Authorize.** `requireExtensionAuth` verifies the token and re-reads the membership. The route refuses roles without `content:create` (403 "Your role is read-only…").
4. **Draft.**
   - With AI configured, `buildComment`:
     - Makes sure the brand-voice profile exists (`generateBrandVoiceProfile`).
     - Loads `getBusinessContext(companyId, { sections: [] })` and renders it with the `engagement` preset (identity and voice only; no audience block).
     - Calls `completeStructured` with `maxTokens 400`, `effort medium`, `tier standard`. The prompt rules are: thoughtful and specific, no "Great post!", no hashtags, no self-promotion, JSON `{"comment": string}` of at most 1,200 chars.
   - Fallback: `Really resonates — especially the point about "<first sentence, ≤ 80 chars>". Curious how you're seeing this play out in practice.`
5. **Store.**
   - Creates `EngagementComment` with `targetPostUrl`, `targetAuthor`, `postExcerpt`, `draftText`, `status DRAFT`, `createdById`, and `aiMetadata { model, brandVoiceApplied }`.
   - Audits `ENGAGEMENT_COMMENT_DRAFTED`.
   - Responds with `{ commentId, text, model, actionsToday }`.
6. **Insert.** `insertIntoCommentBox` finds an open Quill comment editor and fills it through `execCommand('insertText')` (falling back to a DOM write). If no editor is open, the text is copied to the clipboard and the user is told to open the comment box.
7. **Mark as posted.**
   - The background worker checks the client caps (8/hour, 25/day) before calling `/api/extension/actions/complete`. The server also refuses once 25 actions are recorded today.
   - `completeEngagementComment` requires `content:approve`. It is idempotent on `POSTED`. It sets `POSTED` + `postedAt` and audits `ENGAGEMENT_COMMENT_POSTED`, plus `EXTENSION_ACTION_COMPLETED`.
   - Unlike outreach, there is no approval step: posting is the human's own act on LinkedIn.

Targets: `addTarget` upserts on `(companyId, profileUrl)` and audits `ENGAGEMENT_TARGET_ADDED`. `removeTarget` deletes within the workspace only and audits `ENGAGEMENT_TARGET_REMOVED`. URLs are normalized to `https://` by `createTargetSchema`.

## 4. Code map

| Layer | File | Responsibility |
|---|---|---|
| Page | `app/dashboard/engagement/page.tsx` | Comment history + targets (`listComments`, `listTargets`) |
| Page | `app/dashboard/settings/engagement/page.tsx` | Target settings |
| Component | `components/dashboard/engagement/target-manager.tsx` | Add/remove targets, LinkedIn URL classification |
| API | `app/api/engagement/targets/route.ts` | GET list, POST add |
| API | `app/api/engagement/targets/[id]/route.ts` | DELETE |
| API | `app/api/extension/engagement/draft/route.ts` | Bearer-auth draft endpoint for the extension |
| API | `app/api/extension/actions/complete/route.ts` | Sync-back that marks a comment `POSTED` (shared with feature 17) |
| Service | `server/engagement/comment.service.ts` | `draftComment`, `listComments` |
| Service | `server/engagement/target.service.ts` | `listTargets`, `addTarget`, `removeTarget` |
| Service | `server/extension/action.service.ts` | `completeEngagementComment` |
| Lib | `lib/validations/engagement.ts` | `createTargetSchema`, `draftCommentSchema` |
| Lib | `lib/linkedin-url.ts` | `classifyLinkedInUrl` |
| Extension | `extension/content/linkedin.js` | `renderEngageSection`, `onEngage`, `renderDraftedComment`, `readVisiblePost`, `insertIntoCommentBox` |
| Extension | `extension/background.js` | `AURA_ENGAGE_DRAFT`, `AURA_COMPLETE` message handlers |

## 5. Data model

| Model / enum | Key fields | Notes |
|---|---|---|
| `EngagementTarget` | `companyId`, `label`, `profileUrl`, `createdAt` | `@@unique([companyId, profileUrl])` |
| `EngagementComment` | `companyId`, `createdById?`, `targetPostUrl`, `targetAuthor?`, `postExcerpt?`, `draftText`, `status EngagementStatus`, `aiMetadata` JSON, `postedAt?` | Indexed on `(companyId, status)`. Related to `PerformanceSnapshot` (Marketing Memory). |
| `EngagementStatus` | `DRAFT`, `POSTED`, `DISCARDED` | `DISCARDED` exists in the schema and UI, but no code path sets it |

## 6. API endpoints

Full reference: [INTERNAL-API.md](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth/permission |
|---|---|---|---|
| GET | `/api/engagement/targets` | List targets | Session, member |
| POST | `/api/engagement/targets` | Add or relabel a target | Session, `company:update` |
| DELETE | `/api/engagement/targets/:id` | Remove a target | Session, `company:update` |
| POST | `/api/extension/engagement/draft` | Draft a comment from client-captured post text | Extension bearer token, `content:create` |
| POST | `/api/extension/actions/complete` (`itemType: engagement_comment`) | Mark a comment posted | Extension bearer token, `content:approve`, daily cap 25 |

## 7. External services

- AI provider through `server/ai/claude.ts` (see [23 AI Layer](../23-ai-layer/)). Optional; there is a deterministic fallback.
- No LinkedIn API call and no server-side fetch of any LinkedIn page. Environment reference: [ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

Not applicable. Everything is user-initiated from the extension or the settings page.

## 9. Security & permissions

- **Bearer-only extension auth** (`lib/extension-auth.ts`): hashed, revocable, 180-day tokens scoped to one user and workspace. Membership is re-read on every request.
- **Roles:** drafting needs `content:create`; marking posted needs `content:approve`; managing targets needs `company:update`. VIEWER can only read history.
- **Workspace scoping:** comments are created with the token's `companyId`. `completeEngagementComment` and `removeTarget` filter by `companyId`, so another workspace's id is "not found" or a no-op.
- **No server-side LinkedIn reads:** the only post content the server sees is what the extension sends, capped at 6,000 chars on input and 2,000 stored.
- **Audit:** `ENGAGEMENT_COMMENT_DRAFTED`, `ENGAGEMENT_COMMENT_POSTED`, `ENGAGEMENT_TARGET_ADDED`, `ENGAGEMENT_TARGET_REMOVED`, `EXTENSION_ACTION_COMPLETED`.

## 10. Testing

- No unit test targets `server/engagement/` directly.
- `tests/extension-permissions.test.ts` covers role and workspace checks on extension writes (the shared `completeAction` path).
- No `pnpm verify:*` script is dedicated to engagement.

## 11. Configuration & limits

| Setting | Value | Source |
|---|---|---|
| Post text accepted | 1-6,000 chars | `draftCommentSchema` |
| Excerpt stored / sent to AI | 2,000 chars | `MAX_EXCERPT` |
| Text read from the page | 5,000 chars | `readVisiblePost` |
| Comment length | ≤ 1,200 chars, 1-3 sentences | `commentSchema`, prompt |
| History shown | 50 most recent | `listComments` |
| Extension action caps | 8/hour, 25/day client; 25/day server | `extension/background.js`, `lib/extension-constants.ts` |
| Target label / URL | ≤ 120 / ≤ 300 chars | `createTargetSchema` |

No feature-specific environment variables.

## 12. Known limitations & future work

- **Targets are not used by the extension.** There is no extension endpoint that returns `EngagementTarget`s, and `linkedin.js` drafts for whatever post is on screen. Targets are currently a stored list only, despite the schema comment describing monitoring in the extension.
- **`DISCARDED` is never set.** No route or service discards a draft, so unposted drafts stay `DRAFT` forever.
- **Comments never enter the extension queue.** `getQueue` notes engagement items "are appended here once that module lands". A draft is usable only in the panel session that created it.
- **No approval step for comments.** Unlike content and outreach, a comment goes from AI draft to posted on the user's judgement alone.
- **Brittle DOM selectors.** Post detection and editor insertion depend on LinkedIn's class names; the clipboard fallback covers editor failures only.

## 13. Related documents

- [SPRINT-4-TECHNICAL.md](../../../SPRINT-4-TECHNICAL.md), section 7 (Module 4 — Engagement Copilot)
- [SPRINT-5-TECHNICAL.md](../../../SPRINT-5-TECHNICAL.md) (metrics sync from the extension)
- [PRODUCT-DOCUMENTATION.md](../../../PRODUCT-DOCUMENTATION.md), [PERMISSIONS-SECURITY.md](../../../PERMISSIONS-SECURITY.md)
- Sibling features: [17 Chrome Extension](../17-chrome-extension/), [15 Leads & Outreach](../15-leads-and-outreach/), [05 Business Context](../05-business-context/), [04 Knowledge Base & Brand Voice](../04-knowledge-base-and-brand-voice/), [18 Marketing Memory](../18-marketing-memory-and-analytics/), [23 AI Layer](../23-ai-layer/)
- [Architecture](./02-ARCHITECTURE.md)
