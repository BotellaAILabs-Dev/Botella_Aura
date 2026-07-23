'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Linkedin, ShieldCheck, CheckCircle2, AlertTriangle } from 'lucide-react';
import { toast } from '@/components/ui/toaster';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getInitials } from '@/lib/utils';

export interface LinkedInStatusView {
  connected: boolean;
  configured: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  needsReconnect: boolean;
  connectedAt: string | null;
  canManage: boolean;
}

export function LinkedInConnectionCard({
  status,
  notice,
}: {
  status: LinkedInStatusView;
  notice?: { type: 'success' | 'error'; message: string } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    setBusy(true);
    try {
      const res = await fetch('/api/linkedin/disconnect', { method: 'POST' });
      if (!res.ok) {
        toast.error('Could not disconnect. Try again.');
        return;
      }
      toast.success('LinkedIn disconnected.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Linkedin className="h-5 w-5 text-[#0A66C2]" />
          <CardTitle>LinkedIn</CardTitle>
          {status.connected && !status.needsReconnect && (
            <Badge variant="success">Connected</Badge>
          )}
          {status.needsReconnect && <Badge variant="warning">Reconnect needed</Badge>}
        </div>
        <CardDescription>
          Connect via LinkedIn&apos;s official API to personalize your content.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {notice && (
          <p
            role="status"
            className={
              'rounded-md border px-3 py-2 text-sm ' +
              (notice.type === 'success'
                ? 'border-success/30 bg-success/10'
                : 'border-destructive/30 bg-destructive/10 text-destructive')
            }
          >
            {notice.message}
          </p>
        )}

        {/* Transparency copy — required for trust. */}
        <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p>
            We read basic profile and company info to personalize your content.
            <span className="font-medium text-foreground">
              {' '}
              We never post, connect, or comment on your behalf without your click.
            </span>
          </p>
        </div>

        {status.connected && !status.needsReconnect ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Avatar>
                {status.avatarUrl && <AvatarImage src={status.avatarUrl} alt="" />}
                <AvatarFallback>
                  {getInitials(status.displayName ?? 'LI')}
                </AvatarFallback>
              </Avatar>
              <div className="text-sm">
                <p className="flex items-center gap-1 font-medium text-foreground">
                  <CheckCircle2 className="h-4 w-4 text-success" />
                  {status.displayName ?? 'LinkedIn account'}
                </p>
                {status.connectedAt && (
                  <p className="text-xs text-muted-foreground">
                    Connected {new Date(status.connectedAt).toLocaleDateString()}
                  </p>
                )}
              </div>
            </div>
            {status.canManage && (
              <Button variant="outline" onClick={disconnect} loading={busy}>
                Disconnect
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {status.needsReconnect && (
              <p className="flex items-center gap-1.5 text-sm text-warning-foreground">
                <AlertTriangle className="h-4 w-4" />
                Your LinkedIn session expired — reconnect to keep it active.
              </p>
            )}
            {!status.configured ? (
              <p className="text-sm text-muted-foreground">
                LinkedIn isn&apos;t configured on this server yet. Add{' '}
                <code className="rounded bg-muted px-1">LINKEDIN_CLIENT_ID</code> and{' '}
                <code className="rounded bg-muted px-1">LINKEDIN_CLIENT_SECRET</code>{' '}
                (see README).
              </p>
            ) : status.canManage ? (
              <Button asChild>
                {/* GET → server redirect into LinkedIn's official OAuth flow. */}
                <a href="/api/linkedin/connect">
                  <Linkedin className="h-4 w-4" />
                  {status.needsReconnect ? 'Reconnect LinkedIn' : 'Connect LinkedIn'}
                </a>
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                Ask an owner or admin to connect LinkedIn.
              </p>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Sprint 2 uses only the official &ldquo;Sign in with LinkedIn&rdquo; API
          for profile data. Company-page reads and publishing arrive in a later
          sprint pending LinkedIn Marketing API approval — never scraping.
        </p>
      </CardContent>
    </Card>
  );
}
