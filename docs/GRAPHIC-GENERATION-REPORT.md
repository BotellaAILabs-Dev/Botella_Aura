# Botella Aura — Graphic Generation Report

**Content Studio can now illustrate its own posts.**

A post is analysed, an image prompt is written from it, a graphic is generated,
attached, and carried through the existing queue to the existing publishers.

|                  |                                                                    |
| ---------------- | ------------------------------------------------------------------ |
| **Prepared for** | Product & Engineering                                              |
| **Source**       | Content Studio — Graphic Generation + Social Publishing spec (§1–27) |
| **Status**       | Feature complete. One API key from being live.                      |
| **Branch**       | `main` @ `7da7d0e`                                                  |

---

## Verdict

The feature is **built, integrated and verified** against a live PostgreSQL
database and a running instance of the app.

One thing is not proven: **no image has ever actually been generated**, because
no provider API key was available. The four provider integrations are written
against each vendor's documented API and compile clean, but "correct per the
docs" is not "verified working", and this report does not claim otherwise. That
distinction is the single most important thing in this document.

Everything *surrounding* those calls — prompt generation, validation, storage,
attachment, the queue, the composer, the extension, security — is exercised and
passing.

---

## What was delivered

| | |
| --- | --- |
| Files created | 45 |
| Files modified | 24 |
| Net change | +10,103 / −80 lines |
| New backend + shared code | ~3,800 lines |
| New UI | ~1,550 lines |
| New tests | ~1,700 lines (11 suites, 115 tests) |
| New API endpoints | 9 |
| Database migrations | 2 |

### Capability

- **Content → prompt.** The post is rendered, combined with the company's
  existing brand-voice profile (translated into *visual* direction, not writing
  instructions), the target platform's art direction and the chosen style. Falls
  back to a deterministic composer when no LLM is configured — and labels itself
  as such rather than pretending.
- **Four image providers** behind one interface: OpenAI, Google Imagen,
  Stability AI, Replicate. Adding a fifth is one file plus one registry line.
- **Formats** — Square, Portrait, Landscape, Story/Reel, and Custom (arbitrary
  dimensions mapped to the closest shape a provider can actually draw).
- **Your own graphics** — upload a file or add one by URL. Same pipeline, so it
  behaves identically everywhere downstream.
- **Graphic history**, grouped by day, with reuse / download / delete / attach.
- **Post composer** — content + graphic + platform + schedule as one post.
- **Queue** — pushes into the *existing* queue and scheduler. No second queue.
- **Publishers** — LinkedIn (official Images API) and Instagram (Graph API),
  both reusing existing connections.
- **Browser extension** — carries the graphic into LinkedIn's own composer.

---

## Architecture

```
ContentDraft (existing)
      │
      ▼
ImagePromptGenerator ......... reuses server/ai/claude.ts + brand voice
      │
      ▼  (the user edits the prompt — always)
GenerationJob queue .......... reuses the EXISTING background job system
      │
      ▼
ImageGenerationService
      ├── OpenAI ├── Google ├── Stability └── Replicate
      │
      ▼
validate bytes → AssetStore (Postgres | S3) → GeneratedAsset
      │
      ▼  attach
ContentMedia ──────────────► ContentDraft.media
      │
      ▼
queueDraft() ................. the EXISTING queue
      │
      ▼
runScheduledPublishes() ...... the EXISTING cron
      ├── LinkedIn publisher
      ├── Instagram publisher
      └── manual / extension fallback
```

### Six decisions worth defending

**Images live in Postgres by default.** The app deploys with no writable
filesystem, and every provider's image URL expires within hours — a post
scheduled for next week cannot depend on one. Postgres is the durable thing the
project already has. An S3-compatible store sits behind the same interface for
deployments that outgrow it; each asset records where its own bytes live, so
switching strands nothing.

**Generation runs on the existing job queue, not inline.** Four variations on a
provider that returns one image per call is four sequential round-trips, which
outlives a serverless function budget. That is the exact failure `GenerationJob`
was introduced to solve for the trend digest — so this reuses it rather than
repeating the mistake.

**Runs are resumable.** Assets are stamped with their job id, so a retry after a
timeout generates only the shortfall. Without this, a run killed at image 3 of 4
would have regenerated all four and billed the workspace up to three times for
one click.

**Platform is separate from content type, and nullable.** `ContentType` is the
shape of the writing; `SocialPlatform` is where it goes. Nullable means every
pre-existing draft resolves to exactly the destination it had before — pinned by
test, because drifting it would silently retarget historical drafts.

**A supplied image is the same model, not a new one.** Upload and URL reuse
`GeneratedAsset` with `provider = UPLOAD`. Everything after the bytes arrive is
identical, so a second model would have duplicated the entire pipeline to record
one different origin.

**The approval gate is untouched.** "Add to queue" sets platform and schedule and
moves the draft to `PENDING_APPROVAL`. It never approves. Scheduled publishing
still only ever picks up `APPROVED` drafts.

---

## Verification

Run against a live PostgreSQL 16 and a running production build of the app.

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors, whole project |
| `pnpm lint` | 0 warnings/errors |
| `pnpm test` | 320 passed (39 files) — 115 of them new |
| `pnpm verify:graphics` | 30/30 pipeline checks |
| `pnpm build` | compiled, 0 dynamic-server errors |
| `prisma migrate diff` | **no drift** between migrations and schema |

### Proven end-to-end, not just unit-tested

- An **HTML error page served with HTTP 200** is rejected — MIME is sniffed from
  the bytes, never trusted from a header.
