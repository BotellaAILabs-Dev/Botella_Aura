'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';

/** "Draft outreach" — routes a lead into the existing Sprint 4 outreach flow. */
export function LeadDraftButton({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function draft() {
    setBusy(true);
    try {
      const res = await fetch(`/api/outreach/leads/${leadId}/draft`, {
        method: 'POST',
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not draft outreach.');
        return;
      }
      toast.success('Outreach drafted — review it in Outreach.');
      router.push('/dashboard/outreach');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={draft} loading={busy}>
      <Sparkles className="h-4 w-4" /> Draft outreach
    </Button>
  );
}
