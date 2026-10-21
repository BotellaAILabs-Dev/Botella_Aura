'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Mail, Send } from 'lucide-react';

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

interface Status {
  configured: boolean;
  transport: 'smtp' | 'resend' | 'console';
  description: string;
  problems: string[];
  appUrl: string;
  appUrlIsLocal: boolean;
}

/**
 * Email delivery diagnostics for admins. Answers, in-product, the exact
 * question the client asked: "the UI says the invite was sent — was it?"
 */
export function EmailDiagnosticsCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [lastTest, setLastTest] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings/email')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setStatus(d))
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  }, []);

  async function sendTest() {
    setTesting(true);
    setLastTest(null);
    try {
      const res = await fetch('/api/settings/email', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as {
        delivered?: boolean;
        transport?: string;
        error?: string | null;
        to?: string;
        notConfigured?: boolean;
      };
      if (!res.ok) {
        toast.error((body as { error?: string }).error ?? 'Could not run the test.');
        return;
      }
      if (body.delivered) {
        toast.success(`Test email accepted by ${body.transport} for ${body.to}.`);
        setLastTest(
          `Delivered to ${body.to} via ${body.transport}. If it isn't in the inbox, check spam and the sender domain's SPF/DKIM records.`,
        );
      } else if (body.notConfigured) {
        toast.error('No email provider configured — nothing was sent.');
        setLastTest(
          'Nothing was sent: no email provider is configured, so the message was only written to the server log.',
        );
      } else {
        toast.error('The email provider rejected the message.');
        setLastTest(`Not delivered — ${body.error ?? 'the provider rejected the message.'}`);
      }
    } finally {
      setTesting(false);
    }
  }

  if (loading || !status) {
    return null;
  }

  const ok = status.configured && status.problems.length === 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-primary" />
          <div>
            <CardTitle className="text-base">Email delivery</CardTitle>
            <CardDescription>
              Invitations and password resets go out through this transport.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={ok ? 'success' : status.configured ? 'warning' : 'muted'}>
            {ok ? 'Configured' : status.configured ? 'Needs attention' : 'Not configured'}
          </Badge>
          <span className="text-muted-foreground">{status.description}</span>
        </div>

        {!status.configured && (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="text-muted-foreground">
              <p className="font-medium text-foreground">
                Emails are not actually being sent.
              </p>
              <p className="mt-0.5">
                Invitations still work — the invite link is shown in the team list so
                you can share it directly — but nothing reaches an inbox until a
                provider is configured.
              </p>
            </div>
          </div>
        )}

        {status.problems.length > 0 && (
          <ul className="ml-5 list-disc space-y-1 text-muted-foreground">
            {status.problems.map((p) => (
              <li key={p} className="break-words [overflow-wrap:anywhere]">{p}</li>
            ))}
          </ul>
        )}

        {status.appUrlIsLocal && (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Links in emails would point at{' '}
              <span className="font-mono text-foreground">{status.appUrl}</span>, which
              only works on this machine. Set <span className="font-mono">APP_URL</span>{' '}
              (or <span className="font-mono">NEXTAUTH_URL</span>) to your public URL.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={sendTest} loading={testing}>
            <Send className="h-4 w-4" /> Send test email to me
          </Button>
          {lastTest && (
            <span className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {lastTest}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
