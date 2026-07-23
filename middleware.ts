import { withAuth } from 'next-auth/middleware';

/**
 * Edge middleware — the first line of route protection.
 * Any path in `matcher` requires a valid session token; unauthenticated
 * requests are redirected to /login (with a callbackUrl to return afterward).
 * Server Components additionally call requireUser()/requireCompanyMembership()
 * where they load data — defense in depth.
 */
export default withAuth({
  pages: { signIn: '/login' },
});

export const config = {
  matcher: ['/dashboard/:path*', '/onboarding/:path*'],
};
