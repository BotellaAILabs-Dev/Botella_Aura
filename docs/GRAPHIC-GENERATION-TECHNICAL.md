# Graphic Generation — technical notes

Content Studio → Generate graphic. This document covers the design decisions
behind the feature; `README.md` covers configuration and troubleshooting.

---

## The pipeline

```
ContentDraft (existing)
      │
      ▼
ImagePromptGenerator          server/media/image-prompt.service.ts
  · renders the post to text (reuses server/content/render.ts)
  · injects brand voice (reuses Company.brandVoiceProfile) as VISUAL direction
  · injects platform art direction (lib/platforms.ts)
  · calls the existing LLM client (server/ai/claude.ts)
      │
      ▼  (the user edits the prompt — always)
      │
GenerationJob queue           server/jobs/ (EXISTING — kind IMAGE_GENERATION)
      │
      ▼
ImageGenerationService        server/media/generation.service.ts
      ├── OpenAI              server/media/providers/openai.ts
      ├── Google Imagen       server/media/providers/gemini.ts
      ├── Stability AI        server/media/providers/stability.ts
      └── Replicate           server/media/providers/replicate.ts
      │
      ▼
validate (bytes)              server/media/validate.ts
      │
      ▼
AssetStore                    server/media/storage.ts   (Postgres | S3-compatible)
      │
      ▼
GeneratedAsset                prisma/schema.prisma
      │
      ▼  attach
ContentMedia (join)  ────────► ContentDraft.media
      │
      ▼
queueDraft()                  server/content/content.service.ts  (EXISTING queue)
      │
      ▼
runScheduledPublishes()       server/content/publish.service.ts  (EXISTING cron)
      │
      ├── LinkedIn publisher  server/media/publishers/linkedin-image.ts
      ├── Instagram publisher server/media/publishers/instagram.ts
      └── manual / extension fallback
```

---

## Decisions worth explaining

### Why images live in Postgres by default

The app deploys to Netlify / Vercel / Railway — no writable filesystem — and
every image provider returns a URL that expires within hours (OpenAI within the
hour, Replicate within the day). A post scheduled for next Tuesday cannot depend
on one, so the bytes have to be copied somewhere durable at generation time.

Postgres is the durable thing this project already has. `MAX_ASSET_BYTES` (12 MB)
keeps rows bounded, `listAssets()` never selects the `data` column, and the
`AssetSummary` type exists specifically so a function cannot accidentally pull
megabytes per image into a gallery listing.

An S3-compatible store is available behind the same interface for deployments
that outgrow it. Each asset records its own `storage` kind, so switching does not
strand images generated before the switch. SigV4 is ~80 lines in
`storage.ts` — cheaper than adding the AWS SDK for one signed PUT.

### Why signed asset URLs exist

Assets are private, and normally require a session that is a member of the
asset's company. But the Instagram Graph API **publishes by URL**: you hand Meta
a link and its servers fetch the image. That genuinely needs an address that
works with no session.

`server/media/asset-url.ts` mints an HMAC over `assetId + expiry`, keyed on
`NEXTAUTH_SECRET` — the same pattern `server/connectors/oauth.ts` already uses
for OAuth state. It is unguessable, cannot be edited to reach a different asset,
and expires in 15 minutes.

The membership check in the file route deliberately tests the **asset's own**
`companyId`, not the caller's active workspace — a user who belongs to two
companies must not be able to pull an asset across by switching tabs.

### Why platform is separate from content type

`ContentType` describes the SHAPE of the writing (hook-first post, carousel,
thread). `SocialPlatform` describes where it goes. The same carousel can be aimed
at LinkedIn or Instagram, and each wants a different image size and a different
publisher.

`ContentDraft.platform` is **nullable**, and `resolvePlatform()` falls back to
`defaultPlatformFor(type)`. That is what keeps every pre-existing draft going
exactly where it went before — the mapping is pinned in `tests/platforms.test.ts`
precisely because drifting it would silently retarget historical drafts.

### Why generation runs on the job queue

Four variations on Stability or Replicate is four sequential HTTP round-trips,
each of which can take 30-90s. Run inline that reliably exceeds a serverless
function budget, which is precisely the failure `GenerationJob` was introduced
to solve for the trend digest and the monthly planner — so image generation
reuses it rather than repeating the mistake.

The dedupe key is the one wrinkle. `enqueueJob` normally allows one job of a
kind per company, which is right when a second run is the same work. For images
it is not: two people generating for two different posts are doing different
things, so the graphics route passes `dedupeOn: { draftId }`. That keeps the
double-click protection and scopes it to the post being illustrated.

