'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TriangleAlert } from 'lucide-react';

import { toast } from '@/components/ui/toaster';

interface MetaPage {
  id: string;
  name: string;
  ig: { id: string; username: string | null } | null;
}

interface Status {
  connected: boolean;
  pages: MetaPage[];
  selectedPageId: string | null;
  health: 'ok' | 'expiring' | 'expired';
  expiresAt: string | null;
}

/**
 * On the Facebook & Instagram connector card: which Page Aura publishes to
 * (and so which Instagram account), chosen from the Pages the connected
 * Facebook account manages; and a warning before the connection expires.
 */
export function MetaPagePicker({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/meta/page')
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Status | null) => live && setStatus(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!status?.connected) return null;

  async function choose(pageId: string) {
    setSaving(true);
    try {
      const res = await fetch('/api/meta/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; accountLabel?: string };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not change the Page.');
        return;
      }
      setStatus((s) => (s ? { ...s, selectedPageId: pageId } : s));
      toast.success(`Publishing to ${body.accountLabel}.`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const days = status.expiresAt ? Math.max(0, Math.ceil((new Date(status.expiresAt).getTime() - Date.now()) / 86_400_000)) : null;
  const selected = status.pages.find((p) => p.id === status.selectedPageId);

  return (
    <div className="mt-2 space-y-2">
      {status.pages.length > 1 && (
        <label className="block text-xs text-muted-foreground">
          Publishes to
          <select
            className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            value={status.selectedPageId ?? ''}
            disabled={!canManage || saving}
            onChange={(e) => choose(e.target.value)}
          >
            {status.pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.ig?.username ? ` + Instagram @${p.ig.username}` : ' (no Instagram linked)'}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && !selected.ig && (
        <p className="text-xs text-muted-foreground">
          No Instagram account is linked to this Page, so Aura publishes to Facebook only. Instagram
          Business or Creator accounts linked to the Page appear here; personal Instagram accounts
          cannot be published to.
        </p>
      )}
      {status.health !== 'ok' && (
        <p className="flex items-start gap-1.5 text-xs text-foreground">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          {status.health === 'expired'
            ? 'The Facebook connection has expired — reconnect to keep publishing.'
            : `The Facebook connection expires in ${days} day${days === 1 ? '' : 's'} — reconnect before then to keep publishing.`}
        </p>
      )}
    </div>
  );
}
