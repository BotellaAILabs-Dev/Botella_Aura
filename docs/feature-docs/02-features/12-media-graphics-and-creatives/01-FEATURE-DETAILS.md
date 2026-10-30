# Media, Graphics & Marketing Creatives

> Every post written in Content Studio can carry an image, and this feature makes, stores and prepares that image. It writes an image prompt from the post, the visual brief and the brand. It generates up to four variations through whichever image provider the deployment has configured (OpenAI, Google Gemini/Imagen, Agnes AI, Hugging Face, Stability AI or Replicate). It refines or regenerates one image as a new version, places the exact uploaded logo on it (the model never draws the logo), and composes branded marketing creatives: a photograph plus real typography, the brand palette and the logo, rendered to one PNG. It also accepts images and videos the user uploads or imports by URL. Everything is stored durably (Postgres by default, an S3-compatible bucket when configured), so a post scheduled for next week does not depend on a provider URL that expires in an hour, and it is checked against each network's media rules before publishing.

## 1. Overview

The feature has five parts. Each one has its own service under `server/media/`.

| Part | What it does | Entry point |
|---|---|---|
| **Graphic generation** | The AI-written prompt (or the user's edited one), then provider generation, then validation, then storage, then a `GeneratedAsset` row | `server/media/generation.service.ts` (`generateGraphics`) |
| **Image variants & logo** | Refine (image + instruction), regenerate, "make room for a logo", place the exact logo with tinting. Each result is stored as the next version of a variant, never as an overwrite | `server/media/variant.service.ts`, `server/media/logo-overlay.ts`, `lib/image-variants.ts` |
| **Marketing creatives** | Copy (fact-guarded), then a commercial photo, then a satori/resvg layout with bundled fonts, giving one PNG | `server/media/creative/*`, `lib/creative/*` |
| **Visual brief** | What the image is for (subject, product, audience, palette, mood, format, rules, what is missing). It feeds the prompt and the default aspect ratio | `lib/visual-brief.ts`, `server/media/visual-brief.service.ts` |
| **Media storage & ingest** | Byte sniffing, size and dimension limits, DB or S3 storage, uploads and URL import (images and MP4/MOV video), signed URLs for Meta, per-platform validation | `server/media/validate.ts`, `storage.ts`, `upload.service.ts`, `asset-url.ts`, `asset.service.ts` |

A separate **free-text image generator** (`POST /api/generate-image`, component `agnes-image-generator.tsx`) turns a typed prompt into an image with Hugging Face FLUX, Google ("nano-banana") or Agnes AI. It returns a `data:` URI and does **not** store an asset.

Slow work never runs inside the request. Generation, creatives with a new photo, refine, regenerate and make-space all enqueue a `GenerationJob` of kind `IMAGE_GENERATION`, and the browser drives it (`POST /api/jobs/:id/run`) and polls it (`GET /api/jobs/:id`).

## 2. User-facing behaviour

All of the UI lives on the draft page **`/dashboard/content/[id]`** (`app/dashboard/content/[id]/page.tsx`). It appears in this order, beneath the draft preview, review and fact-check panels:

1. **Visual brief panel** (`components/dashboard/content/visual-brief-panel.tsx`) shows whether the format needs an image, the subject, product, audience, palette, mood, target shape and size, the rules, and each missing item with a link to fix it (for example "Add what you sell" goes to `/dashboard/business?ask=identity.offerings`, and "Add brand colours" goes to `/dashboard/settings`).
2. **Creative Studio** (`creative-studio.tsx`) makes a branded creative:
   - **Creative type:** 10 options. Event, product launch, promotion, offer, greeting, announcement, educational, brand awareness, retail promo, B2B.
   - **Layout:** 6 options. Hero, split, frame, offer, editorial, spotlight.
   - **Format:** 4 options at 1080×1080, 1080×1350, 1080×1920 and 1920×1080.
   - **Font pair:** 4 options. Modern/Montserrat, Impact/Bebas Neue, Elegant/Playfair Display, Clean/Inter.
   - **Photo mood:** natural, bright, moody or studio.
   - **Text fields:** eyebrow, headline, subheadline, event name, date, time, venue, offer, CTA and website.
   - **Logo mode:** include, none or space.
   - **Colour overrides:** primary and accent.
   - **Photo direction.**
   - **Photo source:** `new`, `reuse` (an existing photo) or `none` (brand background).

   Its actions are:
   - **Generate creative** queues a job.
   - **Update text & design** re-renders on the same photo with no generation.
   - **Refine** works on the photo and puts the design back on unchanged.
   - **Use on post** attaches the creative.
3. **Graphic Studio** (`graphic-studio.tsx`) runs the main image flow:
   1. Write a prompt from the post, with optional guidance and a style. There are 6 styles: Professional, Photorealistic, Minimal, Cinematic, 3D, Illustration.
   2. Edit the prompt and negative prompt.
   3. Pick a provider. The list comes from `/api/content/graphics/providers` and names any missing env var.
   4. Pick a format: Square 1:1, Portrait 4:5, Landscape 16:9, Story/Reel 9:16, or **Custom** (256–4096 px per side).
   5. Pick the number of variations (1–4) and a logo setting (mode, position, tint).
   6. Generate.

   Results are grouped into **variants** with their versions side by side (`image-variant-panel.tsx`). Per variant the user can do the following:
   - **Refine** with one instruction.
   - **Regenerate.**
   - **Change logo** (include / none / add later, position, tint).
   - **Attach** to the post (replace, or append for a carousel).
   - **Delete.**
   - **Open full-screen** (`components/ui/image-lightbox.tsx`).

   The studio also has these features:
   - **Upload** an image or video file (≤ 4 MB per request), or **import by URL** (image ≤ 15 MB, video ≤ 100 MB).
   - **History**, which can widen to the whole company with `?scope=company`, grouped by day ("Today", "Yesterday", …).
   - A usage meter ("used / limit this month").
   - If you reload mid-run, the page reattaches to the job that is already running.
4. **Free-text image generator** (`agnes-image-generator.tsx`) appears only when `canEdit` is true. It is prefilled with `visualBriefStarterPrompt` when the draft came from a recommendation. It has a model dropdown (huggingface / nano-banana / agnes, each marked configured or not) and a "realistic" toggle. The result can be downloaded; it is not saved as an asset.
5. **Post composer** (`post-composer.tsx`) shows the attached media with per-platform problems, can detach media, and queues the post. Queueing belongs to [20-publishing-execution-and-scheduling](../20-publishing-execution-and-scheduling/).

**Roles** (from `lib/rbac.ts`):

| Role | Can view graphics/history | Generate, upload, refine, attach, delete |
|---|---|---|
| OWNER, ADMIN, MEMBER | Yes | Yes (`content:create`) |
| VIEWER | Yes | No. Mutating routes return 403 ("Your role is read-only …") |

On the page, `canEdit = can(role,'content:create') && draft.status !== 'PUBLISHED'`. The server also refuses media changes on a published post with 409.

## 3. How it works

### 3.1 Prompt writing (`server/media/image-prompt.service.ts`)

`POST /api/content/drafts/:id/graphics/prompt` calls `generateImagePrompt({draft, platform, style, guidance})`.

1. It renders the post text (`renderForManual`, capped at 3000 chars).
2. It gets the **visual brief** from `visualBriefForDraft(draft, platform)`:
   - It uses `draft.aiMetadata.brief.visual` when the draft came from a Content Brief (source `content_brief`). The stored brief is re-targeted when the platform differs.
   - Otherwise it builds one from Business Context (offerings, description, stated audience, market mode), brand assets (primary/secondary/accent colours, logo on file), the brand voice (tone, topics to avoid) and the post's first line (source `business_context`).
3. It chooses art direction. The *photographic* styles are `photo`, `professional` and `cinematic` (`PHOTOGRAPHIC_STYLES` in `lib/photo-realism.ts`). A photographic style uses `PLATFORM_PHOTO_DIRECTION[platform]`. Any other style uses `PlatformSpec.artDirection`.
4. When an LLM is configured (`isClaudeConfigured()`), it calls `completeStructured`:
   - Settings: `maxTokens 1200`, `effort 'low'`, `tier 'standard'`.
   - The model acts as an art director and returns `{subject, prompt (60–200 words), negativePrompt}`.
   - The input includes the company name and industry, the visual brief, the post, the style, the platform, the realism and people direction (photographic styles only), the user's guidance, and `UNIVERSAL_RULES` (no lettering, logos or watermarks; no celebrities or other brands; a single coherent image; high production value).
   - For photographs the negative prompt is merged with `photoNegativeFor(shotKindOf(...))`.
5. If no LLM is configured, or the call fails, it falls back to the deterministic `heuristicPrompt(...)`, built from the post's hook plus the style and platform direction, with `source: 'heuristic'`.
6. It writes the audit entry `GRAPHIC_PROMPT_GENERATED` with `promptVersion: 'graphics.2'`, `visualSource`, `visualReadiness` and `visualMissing`.

Visual brief readiness (`buildVisualBrief`):

| Readiness | When |
|---|---|
| `not_needed` | The format's need is `none` |
| `blocked` | A required field is missing. Only `subject` (the key message) is required |
| `ready_with_gaps` | Only recommended fields are missing (product, audience, palette, mood) |
| `ready` | Nothing is missing |

The brief's `format` carries the target ratio (`aspectRatio`, else the platform's `defaultRatio`, else `1:1`), the pixel size from `RATIO_DIMENSIONS`, the other allowed ratios, the minimum dimension, the maximum file size in MB, the file types and the art direction. `VISUAL_RULES` forbids lettering and logos, identifiable people, any offer, price or claim not in the brief, and collages.

