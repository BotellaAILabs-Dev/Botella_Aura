'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageCircle, ShieldCheck, TriangleAlert } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type View =
  | { state: 'invalid' | 'expired' | 'used' | 'confirmed_by_other' }
  | { state: 'pending'; last4: string; profileName: string | null; expiresAt: string }
  | { state: 'confirmed_by_you'; last4: string; expiresAt: string };

interface Confirmed {
  code: string;
  last4: string;
  expiresAt: string;
  waMeUrl: string | null;
}

/**
 * Linking a WhatsApp number to the signed-in Aura account: confirm, then
 * send the code shown here from that WhatsApp number. The code is shown once
 * (only its hash is kept), so it is never in a URL or an email.
 */
export function LinkWhatsApp({ token, email, view }: { token: string; email: string; view: View }) {
  const router = useRouter();
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Confirmed | null>(null);
  const [cancelled, setCancelled] = useState(false);

  async function post(path: string) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<Confirmed> & { error?: string };
    return { ok: res.ok, body };
  }

  async function confirm() {
    setBusy('confirm');
    setError(null);
    try {
      const { ok, body } = await post('/api/whatsapp/link/confirm');
      if (!ok || !body.code) {
        setError(body.error ?? 'Could not confirm. Send “Hi” on WhatsApp for a new link.');
        return;
      }
      setConfirmed(body as Confirmed);
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy('cancel');
    try {
      await post('/api/whatsapp/link/cancel');
      setCancelled(true);
    } finally {
      setBusy(null);
    }
  }

  const shell = (icon: React.ReactNode, title: string, description: React.ReactNode, body?: React.ReactNode) => (
    <Card className="shadow-lg">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          {icon}
        </div>
        <CardTitle className="text-2xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {body && <CardContent className="space-y-4">{body}</CardContent>}
    </Card>
  );

  const toDashboard = (
    <Button variant="ghost" className="w-full" onClick={() => router.push('/dashboard')}>
      Go to Aura
    </Button>
  );

  if (cancelled) {
    return shell(
      <ShieldCheck className="h-6 w-6" />,
      'Link cancelled',
      'Nothing was linked, and this link no longer works.',
      toDashboard,
    );
  }

  if (confirmed) {
    const spaced = `${confirmed.code.slice(0, 3)} ${confirmed.code.slice(3)}`;
    return shell(
      <MessageCircle className="h-6 w-6" />,
      'One last step',
      <>Send this code to Botella Aura from the WhatsApp number ending in {confirmed.last4}.</>,
      <>
        <p
          className="rounded-md border border-border bg-muted/40 py-4 text-center font-mono text-3xl font-semibold tracking-widest text-foreground"
          aria-label={`Your code is ${confirmed.code.split('').join(' ')}`}
        >
          {spaced}
        </p>
        {confirmed.waMeUrl && (
          <Button asChild className="w-full">
            <a href={confirmed.waMeUrl} rel="noreferrer noopener">
              Open WhatsApp with the code
            </a>
          </Button>
        )}
        <p className="text-center text-xs text-muted-foreground">
          The code works for 10 minutes and only from that WhatsApp number. Don’t share it with
          anyone — it links WhatsApp to your Aura account.
        </p>
        {toDashboard}
      </>,
    );
  }

  switch (view.state) {
    case 'pending':
      return shell(
        <MessageCircle className="h-6 w-6" />,
        'Link WhatsApp to Aura',
        'Use Aura from WhatsApp — the same account, workspaces and approvals.',
        <>
          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
            <p>
              <span className="text-muted-foreground">WhatsApp number:</span>{' '}
              <span className="font-medium text-foreground">•••• {view.last4}</span>
              {view.profileName && <span className="text-muted-foreground"> ({view.profileName})</span>}
            </p>
            <p className="mt-1">
              <span className="text-muted-foreground">Aura account:</span>{' '}
              <span className="font-medium text-foreground">{email}</span>
            </p>
          </div>
          <p className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            Only continue if that WhatsApp number is yours and you asked for this link. Anyone
            using a linked number can see your workspaces’ information.
          </p>
          {error && (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button className="w-full" loading={busy === 'confirm'} disabled={busy !== null} onClick={confirm}>
            Yes, link this number
          </Button>
          <Button variant="ghost" className="w-full" loading={busy === 'cancel'} disabled={busy !== null} onClick={cancel}>
            This isn’t me — cancel
          </Button>
        </>,
      );
    case 'confirmed_by_you':
      return shell(
        <MessageCircle className="h-6 w-6" />,
        'Waiting for your code',
        <>
          You already confirmed this link. Send the code you were shown from the number ending in{' '}
          {view.last4}. Lost it? Send “Hi” on WhatsApp for a new link.
        </>,
        toDashboard,
      );
    case 'expired':
      return shell(
        <TriangleAlert className="h-6 w-6" />,
        'This link has expired',
        'Sign-in links work for 10 minutes. Send “Hi” to Botella Aura on WhatsApp for a new one.',
        toDashboard,
      );
    case 'used':
    case 'confirmed_by_other':
      return shell(
        <TriangleAlert className="h-6 w-6" />,
        'This link has already been used',
        'Each sign-in link works once. Send “Hi” to Botella Aura on WhatsApp for a new one.',
        toDashboard,
      );
    default:
      return shell(
        <TriangleAlert className="h-6 w-6" />,
        'This link isn’t valid',
        'Send “Hi” to Botella Aura on WhatsApp for a new sign-in link.',
        toDashboard,
      );
  }
}
