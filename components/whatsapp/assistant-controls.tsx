'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';

/** On/off switch for the workspace's WhatsApp access (owners and admins). */
export function WhatsAppToggle({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function flip() {
    const next = !enabled;
    if (!next && !window.confirm('Turn WhatsApp off for this workspace? Members using it there lose access on their next message.')) return;
    setBusy(true);
    try {
      const res = await fetch('/api/whatsapp/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? 'Could not change the setting.');
        return;
      }
      toast.success(next ? 'WhatsApp turned on for this workspace.' : 'WhatsApp turned off for this workspace.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant={enabled ? 'outline' : 'default'} size="sm" disabled={busy} onClick={flip}>
      {enabled ? 'Turn off' : 'Turn on'}
    </Button>
  );
}

/** Unlink one of your own WhatsApp numbers. */
export function UnlinkButton({ id, last4 }: { id: string; last4: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function unlink() {
    if (!window.confirm(`Unlink the number ending ${last4}? It will need to sign in again to use Aura.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/whatsapp/links/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? 'Could not unlink that number.');
        return;
      }
      toast.success('Number unlinked.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="ghost" size="sm" disabled={busy} onClick={unlink}>
      Unlink
    </Button>
  );
}

/** Owners/admins: a short WhatsApp message to a member using WhatsApp here. */
export function MessageMemberButton({ userId, name }: { userId: string; name: string }) {
  const [busy, setBusy] = useState(false);

  async function send() {
    const text = window.prompt(`Message ${name} on WhatsApp (sent with your name; only if they wrote to Aura in the last 24 hours):`);
    if (!text?.trim()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, text: text.trim().slice(0, 1000) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; sent?: number; skipped?: { reason: string }[] };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not send.');
        return;
      }
      if (body.sent) {
        toast.success('Sent.');
      } else {
        const why = body.skipped?.[0]?.reason;
        toast.error(
          why === 'outside_24h_window'
            ? 'Not sent: they haven’t written to Aura in the last 24 hours (WhatsApp’s rule).'
            : why === 'opted_out'
              ? 'Not sent: they turned Aura’s messages off (STOP).'
              : why === 'session_expired'
                ? 'Not sent: their WhatsApp sign-in has expired.'
                : 'Not sent — WhatsApp refused it.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="ghost" size="sm" disabled={busy} onClick={send}>
      Message
    </Button>
  );
}
