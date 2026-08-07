'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Users } from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ACTIVE_COMPANY_COOKIE } from '@/lib/cookies';

/** The logged-in user accepts (or declines) a team invitation. */
export function AcceptInvite({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        companyId?: string;
      };
      if (!res.ok) {
        setError(body.error ?? 'Could not accept this invitation.');
        return;
      }
      if (body.companyId) {
        document.cookie = `${ACTIVE_COMPANY_COOKIE}=${body.companyId}; path=/; max-age=31536000; samesite=lax`;
      }
      router.push('/dashboard');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="shadow-lg">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Users className="h-6 w-6" />
        </div>
        <CardTitle className="text-2xl">Join the team</CardTitle>
        <CardDescription>
          You&apos;ve been invited to a workspace on Botella Aura.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <Button className="w-full" loading={busy} onClick={accept}>
          Accept invitation
        </Button>
        <Button
          variant="ghost"
          className="w-full"
          onClick={() => router.push('/dashboard')}
        >
          Not now
        </Button>
      </CardContent>
    </Card>
  );
}
