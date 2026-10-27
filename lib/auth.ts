
import type { NextAuthOptions } from 'next-auth';
import { PrismaAdapter } from '@next-auth/prisma-adapter';
import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';
import type { Provider } from 'next-auth/providers/index';
import { db } from '@/lib/db';
import { verifyPassword } from '@/lib/password';
import { signInSchema } from '@/lib/validations/auth';
import { recordAudit } from '@/server/services/audit.service';
import { logger } from '@/lib/logger';
import { LinkedInSignIn, oauthEmailLinkable } from '@/lib/auth-linkedin';
import { socialProviderConfigured } from '@/lib/social-signin';
/**
 * Build the provider list conditionally so the app runs locally with only
 * credentials configured. Google and LinkedIn are each enabled when their
 * credential pair is present — tested through lib/social-signin.ts, which the
 * login and signup pages use to decide whether to draw the button, so a button
 * can never appear for a provider that was not built.
 *
 * LinkedIn here is sign-in only (`openid profile email`). Reading a company
 * page or publishing is the separate, deliberately granted connection in
 * server/services/linkedin.service.ts. Both halves use the one LinkedIn app,
 * which means one pair of credentials and two redirect URLs to register —
 * `npm run auth:endpoints` prints them. Official LinkedIn OAuth only; no
 * scraping, no unofficial endpoints, ever.
 */
function buildProviders(): Provider[] {
  const providers: Provider[] = [
    CredentialsProvider({
      name: 'Email and password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const parsed = signInSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const user = await db.user.findUnique({
          where: { email: parsed.data.email },
        });
        // Reject OAuth-only accounts (no local password) and bad passwords
        // with the same generic failure — no user enumeration.
        if (!user?.passwordHash) return null;

        const valid = await verifyPassword(
          parsed.data.password,
          user.passwordHash,
        );
        if (!valid) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          role: user.role,
        };
      },
    }),
  ];

  if (socialProviderConfigured('google')) {
    providers.push(
      GoogleProvider({
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        allowDangerousEmailAccountLinking: true,
      }),
    );
  }

  if (socialProviderConfigured('linkedin')) {
    providers.push(
      LinkedInSignIn({
        clientId: process.env.LINKEDIN_CLIENT_ID!,
        clientSecret: process.env.LINKEDIN_CLIENT_SECRET!,
        // Finds the workspace someone already has under this address instead
        // of creating a second, empty one. Safe only because the signIn
        // callback below refuses an address the provider says it never
        // verified — see oauthEmailLinkable().
        allowDangerousEmailAccountLinking: true,
      }),
    );
  }

  return providers;
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(db),
  // JWT strategy is required to support the Credentials provider.
  session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 },
  pages: {
    signIn: '/login',
    error: '/login',
  },
  providers: buildProviders(),
  callbacks: {
    /**
     * The gate on email-based account linking. Both OAuth providers are
     * configured to link by address, which is what makes "log in with Google"
     * land in the workspace you signed up for with a password; the cost is that
     * an address the provider never confirmed would be a way in. Refuse those.
     */
    async signIn({ account, profile }) {
      if (account?.type !== 'oauth') return true;
      if (oauthEmailLinkable(profile)) return true;
      logger.warn('Rejected OAuth sign-in with an unverified email', {
        provider: account.provider,
      });
      return '/login?error=EmailNotVerified';
    },
    async jwt({ token, user }) {
      // On sign-in, `user` is present — copy id/role onto the token.
      if (user) {
        token.id = user.id;
        token.role = user.role ?? 'OWNER';
      } else if (token.id && !token.role) {
        // Backfill role if a token predates this field.
        const dbUser = await db.user.findUnique({
          where: { id: token.id },
          select: { role: true },
        });
        token.role = dbUser?.role ?? 'MEMBER';
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id;
        session.user.role = token.role;
      }
      return session;
    },
  },
  events: {
    async signIn({ user, account }) {
      await recordAudit({
        action: 'USER_LOGGED_IN',
        userId: user.id,
        metadata: { provider: account?.provider ?? 'credentials' },
      });
    },
    async signOut({ token }) {
      if (token?.id) {
        await recordAudit({ action: 'USER_LOGGED_OUT', userId: token.id });
      }
    },
    async createUser({ user }) {
      // Fires for OAuth users the adapter creates on first Google sign-in.
      logger.info('New OAuth user provisioned', { userId: user.id });
      await recordAudit({
        action: 'USER_SIGNED_UP',
        userId: user.id,
        metadata: { method: 'oauth' },
      });
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};
