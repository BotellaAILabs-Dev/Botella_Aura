import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth-helpers';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { connectCompany } from '@/server/services/linkedin.service';
import { sha256 } from '@/lib/crypto';
import { getRequestMeta } from '@/lib/api';
import { logger } from '@/lib/logger';

/**
 * GET /api/linkedin/callback — OAuth redirect target. Verifies CSRF state,
 * exchanges the code for tokens (stored encrypted), and returns the user to the
 * Connections settings page with a status flag.
 */
function redirectTo(req: Request, query: string) {
  return NextResponse.redirect(
    new URL(`/dashboard/settings/connections?${query}`, req.url),
  );
}

export async function GET(req: Request) {
  const user = await requireUser();
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  // User denied consent or LinkedIn returned an error.
  if (oauthError) return redirectTo(req, `error=${encodeURIComponent(oauthError)}`);
  if (!code || !stateRaw) return redirectTo(req, 'error=missing_code');

  // Verify CSRF: nonce in state must match the hashed cookie we set on connect.
  let companyId: string;
  let nonce: string;
  try {
    const parsed = JSON.parse(
      Buffer.from(stateRaw, 'base64url').toString('utf8'),
    ) as { companyId: string; nonce: string };
    companyId = parsed.companyId;
    nonce = parsed.nonce;
  } catch {
    return redirectTo(req, 'error=bad_state');
  }

  const cookieNonce = cookies().get('li_oauth_nonce')?.value;
  cookies().delete('li_oauth_nonce');
  if (!cookieNonce || cookieNonce !== sha256(nonce)) {
    return redirectTo(req, 'error=state_mismatch');
  }

  // Authorization: the caller must be an OWNER/ADMIN of the target company.
  const membership = await getMembership(user.id, companyId);
  if (!membership || !can(membership.role, 'linkedin:connect')) {
    return redirectTo(req, 'error=forbidden');
  }

  try {
    await connectCompany({
      companyId,
      userId: user.id,
      code,
      requestMeta: getRequestMeta(req),
    });
    return redirectTo(req, 'connected=1');
  } catch (err) {
    logger.error('LinkedIn callback failed', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return redirectTo(req, 'error=exchange_failed');
  }
}
