'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';

/**
 * Client providers mounted once at the root:
 *  - QueryClientProvider → TanStack Query for client data fetching/caching
 *  - Toaster → global notifications
 *
 * There is deliberately no `SessionProvider` here.
 *
 * Nothing in the app calls `useSession` — the session is read on the server
 * (`requireUser`, `getSession`) and the user's name/email/avatar are passed
 * into the shell as props. `signIn` and `signOut` from `next-auth/react`, the
 * only client-side auth calls we make, do not need the provider. Mounting it
 * anyway cost a `/api/auth/session` request on every single page load, plus
 * another on every window focus, to populate a context with no readers.
 *
 * If a component ever genuinely needs `useSession`, add the provider back —
 * but pass it the server session so it does not have to fetch one.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
}