- **Real dimensions** are read from the file header, not the provider's claim.
- **Cross-tenant asset reads return 404**, not 403 — confirming an id exists is
  itself a leak.
- A **signed asset URL works with no session** (the Instagram fetch path) and
  returns real PNG bytes; a **tampered signature 404s**; **no auth 404s**.
- The **SSRF guard blocks `169.254.169.254`** (cloud instance metadata).
- An **upload round-trips byte-identical** and attaches with no platform errors.
- **Queueing a DRAFT never auto-approves it** — `DRAFT → PENDING_APPROVAL`.
- Generation **refuses honestly with 503** when no provider is configured,
  rather than crashing.

### Three defects found and fixed during review

1. **Editing the prompt mid-run returned the previous prompt's images.** Job
   reuse discarded the new inputs silently. Now compares inputs structurally and
   answers 409 when they differ; identical requests still reuse (the
   double-click case reuse exists for).
2. **The monthly image allowance could be exceeded.** It was a boolean gate, so
   1 remaining + a request for 4 produced 4. Now sized against the remaining
   balance, and clamps rather than refusing.
3. **Uploads had no pixel cap.** A flat 6000×6000 PNG is 105 KB — byte size
   bounds nothing. Nothing here resizes, so storing one only deferred the
   rejection to publish time. Refused at the door with actionable advice.

---

## Security posture

| Concern | Handling |
| --- | --- |
| Provider API keys | Server-only. A test asserts key values never appear in the providers payload. |
| Provider error bodies | Logged server-side only — they echo prompts and can carry org identifiers. Status codes map to safe messages. |
| Asset access | Company-scoped in every query; unauthorised reads 404. |
| Signed URLs | HMAC over id + expiry, constant-time compare, 15-minute life. |
| SSRF | Remote image URLs restricted to http(s); loopback, RFC1918 and cloud-metadata refused. |
| Extension | Reuses the existing bearer token and company scoping. No new auth path. |
| Rate limiting | 6 generations / 20 prompt-writes / 20 uploads per user per minute. |
| Cost control | Per-plan monthly budget enforced before any provider is touched, plus per-request caps at the schema, plan, provider and service layers. |

---

## What is NOT done

Stated plainly, so nobody discovers it at publish time.

### Needs only an API key

- **A real image generation.** Add any one of `OPENAI_API_KEY`,
  `GOOGLE_AI_API_KEY`, `STABILITY_API_KEY`, `REPLICATE_API_TOKEN`.

### Needs more than an API key

- **Instagram publishing** — Meta app credentials **plus App Review** for
  `instagram_content_publish`. A multi-week approval, not a config change.
  Until then it falls back to manual with an explanation.
- **LinkedIn auto-publish** — the connection must have granted
  `w_member_social` (add the self-serve "Share on LinkedIn" product and
  reconnect). Company Pages additionally need Marketing API approval.

### Deliberately not built

- **X / Facebook publishers.** Those posts route to manual/extension.
- **Instagram carousels.** The first attached image publishes; `ContentMedia`
  already models the ordered set, so this is a publisher change only.
- **Video.** `MediaKind.VIDEO` exists so the attachment layer needs no reshaping.
- **Image editing / inpainting.** Regenerate produces a new asset.

### Unverified against the real world

- The **four provider HTTP calls**.
- The **LinkedIn image-upload handshake** (`initializeUpload` → PUT → poll).
- The **extension's `DataTransfer` injection** into LinkedIn's composer. This is
  the most fragile item in the change set — LinkedIn's markup changes often.

### Known operational limits

- **Serverless timeouts.** Netlify caps functions at ~10–26s; `maxDuration` is a
  Vercel concept. Resumability and parallel provider fan-out shrink the blast
  radius but do not remove it. Pre-existing for the digest and planner too.
- **Postgres image storage** will bloat the table at volume. `ASSET_S3_*`
  switches it with no other change.
- **Concurrent allowance race.** Two simultaneous requests can both read the
  same remaining count and slightly overshoot. Bounded; eliminating it needs a
  transactional counter.
- **In-memory rate limiter** is per-instance. Pre-existing; the DB-backed
  entitlement is the real guard.

---

## Getting it live

```bash
# 1. one provider key in .env
OPENAI_API_KEY="sk-..."          # or GOOGLE_AI_API_KEY / STABILITY_API_KEY / REPLICATE_API_TOKEN

# 2. apply the schema
pnpm db:migrate:deploy

# 3. verify
pnpm typecheck && pnpm lint && pnpm test && pnpm verify:graphics

# 4. run
pnpm dev
```

Then: Content Studio → open a draft → **Generate graphic**.

Configuration details, the provider comparison table and troubleshooting live in
`README.md`. Design rationale lives in `docs/GRAPHIC-GENERATION-TECHNICAL.md`.

---

## Risk summary

| Risk | Likelihood | Impact | Mitigation in place |
| --- | --- | --- | --- |
| A provider call has a wrong field or response shape | Medium | Low | Surfaces as a specific error on first generation; "Retry / Try another model" preserves the post |
| LinkedIn DOM changes break extension image injection | Medium | Low | Falls back to clipboard + a message telling the user what to do |
| Serverless timeout kills a long generation | Medium | Low | Resumable — a retry pays only for the shortfall |
| Postgres bloat at volume | Low now | Medium later | S3 store behind the same interface |
| Instagram App Review is refused or delayed | Medium | Medium | Manual fallback names exactly what is missing; never a false "published" |

No risk in this table can produce a **false "published"** state or a **lost
draft**. Those two were the product's non-negotiables, and both are enforced in
the service layer rather than the UI.
