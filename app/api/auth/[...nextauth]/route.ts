import NextAuth from 'next-auth';
import { authOptions } from '@/lib/auth';

/**
 * NextAuth catch-all route (App Router). Handles sign-in, callbacks (incl.
 * Google OAuth, and LinkedIn in Sprint 2), sign-out, and session endpoints.
 */
const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
