'use client';

import { useEffect } from 'react';
import Link from 'next/link';

/**
 * Root error boundary — the last stop before Next's unstyled default page for
 * anything rendered outside /dashboard (auth pages, invite acceptance, …).
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('root error boundary', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
        <h1 className="text-lg font-semibold text-foreground">
          This page didn&apos;t load
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Something failed while rendering. Nothing was changed — try again.
        </p>
        {error.message && (
          <p className="mt-3 rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
            {error.message}
          </p>
        )}
        {error.digest && (
          <p className="mt-2 text-xs text-muted-foreground">
            Reference: <span className="font-mono">{error.digest}</span>
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <button
            onClick={reset}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground"
          >
            Go to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
