import type { SystemRole } from '@prisma/client';
import type { DefaultSession } from 'next-auth';

/**
 * Augment NextAuth's Session/JWT so `session.user.id` and `role` are typed
 * everywhere. Populated in the callbacks in lib/auth.ts.
 */
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: SystemRole;
    } & DefaultSession['user'];
  }

  interface User {
    role?: SystemRole;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    role: SystemRole;
  }
}
