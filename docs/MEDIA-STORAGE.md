# Media storage (images, videos) and Instagram

Status: images work with **no extra infrastructure** (stored in Postgres).
**Videos (Reels, video carousel items) need an S3-compatible bucket, which is
not configured.** Verified at code level only; no real bucket has been tested.

## How it works today

| | Images | Videos |
| --- | --- | --- |
| Where stored | Postgres row by default; bucket if `ASSET_S3_*` set (falls back to Postgres if the upload fails) | Bucket only (`putVideo` throws without one) |
| How they arrive | Generated, uploaded (≤ 4 MB, Vercel body cap), or imported by URL (≤ 15 MB) | Imported by URL (≤ 100 MB), or uploaded if ≤ 4 MB |
| What Instagram is given | Signed app URL `/api/content/graphics/<id>/file?exp=&sig=` (HMAC with `NEXTAUTH_SECRET`, 15 min), served as JPEG | **Presigned bucket URL, 1 h** |
| What LinkedIn gets | The bytes (Aura uploads them) | Not supported — posted by hand |
| Dashboard preview | Same route, session + workspace membership | Same route → 302 to a presigned bucket URL (15 min) |

Instagram's Content Publishing API **fetches media by URL** (`image_url`,
`video_url`) — a publicly reachable HTTPS URL is mandatory. Videos are too
large to stream through a Vercel function, so for them that URL must point at
the bucket.

## Security checks (verified in code and unit tests)

- **Uploads:** `content:create` permission, draft must belong to the active
  workspace and not be published, 20 uploads/min per user.
- **File validation:** type sniffed from bytes (PNG/JPEG/WebP; MP4/MOV with an
  H.264/HEVC track and a `moov` index), byte caps, real pixel dimensions ≤
  4096, per-network checks before publishing (Instagram video: 3 s–15 min,
  ≤ 300 MB; carousel 2–10 items).
- **URL import (SSRF):** http(s) only; loopback, private, link-local
  (metadata) and IPv4-mapped IPv6 hosts refused; **redirects now followed
  manually with every hop re-checked** (max 3) — previously a public URL could
  redirect to an internal address; size counted while streaming.
- **Access:** without a valid signature, the file route requires a session
  and membership of the asset's workspace (404 otherwise, no existence leak).
- **Expiry:** signed app URLs 15 min; presigned bucket URLs 5 min (server
  reads), 15 min (previews), 1 h (Instagram video), max 7 days by S3 rules.
- **Bucket authorization (changed):** reads previously used the permanent
  bucket URL, which forced a **public-read bucket** — anyone with a link could
  fetch a video forever. Reads now use SigV4 presigned GETs
  (`readableUrl` in `server/media/storage.ts`), so the bucket can stay
  private. The signing matches AWS's published test vector
  (`tests/media-storage.test.ts`). `ASSET_S3_PUBLIC_BASE_URL` (a deliberate
  public CDN) keeps the old behaviour.
- **Deletion:** deleting an asset deletes the bucket object (best effort).

## Can existing infrastructure be reused? Recommended option

Nothing in the current stack (Vercel, Postgres) can hold videos: Vercel has
no writable disk and Postgres rows are capped at 12 MB per asset by design.
A bucket is needed only if **Reels / video carousels** are part of launch.

**Recommendation: Cloudflare R2, free tier** — no code change (S3-compatible,
path-style, region `auto`), 10 GB storage, 1M writes and 10M reads a month
free, and **no egress fees** (Instagram downloading videos costs nothing).
Requires a Cloudflare account with a payment method on file even for the free
tier — a business decision. Alternatives: Backblaze B2 (10 GB free), AWS S3
(egress charged). Vercel Blob is not S3-API compatible and would need code.

If video is not needed at launch, leave `ASSET_S3_*` unset: images keep
working, and video uploads give a clear "needs file storage" message.

## Configuration (when approved)

| Variable | Value |
| --- | --- |
| `ASSET_S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` (no bucket in it) |
| `ASSET_S3_BUCKET` | e.g. `botella-aura-media` |
| `ASSET_S3_ACCESS_KEY_ID` / `ASSET_S3_SECRET_ACCESS_KEY` | R2 API token with **Object Read & Write** on this bucket only |
| `ASSET_S3_REGION` | `auto` (R2) or the AWS region |
| `ASSET_S3_PUBLIC_BASE_URL` | Leave **unset** (keeps the bucket private) |

Bucket settings: public access **off**; optional lifecycle rule deleting
`videos/` objects of deleted drafts is not needed (Aura deletes them). No
CORS rule is needed: browsers are redirected to the object, they don't fetch
it with JavaScript.

All four core variables must be set together; set them in Vercel only with
your approval, then redeploy. `npm run env:check` reports them as the
`video` group.

## Still to verify with a real bucket and Meta

1. Upload a video by URL → object appears in the bucket (private).
2. Dashboard preview plays (presigned redirect).
3. Publish a Reel and a mixed carousel to a test Instagram account → Meta
   fetches the presigned URL and the container reaches `FINISHED`.
4. A presigned link stops working after it expires.
5. Delete the asset → object removed.
