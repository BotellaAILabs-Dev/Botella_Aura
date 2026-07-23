'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';

/**
 * Manual "Refresh digest" trigger. On first run (no digest yet) it shows the
 * friendly generating message the spec calls for.
 */
export function RefreshDigestButton({ firstRun = false }: { firstRun?: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    if (firstRun) {
      toast('Generating your first trend digest — this usually takes about a minute…');
    }
    try {
      const res = await fetch('/api/trends/refresh', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? 'Could not refresh the digest.');
        return;
      }
      const data = (await res.json()) as { itemCount: number };
      toast.success(
        data.itemCount > 0
          ? `Digest updated — ${data.itemCount} trends.`
          : 'Digest refreshed. No new trends matched your config yet.',
      );
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={refresh} loading={loading} variant={firstRun ? 'default' : 'outline'}>
      {firstRun ? (
        <>
          <Sparkles className="h-4 w-4" /> Generate first digest
        </>
      ) : (
        <>
          <RefreshCw className="h-4 w-4" /> Refresh
        </>
      )}
    </Button>
  );
}
