
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
/**
 * Build the provider list conditionally so the app runs locally with only
 * credentials configured. Google is enabled when its env vars are present.
 *
 * >>> SPRINT 2: LinkedIn OAuth plugs in HERE <<<
 * Add a LinkedInProvider({ clientId, clientSecret }) block guarded by
 * LINKEDIN_CLIENT_ID/SECRET. No other auth code needs to change — the Prisma
 * `Account` table already models arbitrary OAuth providers. Use ONLY the
 * official LinkedIn OAuth API. No scraping / unofficial endpoints, ever.
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

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.push(
      GoogleProvider({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
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
