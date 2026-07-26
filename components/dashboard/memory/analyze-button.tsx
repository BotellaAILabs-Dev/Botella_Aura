'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';

/** Runs the pattern-extraction job now. Honest about low-sample results. */
export function AnalyzeButton({ firstRun }: { firstRun?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch('/api/memory/generate', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        status?: string;
        sampleSize?: number;
        created?: number;
      };
      if (!res.ok) {
        toast.error(data.error ?? 'Analysis failed.');
        return;
      }
      if (data.status === 'insufficient') {
        toast.message?.('Not enough data yet', {
          description: `Only ${data.sampleSize ?? 0} posts with metrics — publish + sync more, then re-analyze.`,
        });
      } else {
        toast.success(`Learned ${data.created ?? 0} insight(s) from ${data.sampleSize ?? 0} posts.`);
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={run} loading={busy} variant={firstRun ? 'default' : 'outline'} size="sm">
      <Sparkles className="h-4 w-4" />
      {busy ? 'Analyzing…' : 'Analyze now'}
    </Button>
  );
}
