import { httpRequest } from '@/lib/http';
import { logger } from '@/lib/logger';

/**
 * LinkedIn image upload, via the official Images API.
 *
 * LinkedIn does not accept an image inline with a post. Publishing a graphic is
 * a three-step handshake, and getting the order wrong is the usual cause of a
 * post that publishes with no picture:
 *
 *   1. POST /rest/images?action=initializeUpload — LinkedIn returns a one-time
 *      uploadUrl and the image URN that will eventually reference it.
 *   2. PUT the raw bytes to that uploadUrl. Note this call is NOT to
 *      api.linkedin.com and must not carry the LinkedIn version headers.
 *   3. Reference the URN from the post's `content.media`. The image must have
 *      finished processing, which is what waitForImage() below is for — posting
 *      too early produces a post with a silently missing image.
 *
 * The same scope rules as text publishing apply: w_member_social for a personal
 * profile, w_organization_social for a Company Page. No new OAuth flow — this
 * uses the token the existing LinkedIn connection already holds.
 */
const API_BASE = 'https://api.linkedin.com';
const LINKEDIN_API_VERSION = process.env.LINKEDIN_API_VERSION || '202503';

/** How long to wait for LinkedIn to finish processing an uploaded image. */
const PROCESSING_TIMEOUT_MS = 30_000;
const PROCESSING_POLL_MS = 1500;

export class LinkedInMediaError extends Error {
  readonly status = 502;
  constructor(message: string) {
    super(message);
    this.name = 'LinkedInMediaError';
  }
}

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'linkedin-version': LINKEDIN_API_VERSION,
    'x-restli-protocol-version': '2.0.0',
  };
}

interface InitializeUploadResponse {
  value?: { uploadUrl?: string; image?: string };
}

/**
 * Upload one image and return its `urn:li:image:...`, ready to attach to a post.
 *
 * `ownerUrn` must be the same author the post will be created under — LinkedIn
 * rejects a post that references an image registered to a different owner.
 */
export async function uploadLinkedInImage(args: {
  token: string;
  ownerUrn: string;
  data: Buffer;
  mimeType: string;
}): Promise<string> {
  const { token, ownerUrn, data, mimeType } = args;

  // --- 1. Register the upload -------------------------------------------
  const initRes = await httpRequest(
    `${API_BASE}/rest/images?action=initializeUpload`,
    {
      method: 'POST',
      headers: { ...headers(token), 'content-type': 'application/json' },
      body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
      timeoutMs: 15_000,
      retries: 0,
    },
  );

  if (!initRes.ok) {
    const detail = await initRes.text().catch(() => '');
    logger.error('linkedin: image upload registration failed', {
      status: initRes.status,
      detail: detail.slice(0, 300),
    });
    throw new LinkedInMediaError(
      initRes.status === 403
        ? 'LinkedIn refused the image upload. The connection needs posting permission — reconnect and approve "Share on LinkedIn".'
        : `LinkedIn would not accept an image upload (HTTP ${initRes.status}).`,
    );
  }

  const init = (await initRes.json()) as InitializeUploadResponse;
  const uploadUrl = init.value?.uploadUrl;
  const imageUrn = init.value?.image;
  if (!uploadUrl || !imageUrn) {
    throw new LinkedInMediaError(
      'LinkedIn did not return an upload target for the image.',
    );
  }

  // --- 2. Send the bytes -------------------------------------------------
  // Deliberately only the bearer token: the versioned headers belong to the
  // REST API host, and the upload host rejects requests carrying them.
  const putRes = await httpRequest(uploadUrl, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': mimeType,
    },
    body: new Uint8Array(data),
    timeoutMs: 60_000,
    retries: 0,
  });

  if (!putRes.ok) {
    logger.error('linkedin: image byte upload failed', { status: putRes.status });
    throw new LinkedInMediaError(
      `Uploading the image to LinkedIn failed (HTTP ${putRes.status}).`,
    );
  }

  // --- 3. Wait for it to be usable ---------------------------------------
  await waitForImage(token, imageUrn);
  return imageUrn;
}

interface ImageStatusResponse {
  status?: string;
}

/**
 * Poll until LinkedIn reports the image AVAILABLE.
 *
 * Attaching a still-processing image produces a post with no picture and no
 * error, which is the worst possible failure mode — it looks like it worked. On
 * timeout we proceed anyway rather than losing the post: LinkedIn usually
 * finishes shortly after, and a post is recoverable where a hard failure at
 * this point would strand an approved draft.
 */
async function waitForImage(token: string, imageUrn: string): Promise<void> {
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  const url = `${API_BASE}/rest/images/${encodeURIComponent(imageUrn)}`;

  while (Date.now() < deadline) {
    const res = await httpRequest(url, {
      headers: headers(token),
      timeoutMs: 8000,
      retries: 0,
    });
    if (!res.ok) break; // Not fatal — the post can still reference the URN.

    const body = (await res.json().catch(() => ({}))) as ImageStatusResponse;
    const status = body.status;
    if (status === 'AVAILABLE') return;
    if (status === 'PROCESSING_FAILED') {
      throw new LinkedInMediaError(
        'LinkedIn could not process that image. Try a different graphic.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESSING_POLL_MS));
  }

  logger.warn('linkedin: image still processing at post time', { imageUrn });
}

/**
 * The `content` block for a post with media.
 *
 * LinkedIn takes one image via `content.media` and several via
 * `content.multiImage`, so the caller does not have to know which shape applies.
 * Returns undefined for an empty list, which the post body then omits entirely.
 */
export function buildMediaContent(
  images: Array<{ urn: string; altText?: string | null }>,
): Record<string, unknown> | undefined {
  if (images.length === 0) return undefined;

  if (images.length === 1) {
    const [image] = images as [{ urn: string; altText?: string | null }];
    return {
      media: {
        id: image.urn,
        ...(image.altText ? { altText: image.altText } : {}),
      },
    };
  }

  return {
    multiImage: {
      images: images.map((image) => ({
        id: image.urn,
        ...(image.altText ? { altText: image.altText } : {}),
      })),
    },
  };
}