### 3.2 Queueing a generation (`POST /api/content/drafts/:id/graphics`)

These checks run before a job exists, so each fails fast with a specific error:

1. The role must have `content:create`, else 403.
2. `isAnyProviderConfigured()` must be true, else 503 `NoImageProviderError`.
3. Burst rate limit `graphic-generate:<userId>`: **6 per 60 s**, else 429.
4. `requireEntitlement(companyId, 'imageGeneration')` must pass, else 402 when the monthly allowance is used up.
5. The body must pass `generateGraphicSchema`:

   | Field | Rule |
   |---|---|
   | `prompt` | 20–1500 chars |
   | `negativePrompt` | ≤ 400 |
   | `originalPrompt` | ≤ 1500 |
   | `provider` | one of `IMAGE_PROVIDERS` |
   | `aspectRatio` | one of the supported ratios |
   | `customWidth` / `customHeight` | 256–4096 |
   | `style` | default `professional` |
   | `variations` | 1–4, default 1 |
   | `logo` | `{mode, position = bottom-right, tint = original}` |

6. **Clamp:** `variations = min(requested, plan.maxImagesPerRequest, maxImagesPerMonth − assetsThisMonth)`. If the result is below 1, the route returns 402. If it clamped, the response carries a `planNote`.
7. `enqueueJob({kind:'IMAGE_GENERATION', dedupeOn:{draftId}})`:
   - The same request again (for example a double-click) reuses the running job and returns 200 with `reused: true`.
   - A **different** request while a run is in flight for this draft returns 409.
   - A new job returns 202 with `{jobId, status, progress}`.

The client then calls `POST /api/jobs/:id/run` and polls `GET /api/jobs/:id`. Those routes belong to [24-platform-jobs-and-deployment](../24-platform-jobs-and-deployment/).

### 3.3 The job runner (`server/jobs/runners.ts`, `IMAGE_GENERATION`)

The runner re-validates `job.inputs` with `imageJobInputsSchema`, reports "Loading your post…" (10 %) and loads the draft. It then branches:

- **`inputs.variant`** runs `regenerateVariant` or `refineVariant`. `make_space` is `refineVariant` with `makeSpace`. Progress is 35 %, then 95 %.
- **`inputs.creative`** runs `generateCreative(...)`.
- **Otherwise** it calls `generateGraphics(...)` with `jobId` (35 %, then 90 %).

Job rules come from `server/jobs/job.service.ts`:

| Rule | Value |
|---|---|
| Attempts | `MAX_ATTEMPTS = 3` |
| An `IMAGE_GENERATION` job counts as stuck after | **3 min** of inactivity (`STUCK_AFTER_MS_BY_KIND`) |
| A queued job is considered orphaned after | 60 s |
| Time budget for `/api/jobs/[id]/run` | `maxDuration = 60` |

### 3.4 `generateGraphics` pipeline (`server/media/generation.service.ts`)

The steps run in this order:

1. **Resolve the provider.** `resolveProvider(requested)`:
   - An explicit choice must exist (else 400) and be configured (else 503). The service never silently substitutes another provider.
   - With no choice, it takes the first configured provider in registry order: **OpenAI → Google → Agnes → Hugging Face → Stability → Replicate**.
   - With no provider configured at all, it throws `NoImageProviderError` (503, `retryable = false`).
2. **Resolve the format.** `resolveFormat` (`server/media/aspect.ts`) uses the explicit ratio. Failing that it uses the visual brief's ratio, then the platform default. It is then mapped to the provider's `supportedRatios` by **log-ratio distance** (`nearestSupportedRatio`), and any substitution is reported as `substitutedFrom`.

   A Custom width×height is always mapped to the nearest supported shape and flagged as substituted. Pixel sizes come from `RATIO_DIMENSIONS`:

   | Ratio | Size (px) |
   |---|---|
   | 1:1 | 1024×1024 |
   | 4:5 | 1024×1280 |
   | 16:9 | 1344×768 |
   | 9:16 | 768×1344 |
3. **Count.** `requested = clamp(variations, 1, MAX_VARIATIONS = 4)`, then `variations = min(requested, provider.maxImagesPerRequest)`.
4. **Resume.** `assetsForJob(companyId, jobId)` finds assets already stamped `metadata.jobId`. Only the shortfall is generated. If nothing is left to make, the run returns what exists without spending again.
5. **Build the prompt.**
   - Append `Style: <STYLE_DIRECTION[style]>` unless that direction is already in the prompt.
   - If the logo mode is not `none`, append `logoSpaceInstruction(position)`: keep that corner (about a fifth of the width) clean, and draw no logo or lettering.
