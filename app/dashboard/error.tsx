'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RefreshCw, LifeBuoy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * Dashboard error boundary.
 *
 * Without one, any render failure inside /dashboard fell through to Next's
 * default screen — an unattributed "Something went wrong" with no page context,
 * no way back, and nothing an engineer could act on. This keeps the shell,
 * names the section that failed, offers a retry, and shows the digest id so a
 * report can be matched to a server log.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaces in the browser console and any client monitoring.
    console.error('dashboard error boundary', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl py-10">
      <Card>
        <CardHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-destructive/10">
            <AlertTriangle className="h-5 w-5 [color:hsl(var(--destructive))]" />
          </div>
          <CardTitle className="text-base">This page didn&apos;t load</CardTitle>
          <CardDescription>
            Something failed while building this view. Your data is safe — nothing
            was changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error.message && (
            <p className="rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
              {error.message}
            </p>
          )}
          {error.digest && (
            <p className="text-xs text-muted-foreground">
              Reference: <span className="font-mono">{error.digest}</span> — quote
              this if you report it.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={reset}>
              <RefreshCw className="h-4 w-4" /> Try again
            </Button>
            <Button asChild variant="outline">
              <Link href="/dashboard">Back to dashboard</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/dashboard/settings">
                <LifeBuoy className="h-4 w-4" /> Check settings
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
