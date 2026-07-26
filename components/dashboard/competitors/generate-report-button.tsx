'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';

/**
 * "Generate now" — runs a fresh tracking pass across all competitors and
 * (re)generates this week's report. Used for demos and on-demand refreshes.
 */
export function GenerateReportButton({ firstRun }: { firstRun?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch('/api/competitors/reports', { method: 'POST' });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not generate report.');
        return;
      }
      toast.success('Weekly report generated.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={run} loading={busy} variant={firstRun ? 'default' : 'outline'} size="sm">
      <Sparkles className="h-4 w-4" />
      {busy ? 'Analyzing…' : firstRun ? 'Generate first report' : 'Generate now'}
    </Button>
  );
}