6. **Generate.** `provider.generateImage({prompt, negativePrompt, aspectRatio, width, height, numberOfImages: remaining, style})`. On failure it writes the audit `GRAPHIC_GENERATION_FAILED` and rethrows.
7. **Store each image** with `persistImage` (see 3.6). For logo mode `include`, `placeLogoOn(..., hideSource: true)` then creates a version with the logo and hides the logo-free copy. One bad image does not lose the others; the rejection reason is collected.
8. **Finish.** If no asset survived, the service writes `GRAPHIC_GENERATION_FAILED` and throws `ImageProviderError` (502). Otherwise it writes the audit `GRAPHIC_GENERATED` with provider, model, count, requested, resumed, aspectRatio, style and storage.

   The result is `{assets, provider, model, aspectRatio, substitutedFrom?, warning?, alternatives}`. `warning` is set when fewer images came back than were **requested**. `alternatives` lists the other configured providers.

`fanOutFailure()` (`server/media/types.ts`) decides how an empty fan-out fails:
- An `ImageProviderError` is rethrown untouched.
- A transport error matching `timeout|abort|socket|network|ECONNRESET|ETIMEDOUT|fetch failed` becomes "did not respond in time" and is retryable.
- Anything else is a non-retryable 502 that carries the underlying message.

### 3.5 Image providers (`server/media/providers/`)

| Provider (`ImageProvider`) | File | Default model (env override) | Credential env | Ratios | Max/request | Can edit (refine) | Timeout |
|---|---|---|---|---|---|---|---|
| `OPENAI` | `openai.ts` | `gpt-image-1` (`OPENAI_IMAGE_MODEL`) | `OPENAI_API_KEY` | 1:1, 4:5, 16:9 | 4 | Yes, when the model starts with `gpt-image` | 120 s |
| `GOOGLE` | `gemini.ts` | `gemini-3.1-flash-lite-image` (`GOOGLE_IMAGE_MODEL`) | `GOOGLE_AI_API_KEY` (also accepts `GEMINI_API_KEY`, `GOOGLE_GEMINI_API_KEY`) | 1:1, 4:5, 16:9, 9:16 | 4 | Yes for `gemini-*`, no for `imagen-*` | 25 s per attempt, 1 retry (edit: 45 s) |
| `AGNES` | `agnes.ts` | `agnes-image-2.0-flash` (`AGNES_IMAGE_MODEL`), base `https://api.agnes-ai.com/api/v1` (`AGNES_API_BASE_URL`) | `AGNES_API_KEY` | 1:1 | 4 | No | 120 s |
| `HUGGINGFACE` | `huggingface.ts` | `black-forest-labs/FLUX.1-schnell` (`HUGGINGFACE_MODEL_ID`), base `https://api-inference.huggingface.co/models` (`HUGGINGFACE_API_BASE`) | `HUGGINGFACE_API_KEY` | 1:1, 4:5, 16:9, 9:16 | 4 | No | 120 s |
| `STABILITY` | `stability.ts` | `stable-image-core` (`STABILITY_IMAGE_MODEL`) | `STABILITY_API_KEY` | 1:1, 4:5, 16:9, 9:16 | 4 | No | 90 s |
| `REPLICATE` | `replicate.ts` | `black-forest-labs/flux-1.1-pro` (`REPLICATE_IMAGE_MODEL`) | `REPLICATE_API_TOKEN` | 1:1, 4:5, 16:9, 9:16 | 4 | No | 180 s poll |

The Google provider picks its API from the model name:
- `imagen-*` uses `:predict`, which returns `predictions[].bytesBase64Encoded`.
- `gemini-*` uses `:generateContent` with `responseModalities` including IMAGE, which returns `inlineData` parts.

Its label follows the model ("Google Imagen" / "Google Gemini"). A 404 tells the user to set `GOOGLE_IMAGE_MODEL`.

`listProviders()` returns `{id, label, model, description, configured, credentialEnv, supportedRatios, maxImagesPerRequest, canEdit}`. It never returns key values. `resolveEditProvider(preferred)` picks the provider that made the image if that provider can edit, else the first configured provider that can.

### 3.6 Validation and storage

`persistImage` (`server/media/persist.ts`) validates, stores, then creates the row:

- **`validateImageBytes`** (`server/media/validate.ts`):
  - Rejects empty files and files over `MAX_ASSET_BYTES` = **12 MB**.
  - Sniffs magic bytes and accepts only PNG, JPEG or WEBP, whatever the provider's `Content-Type` says.
  - Reads the real dimensions from the file header and rejects a longest edge over `MAX_ASSET_DIMENSION` = **4096 px**.
- **`putImage`** (`server/media/storage.ts`):
  - Without `ASSET_S3_*` configured, the bytes go into `GeneratedAsset.data` (`storage = DATABASE`).
  - With a bucket configured, the image is PUT to `graphics/<companyId>/<assetId>.<ext>` using hand-written AWS SigV4 (`storage = EXTERNAL`, `storageUrl`).
  - If the bucket upload fails, the bytes fall back to the database.
- **`createAsset`** writes the row. Both prompts, the provider's `revisedPrompt`, `sourceUrl` (for traceability only) and `metadata.jobId` are kept.

Assets are served by `GET /api/content/graphics/:assetId/file`:

| Topic | Behaviour |
|---|---|
| Auth | Either a session plus membership of the asset's own company, or a valid **signed URL**: HMAC-SHA256 over `assetId.exp`, keyed on `NEXTAUTH_SECRET` (fallback `ENCRYPTION_KEY`). The default TTL is **15 min** and the comparison is constant-time |
| Unauthorised requests | Get 404, not 403, so asset ids are not confirmed |
| `?format=jpeg` | Re-encodes non-JPEG images with sharp, because Instagram accepts JPEG only |
| Video | A 302 redirect to a presigned bucket GET (`readableUrl`) |
| Response headers | `cache-control: private, max-age=31536000, immutable` and `nosniff` |

`publish.service.ts` uses `signedAssetUrl(...)` for Instagram (15-minute TTL, `format=jpeg` for non-JPEG) and gives videos a presigned bucket URL with a 1 h TTL. WhatsApp also uses `signedAssetUrl`.

### 3.7 Uploads and URL import (`server/media/upload.service.ts`, `POST /api/content/graphics/upload?draftId=`)

Limits:

| Path | Cap |
|---|---|
| Multipart upload | **4,000,000 bytes**, enforced by the route (`MAX_UPLOAD_BYTES`) |
| Remote image import | 15 MB, 20 s timeout |
| Video, upload or import | **100 MB** (`MAX_VIDEO_BYTES`), 45 s timeout |

Rules:
- A multipart file that `looksLikeVideo` goes to `ingestVideo`; anything else goes to `ingestImage`.
- **URL import is protected against SSRF:**
  - Only `http(s)` URLs are allowed.
  - Private hosts are refused: localhost, `::1`, link-local, `fc`/`fd` addresses, and the IPv4 ranges 127/0/10/169.254/172.16–31/192.168.
  - Redirects are followed manually, at most 3, and each hop is re-checked.
  - The streaming size cap is enforced while bytes arrive.
- **Images** are validated like generated ones and stored with `provider = UPLOAD`, `model = 'upload' | 'remote-url'`, and `aspectRatio = closestRatioFor(w,h)`.
- **Videos** are inspected with `inspectVideo` (`lib/video.ts`). The codec must be `avc1`, `avc3`, `hvc1` or `hev1`. Videos are stored **only in the bucket** (`videos/<companyId>/<id>.mp4|mov`). Without `ASSET_S3_*` the upload fails with 409 ("Videos need file storage…").
- Both kinds write the audit `GRAPHIC_GENERATED` with `origin`.
- A published draft refuses uploads with 409.

