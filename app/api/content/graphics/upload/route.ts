import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { getDraft } from '@/server/content/content.service';
import { importImageUrlSchema } from '@/lib/validations/media';
import {
  fetchRemoteImage,
  fetchRemoteVideo,
  ingestImage,
  ingestVideo,
  MediaFetchError,
} from '@/server/media/upload.service';
import { looksLikeVideo } from '@/lib/video';
import { MediaValidationError } from '@/server/media/validate';

/**
 * POST /api/content/graphics/upload?draftId=… — attach a graphic the user
 * supplies, instead of generating one.
 *
 * Two ways in, one pipeline:
 *   multipart/form-data with `file`  → a file from their machine
 *   application/json with `url`      → a remote image, downloaded and stored
 *   … with `kind: "video"`           → a remote MP4/MOV (Instagram Reels and
 *                                      carousels; up to 100 MB, needs file
 *                                      storage — server/media/storage.ts)
 *
 * A file upload that is a video (read from its bytes, not its name) goes the
 * video way too, within the same body-size cap — larger videos come by URL.
 *
 * Both land in the same validate → store → persist path as a generated image,
 * so the resulting asset is indistinguishable downstream: same gallery, same
 * attachment, same platform validation, same publishing, same extension.
 *
 * Remote images are COPIED rather than referenced. A post scheduled for next
 * week cannot depend on someone else's server still serving that file, and
 * LinkedIn needs the bytes to upload regardless.
 *
 * `runtime = nodejs` because this handles Buffers; the platform's own body-size
 * cap (~4.5 MB on Vercel) applies to the multipart path before this runs, which
 * is why the error below names a size rather than a generic failure.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Matches the knowledge-base upload route's ceiling, for the same reason. */
const MAX_UPLOAD_BYTES = 4_000_000;

export async function POST(req: Request) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'content:create')) {
      return jsonError('Your role is read-only and cannot add graphics.', 403);
    }

    const draftId = new URL(req.url).searchParams.get('draftId');
    if (!draftId) return jsonError('A draftId is required.', 400);

    const draft = await getDraft(company.id, draftId);
    if (!draft) return jsonError('Draft not found', 404);
    if (draft.status === 'PUBLISHED') {
      return jsonError('This post is already published — its media cannot change.', 409);
    }

    // Downloading a remote URL is a request this server makes on the caller's
    // behalf, so it gets the same throttle as generation.
    const limit = rateLimit(`graphic-upload:${user.id}`, {
      limit: 20,
      windowMs: 60_000,
    });
    if (!limit.allowed) {
      return jsonError(
        `Too many uploads at once. Try again in ${limit.retryAfterSeconds}s.`,
        429,
      );
    }

    const contentType = req.headers.get('content-type') ?? '';

    // --- a file from the user's machine ---------------------------------
    if (contentType.includes('multipart/form-data')) {
      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        // A truncated or malformed body is the client's problem, not ours —
        // a generic 500 here reads as "the server is broken" when the fix is
        // to re-send the file.
        return jsonError('Could not read the uploaded file. Try again.', 400);
      }
      const file = form.get('file');
      if (!(file instanceof File)) {
        return jsonError('No file was provided.', 400);
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return jsonError(
          `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${
            MAX_UPLOAD_BYTES / 1_000_000
          } MB — export it smaller and try again.`,
          413,
        );
      }

      const data = Buffer.from(await file.arrayBuffer());
      const asset = await (looksLikeVideo(data) ? ingestVideo : ingestImage)({
        draft,
        userId: user.id,
        data,
        origin: 'upload',
        filename: file.name,
      });
      return jsonOk({ asset }, 201);
    }

    // --- a remote image URL ----------------------------------------------
    const { url, kind } = importImageUrlSchema.parse(await req.json());
    if (kind === 'video') {
      const video = await fetchRemoteVideo(url);
      const asset = await ingestVideo({ draft, userId: user.id, data: video, origin: 'url', sourceUrl: url });
      return jsonOk({ asset }, 201);
    }
    const data = await fetchRemoteImage(url);
    const asset = await ingestImage({
      draft,
      userId: user.id,
      data,
      origin: 'url',
      sourceUrl: url,
    });
    return jsonOk({ asset }, 201);
  } catch (error) {
    // Both carry messages written for the user, so they are surfaced directly
    // rather than collapsed into a generic 500.
    if (error instanceof MediaFetchError) {
      return jsonError(error.message, error.status);
    }
    if (error instanceof MediaValidationError) {
      return jsonError(error.message, error.status);
    }
    if (error instanceof z.ZodError) {
      return jsonError('That is not a valid image URL.', 422);
    }
    return handleRouteError(error);
  }
}
