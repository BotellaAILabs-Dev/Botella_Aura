import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import { handleRouteError, jsonError, jsonOk } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { storeCompanyLogo, LogoUploadError, logoAssetUrl } from '@/server/company/logo.service';
import { MediaValidationError } from '@/server/media/validate';

/**
 * POST /api/company/logo — upload the workspace logo (multipart `file`).
 *
 * `runtime = nodejs` because this handles Buffers. The platform's own body-size
 * cap (~4.5 MB on Vercel) applies to multipart before this handler runs, which
 * is why the error below names a size rather than failing generically — the
 * same reasoning as the graphics upload route.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Matches the graphics and knowledge-base upload ceilings, for the same reason. */
const MAX_UPLOAD_BYTES = 4_000_000;

export async function POST(req: Request) {
  try {
    const { company, user, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('Only owners and admins can change brand assets.', 403);
    }

    // Storing bytes is the expensive part of this route, so it is throttled
    // like the other upload paths rather than left open.
    const limit = rateLimit(`logo:${user.id}`, { limit: 10, windowMs: 60_000 });
    if (!limit.allowed) {
      return jsonError(`Too many uploads. Try again in ${limit.retryAfterSeconds}s.`, 429);
    }

    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return jsonError('Attach an image file.', 400);
    }
    if (file.size === 0) return jsonError('That file is empty.', 400);
    if (file.size > MAX_UPLOAD_BYTES) {
      return jsonError(
        `Logos must be under ${MAX_UPLOAD_BYTES / 1_000_000} MB.`,
        413,
      );
    }

    const data = Buffer.from(await file.arrayBuffer());
    const result = await storeCompanyLogo({
      companyId: company.id,
      userId: user.id,
      data,
      ...(file.name ? { filename: file.name } : {}),
    });

    return jsonOk({
      assetId: result.assetId,
      url: logoAssetUrl(result.assetId),
      width: result.width,
      height: result.height,
    });
  } catch (error) {
    // Both of these are the user's file being wrong, not the server failing —
    // they carry a message worth showing, unlike an unexpected throw.
    if (error instanceof MediaValidationError || error instanceof LogoUploadError) {
      return jsonError(error.message, 400);
    }
    return handleRouteError(error);
  }
}