### 3.8 Attaching media (`server/media/asset.service.ts`)

- **`attachAsset`:**
  - Checks that both the draft and the asset belong to the company, and refuses PUBLISHED drafts with 409.
  - `replace = true` (the default) swaps the post's media.
  - `replace = false` appends at `position = count`, which is how a carousel is built.
  - The same asset twice is an upsert (`@@unique([contentDraftId, assetId])`).
  - The change goes through `recordContentChange(... action: 'media_changed')` (`lib/approval.ts`), so **swapping an image on approved work reopens the approval** (see [13-review-approval-versions-and-trace](../13-review-approval-versions-and-trace/)).
  - Writes the audit `GRAPHIC_ATTACHED` (with `reopenedApproval`).
- **`detachAsset`:** same approval hook, audit `GRAPHIC_DETACHED`. Returns 404 if the asset was not attached.
- **`deleteAsset`:** refused (409) when the asset is used by a PUBLISHED post. Otherwise it deletes the row (the `ContentMedia` rows cascade), deletes the bucket object best-effort, and writes the audit `GRAPHIC_DELETED`.
- **`getAttachedMedia`:** returns ordered media, each with `validateForPlatform` problems:
  - Images are checked against the platform's accepted MIME types, maximum file size, minimum short edge and maximum long edge.
  - Videos can only be published to Instagram: MP4/MOV, ≤ 300 MB, 3 s to 15 min.
  - `validateMediaSet` requires at least one item for Instagram and no more than `MAX_CAROUSEL_ITEMS = 10`.

Platform media limits come from `PLATFORM_SPECS` in `lib/platforms.ts`:

| Platform | Ratios (default first) | MIME | Max size | Min edge | Max edge |
|---|---|---|---|---|---|
| LinkedIn | 1:1, 4:5, 16:9 | png, jpeg | 10 MB | 200 | 4000 |
| Instagram | **4:5**, 1:1, 9:16 | jpeg, png (PNG served as JPEG) | 8 MB | 320 | 1440 |
| X | **16:9**, 1:1 | png, jpeg, webp | 5 MB | 200 | 4096 |
| Facebook | 1:1, 4:5, 16:9 | png, jpeg | 8 MB | 200 | 4000 |

### 3.9 Monthly usage (`assetsThisMonth`)

The usage figure is the count of `GeneratedAsset` rows since the first day of the month (UTC), **minus** creatives (`metadata.kind = 'creative'`) **minus** logo versions (`metadata.variant.action = 'logo'`). Both of those reuse an image that has already been counted. `requireEntitlement('imageGeneration')` and the studio meter use this same count.

| Plan | `maxImagesPerMonth` | `maxImagesPerRequest` |
|---|---|---|
| TRIAL | 20 | 2 |
| STARTER | 100 | 2 |
| GROWTH | 500 | 4 |
| AGENCY | 4000 | 4 |

### 3.10 Variants, versions and the logo (`server/media/variant.service.ts`)

Lineage is stored in `GeneratedAsset.metadata`, with no extra schema:
- `variant: {rootId, parentId, version, action: generated|refined|regenerated|logo, instruction}`
- `logo: {mode, position, applied, reason, box, tint, tintColor}`
- `cleanId`: the logo-free source
- `hidden: true`: marks that logo-free copy

`nextVersion` takes the highest version under the same `rootId` and adds 1. Nothing is ever overwritten.

Each action works as follows:
- **Refine** (`POST …/refine`, instruction 3–1000 chars):
  1. Needs an edit-capable provider (Gemini image model or `gpt-image-1`), else 503.
  2. Edits the **logo-free** source with `refinePrompt`: the instruction, plus "keep subject, composition, palette, mood…", no text or logos, and a logo-space instruction if needed.
  3. Stores the result as the next version, then places the logo again if the mode is `include`.
  4. For a creative, the *photo* is refined and the creative is re-composed from its stored spec.
- **Regenerate** (`POST …/regenerate`):
  - Re-runs the root's prompt (with the `\n\nRefined:` suffix stripped) on the root's provider.
  - Refused for uploads ("refine it instead") and for creatives ("New photo, keep text").
- **Logo** (`POST …/logo`):
  - **`space`** queues a `make_space` job. It is refine with `makeSpaceInstruction`, which clears the corner and removes any lettering, and needs an edit-capable provider.
  - **`include`** runs synchronously. `placeLogoOn` composites the logo over the logo-free source. If mode, position and tint are all unchanged it is a no-op.
  - **`none`** stores a copy of the logo-free image as the next version.
