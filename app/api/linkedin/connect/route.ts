import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import {
  buildAuthorizeUrl,
  isLinkedInConfigured,
} from '@/server/services/linkedin.service';
import { generateToken, sha256 } from '@/lib/crypto';
import { bindingCookieOptions, challengeFor, createVerifier, sealBinding } from '@/lib/pkce';

/**
 * GET /api/linkedin/connect — begin the official LinkedIn OAuth flow.
 * RBAC: only roles allowed to connect LinkedIn (OWNER/ADMIN — see lib/rbac.ts).
 * CSRF: we generate a random nonce, store its hash in an httpOnly cookie, and
 * embed companyId + nonce in the OAuth `state`, verified on callback.
 */
export async function GET(req: Request) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) {
    return NextResponse.redirect(new URL('/onboarding', req.url));
  }

  const membership = await getMembership(user.id, active.id);
  if (!membership || !can(membership.role, 'linkedin:connect')) {
    return NextResponse.redirect(
      new URL('/dashboard/settings/connections?error=forbidden', req.url),
    );
  }

  if (!isLinkedInConfigured()) {
    return NextResponse.redirect(
      new URL('/dashboard/settings/connections?error=not_configured', req.url),
    );
  }

  const nonce = generateToken(16);
  const state = Buffer.from(
    JSON.stringify({ companyId: active.id, nonce }),
  ).toString('base64url');

  cookies().set('li_oauth_nonce', sha256(nonce), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600, // 10 minutes
  });

  // PKCE: the verifier stays in this browser (encrypted, bound to the nonce).
  const verifier = createVerifier();
  cookies().set('li_oauth_pkce', sealBinding(nonce, verifier), bindingCookieOptions);

  return NextResponse.redirect(buildAuthorizeUrl(state, challengeFor(verifier)));
}
