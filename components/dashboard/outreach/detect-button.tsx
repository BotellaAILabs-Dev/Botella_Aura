'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Radar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';

/** Runs public-signal detection and surfaces new leads. */
export function DetectButton({ firstRun }: { firstRun?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch('/api/outreach/detect', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        leadsCreated?: number;
        signalsAdded?: number;
        skipped?: string[];
      };
      if (!res.ok) {
        toast.error(data.error ?? 'Detection failed.');
        return;
      }
      toast.success(
        `${data.leadsCreated ?? 0} new lead(s), ${data.signalsAdded ?? 0} signal(s).`,
      );
      if (data.skipped?.length) {
        toast.message?.('Some sources were skipped', {
          description: data.skipped.join(' · '),
        });
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={run} loading={busy} variant={firstRun ? 'default' : 'outline'} size="sm">
      <Radar className="h-4 w-4" />
      {busy ? 'Scanning…' : firstRun ? 'Find leads' : 'Detect signals'}
    </Button>
  );
}