- **`overlayLogo`** (`server/media/logo-overlay.ts`, sharp):
  - The logo fits a box of **20 % of the width × 12 % of the height**.
  - The margin is **4.5 %** of the short edge.
  - The image is refused if the logo would be smaller than 24 px.
  - Tints: `original` (the uploaded pixels), `white` (#ffffff), `black` (#000000), or `brand` (the workspace primary colour; with no valid hex the logo is left unchanged). Recolouring keeps the alpha channel and happens before resizing.
  - The output is always PNG.
  - The logo comes from Business Context `identity.visual.logoAssetId`. A logo that is only a URL cannot be placed, and the reason recorded is "Upload the logo file in Settings → Brand…".

Variant jobs go through `queueVariantJob` (`app/api/content/graphics/[assetId]/_variant.ts`):
- The same 6/min `graphic-generate` burst limit applies.
- The entitlement and monthly allowance are checked.
- They are deduplicated per draft (409 on conflicting input).
- The asset must have been made for the draft in the request (400 otherwise).
- PUBLISHED drafts return 409.

### 3.11 Marketing creatives (`server/media/creative/creative.service.ts`)

`POST /api/content/drafts/:id/creative` checks a burst limit (`creative-generate`, 6/min). For `photo: 'new'` with a provider configured, it also checks the entitlement and returns 402 when the month's allowance is spent. It then queues `IMAGE_GENERATION` with `inputs.creative`.

`generateCreative` runs these steps:

1. **Idempotency.** A retried job returns the asset already stamped with `metadata.creativeJobId`.
2. **Copy** (`writeCopy` / `buildSpec`):
   - Text the user typed is **locked** and used exactly.
   - Otherwise an LLM writes `copySchema` (`tier 'standard'`, `effort 'low'`, `maxTokens 900`).
   - A guard then checks each line:
     - `figuresBacked` drops any figure not found in the user's text, the post, the recommendation's evidence or the business facts.
     - `detailBacked` drops a date, time, venue, offer or event name that was not in the user's request.
     - Each removal is reported in `removed[]`.
   - The type defaults to `detectCreativeType` (regex signals: greeting, offer, event, product launch, retail promo, educational, announcement, promotion; otherwise `b2b` or `brand_awareness`).
   - `chooseLayout` uses `TYPE_LAYOUTS` and drops the `offer` layout when there is no offer.
   - `chooseFontPair` works from the brand tone and type.
   - CTA defaults come from `CTA_DEFAULT` (for example event gives "Register now"; greeting gives none).
   - Every text field records its source: `you`, `your request`, `your post`, `business` or `aura`.
3. **Photo.** Only when `photo = 'new'`:
   - `buildPhotoPrompt` (`lib/creative/photo-prompt.ts`) writes the prompt: lens by type or mood, lighting by mood, realism and people direction, calm space where the layout puts text, no text. It is capped at 1500 chars.
   - The photo is made by `generateGraphics(... style 'photo', variations 1)`.
   - On no provider, quota, 429 or an empty result, `spec.photo.fallback = true` with a reason, and the creative is made on a brand-colour background. The UI labels it as such.
4. **Render** (`server/media/creative/render.ts`):
   - satori lays out the element tree for the layout at `CREATIVE_FORMATS` size. resvg rasterises it to PNG with system fonts off.
   - Fonts are the bundled WOFFs in `assets/fonts/` (Inter 400/600/800, InterExt 400/800 for ₹ and extended Latin, Montserrat 700/800, Playfair Display 700, Bebas Neue 400; OFL licensed), measured with `assets/fonts/metrics.json` through `lib/creative/text-fit.ts`.
   - A headline that cannot fit raises `CreativeFitError` (422).
   - The `offer` layout with no offer falls back to `hero` and adds a warning.
   - `brandPalette()` fills in missing brand colours (default primary `#14213D`, secondary `#1F3A5F`, accent `#F5B700`) and enforces contrast: the accent must have at least 1.6:1 against the primary, and `deepen()` darkens a colour until white text on it reaches 4.5:1.
5. **Store** (`composeAndStore`):
   - Stored as an ordinary `GeneratedAsset`: `model = aura-creative/<layout>`, `provider` = the photo's provider (or `UPLOAD` when there is no AI photo), `metadata.kind = 'creative'` with the full `spec`, warnings and removals.
   - Audit `GRAPHIC_GENERATED`.
   - Creatives do **not** count toward the monthly allowance.

`POST /api/content/drafts/:id/creative/render` re-sets text, layout, format or colours on the existing photo, or with no photo. It is **synchronous** (`maxDuration = 30`, burst limit 20/min). It rejects `photo: 'new'` with 400 and returns 201 with the new creative asset.

### 3.12 Free-text generator (`POST /api/generate-image`)

The route works as follows:
- It requires `content:create` and the `imageGeneration` entitlement.
- Rate limit `generate-image:<userId>`: **10 per 60 s**.
- Body: `prompt` 1–2000 chars, `model` ≤ 120 chars, `realistic` (default true).
- When `realistic` is true, `withPhotoRealism(prompt)` adds camera, realism and people direction plus a negative prompt, unless the prompt asks for a non-photo style (illustration, cartoon, vector, 3D render, …).
- `model` routing:
  - `huggingface` or any `flux*` goes to an inline Hugging Face call (45 s timeout). Errors map to specific messages: 503 means the model is loading ("try again in N seconds"); 429, 401, 403 (the token is missing the "Make calls to Inference Providers" permission) and 404 have their own messages.
  - `nano-banana`, `gemini` or `google` go to `googleImageProvider`.
  - `agnes` goes to `agnesImageProvider`, at 1:1 1024×1024, one image.
  - Anything else returns 422.
- `maxDuration = 60`.
- The response is `{imageUrl: "data:<mime>;base64,…"}`, and nothing is persisted.

## 4. Code map

| Layer | File | Responsibility |
|---|---|---|
| Page | `app/dashboard/content/[id]/page.tsx` | Mounts VisualBriefPanel, CreativeStudio, GraphicStudio, AgnesImageGenerator and PostComposer. Computes `canEdit` and loads assets, attached ids, the active job and the visual brief |
| Component | `components/dashboard/content/graphic-studio.tsx` | Prompt, edit, provider/format/style/variations/logo, generate (job + poll), history, upload/URL import, attach/delete, usage meter |
| Component | `components/dashboard/content/image-variant-panel.tsx` | Versions of one variant side by side; refine, regenerate, logo actions |
| Component | `components/dashboard/content/creative-studio.tsx` | Creative form, generate (job), re-render, refine, attach |
| Component | `components/dashboard/content/visual-brief-panel.tsx` | Shows the visual brief, readiness and fix links |
| Component | `components/dashboard/content/agnes-image-generator.tsx` | Free-text image generation through `/api/generate-image` |
| Component | `components/dashboard/content/post-composer.tsx` | Attached media with problems, detach, queue |
| Component | `components/ui/image-lightbox.tsx` | Full-screen image preview (keyboard navigation, download) |
| API | `app/api/content/drafts/[id]/graphics/route.ts` | GET history plus active job; POST queue generation |
| API | `app/api/content/drafts/[id]/graphics/prompt/route.ts` | POST write image prompt |
| API | `app/api/content/drafts/[id]/creative/route.ts` | GET creatives, photos, brand, active job; POST queue creative |
| API | `app/api/content/drafts/[id]/creative/render/route.ts` | POST synchronous re-render of a creative |
| API | `app/api/content/graphics/providers/route.ts` | GET provider statuses, usage, active store |
| API | `app/api/content/graphics/upload/route.ts` | POST multipart upload or URL import (image/video) |
| API | `app/api/content/graphics/[assetId]/route.ts` | GET asset view; DELETE asset |
| API | `app/api/content/graphics/[assetId]/file/route.ts` | GET bytes (session or signed URL; JPEG conversion; video redirect) |
| API | `app/api/content/graphics/[assetId]/attach/route.ts` | POST attach / DELETE detach |
| API | `app/api/content/graphics/[assetId]/refine/route.ts` | POST queue refine |
| API | `app/api/content/graphics/[assetId]/regenerate/route.ts` | POST queue regenerate |
| API | `app/api/content/graphics/[assetId]/logo/route.ts` | POST logo include/none (synchronous) or space (queued) |
| API | `app/api/content/graphics/[assetId]/_variant.ts` | Shared guard and enqueue for variant actions |
| API | `app/api/generate-image/route.ts` | Free-text generation, not persisted |
| Service | `server/media/generation.service.ts` | `generateGraphics`, `MAX_VARIATIONS = 4`, resume by `jobId` |
| Service | `server/media/image-prompt.service.ts` | `generateImagePrompt`, `heuristicPrompt`, `UNIVERSAL_RULES` |
| Service | `server/media/visual-brief.service.ts` | `visualBriefForDraft` (stored Content Brief, else Business Context) |
| Service | `server/media/variant.service.ts` | `placeLogoOn`, `refineVariant`, `regenerateVariant`, `setVariantLogo`, `VariantError` |
| Service | `server/media/logo-overlay.ts` | `overlayLogo`, `tintColorFor`, `parseHex` (sharp) |
| Service | `server/media/asset.service.ts` | `toAssetView`, list/get/attach/detach/delete, `assetsForJob`, `assetsThisMonth`, `getAttachedMedia` |
| Service | `server/media/persist.ts` | `persistImage`: validate, store, create row |
| Service | `server/media/upload.service.ts` | `ingestImage`, `ingestVideo`, `fetchRemoteImage/Video` (SSRF guard) |
| Service | `server/media/storage.ts` | DB or S3 (SigV4) put/read/delete, `readableUrl` presign, `activeStore` |
| Service | `server/media/asset-url.ts` | `signedAssetUrl`, `verifyAssetSignature`, `assetFileUrl` |
| Service | `server/media/validate.ts` | Sniffing, dimensions, `MAX_ASSET_BYTES`, platform/video/set validation |
| Service | `server/media/aspect.ts` | `resolveFormat`, `nearestSupportedRatio`, `closestRatioFor` |
| Service | `server/media/jpeg.ts` | `toJpeg`, `needsJpeg` |
| Service | `server/media/types.ts` | Provider contract, `ImageProviderError`, `NoImageProviderError`, `fanOutFailure`, `STYLE_DIRECTION` |
| Service | `server/media/providers/index.ts` | Registry, `listProviders`, `resolveProvider`, `resolveEditProvider`, `alternativeProviders` |
| Service | `server/media/providers/{openai,gemini,agnes,huggingface,stability,replicate}.ts` | Vendor adapters |
| Service | `server/media/creative/creative.service.ts` | `loadBrand`, `writeCopy`, `buildSpec`, `composeAndStore`, `generateCreative`, `creativesForDraft`, `specOf` |
| Service | `server/media/creative/render.ts` | `renderCreative` (satori + resvg), six layouts, `CreativeFitError` |
| Service | `server/media/creative/fonts.ts` | Loads bundled faces, `DISPLAY`/`BODY` pairs |
| Service (consumer) | `server/media/publishers/{facebook,instagram,linkedin-image}.ts` | Network publishers that read stored assets. Covered in [20-publishing-execution-and-scheduling](../20-publishing-execution-and-scheduling/) |
| Jobs | `server/jobs/runners.ts` (`IMAGE_GENERATION`) | Dispatches to generation, creative or variant |
| Lib | `lib/visual-brief.ts` | `visualBriefSchema`, `buildVisualBrief`, `visualBriefToPrompt`, `visualBriefStarterPrompt`, `VISUAL_RULES` |
| Lib | `lib/photo-realism.ts` | Realism and people direction, `photoNegativeFor`, `mergeNegative` (cap 400), `withPhotoRealism` |
| Lib | `lib/image-variants.ts` | Logo modes, positions and tints; lineage readers; `refinePrompt`; `groupVariants` |
| Lib | `lib/graphics-ui.ts` | `IMAGE_STYLES`, labels, format hints, `groupByDay`, `aspectClass` |
| Lib | `lib/creative/spec.ts` | Creative types, layouts, formats, fonts, moods, `creativeInputSchema`, palette and contrast, `figuresBacked`/`detailBacked` |
| Lib | `lib/creative/photo-prompt.ts` | `buildPhotoPrompt` |
| Lib | `lib/creative/text-fit.ts` | `measure`, `wrap`, `fitText` from font metrics |
| Lib | `lib/video.ts` | `looksLikeVideo`, `inspectVideo` (MP4/MOV box parse), `isSupportedCodec` |
| Lib | `lib/validations/media.ts` | All Zod schemas plus the `IMAGE_PROVIDERS` mirror |
| Lib | `lib/platforms.ts` | `ASPECT_RATIOS`, `RATIO_DIMENSIONS`, `PLATFORM_SPECS` |
| Assets | `assets/fonts/*.woff`, `metrics.json`, `LICENSES` | Bundled creative typography |
| Tests | `tests/*.test.ts` (see §10) | Unit coverage |
| Scripts | `scripts/verify-graphics.ts`, `verify-creative.ts`, `verify-visual-context.ts`, `verify-image-preview.ts` | End-to-end verification |

## 5. Data model

The models live in `prisma/schema.prisma`.

**`GeneratedAsset`** holds every image or video: generated, uploaded, logo version, or creative.
- `id`, `companyId` (FK Company, cascade)
- `contentDraftId?` (FK ContentDraft, **SetNull**, so deleting a draft does not destroy a reused graphic), `createdById?` (FK User, SetNull)
- `provider ImageProvider`, `model`, `kind MediaKind` (default IMAGE)
- `prompt`, `originalPrompt?`, `revisedPrompt?`, `negativePrompt?`, `style?`
- `aspectRatio`, `width`, `height`, `mimeType`, `fileSize`
- `storage AssetStorageKind` (default DATABASE), `data Bytes?`, `storageUrl?`, `sourceUrl?`
- `platform SocialPlatform?`, `metadata Json` (default `{}`), `createdAt`
- Indexes: `[companyId, createdAt]`, `[contentDraftId, createdAt]`

`metadata` keys used by this feature: `jobId`, `creativeJobId`, `variant{…}`, `logo{…}`, `cleanId`, `hidden`, `kind: 'creative'`, `spec`, `warnings`, `removed`, `origin`, `filename`, `durationSec`, `codec`, plus provider extras (seed, model, safety).

**`ContentMedia`** is the ordered attachment of an asset to a post.
- `id`, `companyId`, `contentDraftId` (cascade), `assetId` (cascade), `kind`, `position` (0 = first), `altText?`, `createdAt`
- `@@unique([contentDraftId, assetId])`
- Indexes: `[contentDraftId, position]`, `[assetId]`

**Enums**

| Enum | Values |
|---|---|
| `ImageProvider` | `OPENAI`, `GOOGLE`, `AGNES`, `HUGGINGFACE`, `STABILITY`, `REPLICATE`, `UPLOAD` |
| `AssetStorageKind` | `DATABASE`, `EXTERNAL` |
| `MediaKind` | `IMAGE`, `VIDEO` |

**Used, but owned by other features:**
- `GenerationJob`: `kind = IMAGE_GENERATION`, `inputs`, `progress`, `result`, `attempts`. See [24-platform-jobs-and-deployment](../24-platform-jobs-and-deployment/).
- `ContentDraft.aiMetadata.brief.visual`: the stored visual brief. See [11-content-studio](../11-content-studio/).
- Business Context `identity.visual`: brand colours, `logoAssetId`, `logoUrl`. See [05-business-context](../05-business-context/).
- `AuditLog` through `recordAudit`.

## 6. API endpoints

See also [Internal API](../../04-api/INTERNAL-API.md). Every route uses `requireActiveCompany()` (session plus active workspace) unless noted otherwise.

| Method | Path | Purpose | Auth/permission |
|---|---|---|---|
| GET | `/api/content/drafts/:id/graphics` | Asset history for the draft (`?scope=company` for all), active non-creative job | Member of workspace |
| POST | `/api/content/drafts/:id/graphics` | Queue a generation job (202 new / 200 reused / 409 conflicting) | `content:create`, 6/min, `imageGeneration` entitlement, monthly clamp |
| POST | `/api/content/drafts/:id/graphics/prompt` | AI or heuristic image prompt plus visual brief | `content:create`, 20/min |
| GET | `/api/content/drafts/:id/creative` | Creatives (with spec), photos, brand palette, `providerConfigured`, active creative job | Member |
| POST | `/api/content/drafts/:id/creative` | Queue a creative job | `content:create`, 6/min, entitlement when `photo='new'` |
| POST | `/api/content/drafts/:id/creative/render` | Re-render on the existing photo (no generation), 201 | `content:create`, 20/min |
| GET | `/api/content/graphics/providers` | Provider statuses, usage `{used, limit, remaining, maxPerRequest, plan}`, `storage` | Member |
| POST | `/api/content/graphics/upload?draftId=` | Multipart file (≤ 4 MB) or JSON `{url, kind}` import | `content:create`, 20/min, draft not PUBLISHED |
| GET | `/api/content/graphics/:assetId` | One asset view (`?draftId=` sets `attached`) | Member |
| DELETE | `/api/content/graphics/:assetId` | Delete (409 if used by a published post) | `content:create` |
| GET | `/api/content/graphics/:assetId/file` | Asset bytes; `?format=jpeg`; video redirects | Session plus membership of the asset's company, **or** a valid `exp`+`sig` signature. 404 otherwise |
| POST | `/api/content/graphics/:assetId/attach` | Attach `{draftId, altText?, replace=true}` and return media | `content:create` |
| DELETE | `/api/content/graphics/:assetId/attach` | Detach `{draftId}` | `content:create` |
| POST | `/api/content/graphics/:assetId/refine` | Queue refine `{draftId, instruction}` | `content:create`, 6/min, entitlement, edit-capable provider |
| POST | `/api/content/graphics/:assetId/regenerate` | Queue regenerate `{draftId}` | `content:create`, 6/min, entitlement |
| POST | `/api/content/graphics/:assetId/logo` | `{draftId, mode, position, tint}`: include/none run synchronously, space is queued | `content:create`; space also needs the entitlement and an edit-capable provider |
| POST | `/api/generate-image` | Free-text prompt to a `data:` URI image (not stored) | `content:create`, `imageGeneration` entitlement, 10/min |

The jobs routes (`POST /api/jobs/:id/run`, `GET /api/jobs/:id`) and `/api/cron/jobs` belong to [24-platform-jobs-and-deployment](../24-platform-jobs-and-deployment/). Note that `features.json` lists `/api/content/media` and `/api/content/creative`, but those paths do not exist. Creatives are served under `/api/content/drafts/:id/creative`.

## 7. External services

The full list of variables is in [Environment variables](../../06-environment/ENVIRONMENT-VARIABLES.md).

| Service | Used for | Env vars |
|---|---|---|
| OpenAI Images | Generate and edit (`gpt-image-1`) | `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL` |
| Google Generative Language API (Gemini image / Imagen) | Generate; edit (Gemini only); the free-text "nano-banana" option | `GOOGLE_AI_API_KEY` (or `GEMINI_API_KEY` / `GOOGLE_GEMINI_API_KEY`), `GOOGLE_IMAGE_MODEL` |
| Agnes AI | Generate (1:1); free-text option | `AGNES_API_KEY`, `AGNES_API_BASE_URL`, `AGNES_IMAGE_MODEL` |
| Hugging Face Inference | Generate (FLUX.1-schnell); free-text default | `HUGGINGFACE_API_KEY`, `HUGGINGFACE_MODEL_ID`, `HUGGINGFACE_API_BASE` |
| Stability AI | Generate | `STABILITY_API_KEY`, `STABILITY_IMAGE_MODEL` |
| Replicate | Generate (any hosted model) | `REPLICATE_API_TOKEN`, `REPLICATE_IMAGE_MODEL` |
| S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO) | Optional image storage; **required** for video | `ASSET_S3_ENDPOINT`, `ASSET_S3_BUCKET`, `ASSET_S3_ACCESS_KEY_ID`, `ASSET_S3_SECRET_ACCESS_KEY`, `ASSET_S3_REGION` (default `auto`), `ASSET_S3_PUBLIC_BASE_URL` |
| LLM through the AI layer (`server/ai/claude.ts`) | Image prompt and creative copy | See [23-ai-layer](../23-ai-layer/) |
| Signing secret | Signed asset URLs | `NEXTAUTH_SECRET` (fallback `ENCRYPTION_KEY`) |