### Why the prompt step is separate from the generation step

Writing a prompt is one cheap LLM call. Drawing an image is a paid provider call.
Splitting them means the user reads and edits the brief before anything is spent,
which is also the difference between "the AI made a weird picture" and "I asked
for the wrong thing".

### Why `ContentMedia` is a join table

An asset can be attached to more than one post — that is what "reuse this
graphic" means — and a post can have several images in a defined order (a
carousel). A column on `ContentDraft` would model neither. The join also keeps
`GeneratedAsset.contentDraftId` meaning "generated FOR this draft" (the history
scope) independently of where the image ended up being used.

### Why partial generation success is a success

Asking for four variations and getting three is a good outcome. `generateGraphics`
persists each image independently and reports what did not land, rather than
discarding three good images because the fourth came back malformed.

### Why the MIME type is sniffed, not trusted

`validateImageBytes` reads the magic number rather than the provider's
`Content-Type`. The concrete failure this catches is a provider answering HTTP
200 with an HTML error page — trusting the header would store that as an image
and produce a broken post days later. Dimensions are read from the file header
too, because providers report the size they were *asked* for.

---

## Security posture

| Concern | Handling |
| --- | --- |
| Provider API keys | Server-only. Never in a client bundle, never in an API response — `tests/image-providers.test.ts` asserts key values do not appear in the providers payload. |
| Provider error bodies | Logged server-side only. They routinely echo the prompt and can carry org identifiers, so `describeFailure()` maps status codes to safe messages. |
| Asset access | Company-scoped in every query. Unauthorised reads return **404**, not 403 — confirming an id exists is itself a leak. |
| Signed URLs | HMAC over id + expiry, constant-time compare, length checked before `timingSafeEqual` (which throws on unequal lengths). |
| Extension access | Reuses the existing bearer token and company scoping. No new auth path. |
| Ownership on attach | Both the draft and the asset are re-read under the caller's `companyId` before anything is written. |
| Rate limiting | 6 generations / 20 prompt-writes per user per minute, plus the plan's monthly allowance. |
| Input | Zod at the route boundary (`lib/validations/media.ts`); variation count capped at the schema, the plan, the provider AND the service. |
| Publishing | Platform authorisation is checked before upload; media is validated against the platform before any byte is sent. |

---

### Why a supplied image is the same model, not a new one

Upload and "from URL" reuse `GeneratedAsset` with `provider = UPLOAD` rather
than introducing a `MediaAsset` alongside it. Everything after the bytes arrive
is identical — validation, storage, the gallery, attachment, per-platform
checks, the LinkedIn upload, the Instagram fetch, the extension. A second model
would have duplicated all of it to record one different origin.

The remote-URL path copies the bytes instead of storing the link. A post
scheduled for next week cannot depend on someone else's server, and LinkedIn
needs the bytes to upload regardless.

`isPrivateHost()` is the load-bearing part: an image-URL field is a server-side
request to an arbitrary address on the caller's behalf. Loopback, RFC1918 and
`169.254.169.254` (cloud instance metadata, which would return deployment
credentials) are refused. Hostnames that are not literal IPs pass through —
resolving them here would be a TOCTOU race, and egress rules are the right layer
for that depth.

## What is NOT implemented, and why

Stated plainly so nobody discovers it at publish time:

- **X (Twitter) publishing.** No integration exists in this codebase. Posts aimed
  at X get the manual/extension path.
- **Facebook Page publishing.** The Meta connector's token would support it, but
  no publisher is written. `FACEBOOK` exists as a generation target (it affects
  art direction and sizing) and routes to manual for publishing.
- **Instagram carousels.** The Graph API supports multi-image containers; the
  publisher sends the first attached image only. `ContentMedia` already models
  the ordered set, so this is a publisher change, not a schema one.
- **Video.** `MediaKind.VIDEO` exists so the attachment layer does not need
  reshaping later. Nothing generates or publishes video today.
- **Image editing / inpainting.** Regenerate produces a new asset; there is no
  edit-in-place.

---

## Extending it

**Adding an image provider:** implement `ImageGenerationProvider` in
`server/media/providers/`, add it to the `REGISTRY` array in that directory's
`index.ts`, add its enum value to `ImageProvider` in the schema (with a
migration) and to `IMAGE_PROVIDERS` in `lib/validations/media.ts`. Nothing in
Content Studio, the routes or the components changes.

**Adding a platform:** add the enum value, add a `PlatformSpec` to
`PLATFORM_SPECS`, decide `defaultPlatformFor`/`platformsForType`, and add a
publisher branch in `publishDraft`. The generation, storage, attachment and queue
layers need no changes.
