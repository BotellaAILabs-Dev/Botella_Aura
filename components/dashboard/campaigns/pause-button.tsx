'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';

/** Pause/resume future campaign task execution (keeps all history). */
export function PauseButton({ campaignId, status }: { campaignId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const paused = status === 'PAUSED';

  async function toggle() {
    setBusy(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: paused ? 'resume' : 'pause' }),
      });
      if (!res.ok) {
        toast.error('Could not update the campaign.');
        return;
      }
      toast.success(paused ? 'Campaign resumed.' : 'Campaign paused.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (status === 'COMPLETED') return null;
  return (
    <Button onClick={toggle} loading={busy} variant="outline" size="sm">
      {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
      {paused ? 'Resume' : 'Pause'}
    </Button>
  );
}