All provider keys are read server-side only, never through `NEXT_PUBLIC_*`. Local libraries used: `sharp` (logo overlay, JPEG conversion), `satori` and `@resvg/resvg-js` (creatives).

## 8. Background jobs & cron

- **`GenerationJob` kind `IMAGE_GENERATION`.** Created by the graphics, creative, refine, regenerate and logo-space routes. The client runs it with `POST /api/jobs/:id/run` (maxDuration 60 s) and polls `GET /api/jobs/:id`.
  - Progress messages include "Loading your post…", "Generating N images…", "Writing the words…", "Photographing the scene…", "Setting the type and layout…" and "Preparing previews…".
  - Retries: up to 3 attempts. Permanent errors (`retryable = false`, for example `NoImageProviderError`) fail immediately.
- **Resumability.** Every asset is stamped with `metadata.jobId` (generation) or `metadata.creativeJobId` (creative), so a retried run generates only the shortfall, or returns the creative it already made.
- **Reaper.** `POST /api/cron/jobs` (Bearer `CRON_SECRET`) calls `reapStuckJobs()` and runs up to 3 runnable jobs per sweep. An image job is considered stuck after 3 minutes without activity.
- **Reattach on reload.** `findActiveImageJob(companyId, draftId)` returns a queued or running job, which lets the studio reattach after a page reload.

## 9. Security & permissions

- **RBAC:** every mutating route checks `can(role, 'content:create')`. VIEWER gets 403. Read routes require workspace membership.
- **Workspace scoping:**
  - Every query filters by `companyId`.
  - `attachAsset` checks that the draft *and* the asset belong to the company.
  - Variant routes require `asset.contentDraftId === draftId`.
  - The file route checks membership of the **asset's own** company, not the session's active company.
- **Signed URLs:** HMAC-SHA256 over `assetId.exp`, expiry checked first, constant-time compare, 15-minute default TTL. A signature cannot be edited to point at another asset.
- **Cost controls:**
  - Burst rate limits per user: generate, variants and creative at 6/min; prompt, upload and render at 20/min; `/api/generate-image` at 10/min.
  - Plan monthly allowance and per-request cap.
  - A hard cap of 4 variations in the schema, the service and the provider.
  - Duplicate jobs are deduplicated per draft.
- **Input validation:** Zod schemas in `lib/validations/media.ts` and `lib/creative/spec.ts`. Job inputs are re-validated inside the runner.
- **Byte trust:** MIME type is taken from magic bytes, and dimensions from the file header. 12 MB and 4096 px caps apply. Responses send `x-content-type-options: nosniff`.
- **SSRF:** URL import refuses private and link-local hosts, re-checks every redirect hop (at most 3), and enforces a streaming size cap.
- **Secrets:** provider keys stay server-side. `listProviders()` returns the env var *name*, never its value. Provider error bodies are logged, not returned.
- **Immutability:** media on a PUBLISHED post cannot be attached, detached, uploaded or refined (409). An asset used in a published post cannot be deleted.
- **Approval coupling:** a media change on approved work reopens the approval through `recordContentChange`.
- **Content rules:** prompts forbid lettering, logos, celebrities and other brands' marks. Creative copy cannot introduce figures or details the user did not give.

## 10. Testing

Unit tests in `tests/` (Vitest):

| File | Covers |
|---|---|
| `image-generation.test.ts` | `generateGraphics`: partial success, resume, shortfall warning, audit |
| `image-providers.test.ts` | Provider adapters; keys never leaked in the providers payload |
| `image-provider-registry-sync.test.ts` | `IMAGE_PROVIDERS` matches the Prisma enum and the registry |
| `gemini-image-provider.test.ts` | Imagen vs Gemini request shapes, error mapping |
| `image-aspect.test.ts` | `resolveFormat`, nearest ratio, custom sizes |
| `image-prompt.test.ts` | Prompt service and heuristic fallback |
| `image-variants.test.ts` | Lineage, refine/regenerate/logo versions |
| `logo-overlay.test.ts` | Overlay geometry, tints, alpha preservation |
| `photo-realism.test.ts` | Realism direction, negative-prompt ordering and cap |
| `visual-brief.test.ts` | `buildVisualBrief` readiness and missing fields |
| `creative.test.ts` | Creative spec, type detection, palette/contrast, fact guards |
| `media-validate.test.ts` | Sniffing, dimensions, platform/video/set validation |
| `media-upload.test.ts` | Ingest image/video, SSRF guard, size caps |
| `media-storage.test.ts` | DB vs S3 storage, SigV4, presign |
| `asset-url.test.ts` | Signing, verifying, expiry |
| `instagram-media.test.ts`, `publish-media.test.ts` | Media handed to publishers (JPEG, carousel, video) |
| `graphic-studio.test.tsx`, `image-lightbox.test.tsx` | UI components |
| `job-dedupe.test.ts`, `job-permanent-failure.test.ts` | Job dedupe and non-retryable failure (shared with jobs) |

Verify scripts (`package.json`):

| Script | What it proves |
|---|---|
| `pnpm verify:graphics` | `scripts/verify-graphics.ts`: validate, store, persist, list, attach, platform validation, queue, read back, against the real DB with a real PNG (no paid provider call) |
| `pnpm verify:visual-context` | `scripts/verify-visual-context.ts`: the visual brief derived from a recommendation, the prompt built from it (Google stubbed), a failed run's reason, and the page shows the brief. Needs `VERIFY_BASE_URL` |
| `pnpm verify:creative` | `scripts/verify-creative.ts`: creative PNG size, photo brief, no invented details, fallback at the provider limit, re-render, unfittable headline, roles, approval. Needs the app running |
| `pnpm verify:image-preview` | `scripts/verify-image-preview.ts`: the lightbox in Chromium (playwright-core) at phone, tablet and desktop widths |

## 11. Configuration & limits

| Setting | Value | Where |
|---|---|---|
| Max variations per request (hard) | 4 | `MAX_VARIATIONS`, `generateGraphicSchema` |
| Plan per-request cap | 2 (Trial/Starter), 4 (Growth/Agency) | `PLAN_LIMITS` |
| Plan monthly images | 20 / 100 / 500 / 4000 | `PLAN_LIMITS` |
| Prompt length | 20–1500 (graphics), 1–2000 (free-text) | schemas |
| Negative prompt cap | 400 chars | `NEGATIVE_MAX`, schema |
| Custom size | 256–4096 px per side | `generateGraphicSchema` |
| Stored image max | 12 MB, 4096 px longest edge | `validate.ts` |
| Multipart upload max | 4,000,000 bytes | upload route |
| Remote image import | 15 MB, 20 s, 3 redirects | `upload.service.ts` |
| Video upload/import | 100 MB, 45 s; bucket required | `upload.service.ts` |
| Video publish rules (Instagram) | MP4/MOV, ≤ 300 MB, 3 s to 15 min | `VIDEO_RULES` |
| Carousel | ≤ 10 items | `MAX_CAROUSEL_ITEMS` |
| Signed URL TTL | 15 min (Instagram, WhatsApp) | `asset-url.ts`, `publish.service.ts` |
| Presigned bucket GET | 15 min default; 1 h for Instagram video; 5 min internal fetch | `storage.ts`, `publish.service.ts` |
| Logo box / margin / min size | 20 % × 12 %, 4.5 %, 24 px | `logo-overlay.ts` |
| Creative sizes | 1080×1080, 1080×1350, 1080×1920, 1920×1080 | `CREATIVE_FORMATS` |
| Creative render time limit | 30 s | render route |
| Generate-image time limit | 60 s; HF 45 s | `/api/generate-image` |
| Rate limits | 6/min generate, variant, creative; 20/min prompt, upload, render; 10/min free-text | routes |
| Job stuck after | 3 min (`IMAGE_GENERATION`) | `job.service.ts` |
| History page size | 60 default, 200 max | `listAssets` |
| Default storage | DATABASE; EXTERNAL when all four required `ASSET_S3_*` are set | `storage.ts` |

## 12. Known limitations & future work

- **The free-text generator does not persist.** `/api/generate-image` returns a `data:` URI. The image is not a `GeneratedAsset`, cannot be attached directly, and does not appear in history.
- **Provider timeouts against a 60 s budget.** The OpenAI, Agnes and Hugging Face adapters use 120 s timeouts, Stability 90 s and Replicate a 180 s poll, while `/api/jobs/[id]/run` has `maxDuration = 60`. Resumable jobs plus the reaper cover a killed run, but a slow provider can still need retries. Only Google is tuned to 25 s per attempt.
- **The reaper is not scheduled in `vercel.json`.** `/api/cron/jobs` is not in the crons list there (only publish, briefing and connections are), so recovering queued or stuck runs relies on the client kicking `/run` or an external scheduler.
- **Uploads count toward the monthly allowance.** `assetsThisMonth` subtracts only creatives and logo versions, so `UPLOAD` rows count against the image allowance.
- **Only some providers can edit.** Refine and "add logo later" need a Gemini image model or `gpt-image-1`. Agnes, Hugging Face, Stability, Replicate and Imagen cannot edit.
- **Agnes draws squares only** (1:1). Other ratios are substituted and reported.
- **Video** is ingest and Instagram-only. There is no video generation, and other networks are refused at validation ("post the video to … by hand").
- **No database fallback for video.** Without a bucket, video upload is refused.
- **A logo given only as a URL cannot be placed.** The logo must be an uploaded file (`logoAssetId`).
- **A stale UI label.** `lib/graphics-ui.ts` `PROVIDER_LABELS` lists only OPENAI ("Google Imagen"), GOOGLE, STABILITY and REPLICATE. The registry's own `label` is the authoritative one.
- **A stale code comment.** The comment in `/api/generate-image` says Hugging Face "is not part of that registry". It is now in the registry (`huggingFaceImageProvider`), although the route still calls it inline.

## 13. Related documents

- [GRAPHIC-GENERATION-TECHNICAL.md](../../../GRAPHIC-GENERATION-TECHNICAL.md): design decisions for the generation pipeline (partly out of date; see the mismatches in the report)
- [GRAPHIC-GENERATION-REPORT.md](../../../GRAPHIC-GENERATION-REPORT.md)
- [MARKETING-CREATIVES.md](../../../MARKETING-CREATIVES.md)
- [VISUAL-BRIEF.md](../../../VISUAL-BRIEF.md)
- [MEDIA-STORAGE.md](../../../MEDIA-STORAGE.md)
- [CONTENT-BRIEF.md](../../../CONTENT-BRIEF.md), [GENERATION-CONTEXT.md](../../../GENERATION-CONTEXT.md)
- [APPROVAL-MODEL.md](../../../APPROVAL-MODEL.md), [EXECUTION-ENGINE.md](../../../EXECUTION-ENGINE.md), [META-INTEGRATION.md](../../../META-INTEGRATION.md)
- Sibling features:
  - [11-content-studio](../11-content-studio/)
  - [13-review-approval-versions-and-trace](../13-review-approval-versions-and-trace/)
  - [05-business-context](../05-business-context/)
  - [20-publishing-execution-and-scheduling](../20-publishing-execution-and-scheduling/)
  - [22-billing-and-plans](../22-billing-and-plans/)
  - [23-ai-layer](../23-ai-layer/)
  - [24-platform-jobs-and-deployment](../24-platform-jobs-and-deployment/)
- [Architecture](./02-ARCHITECTURE.md)
