'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toaster';

export interface PickableLead {
  id: string;
  name: string | null;
  companyName: string;
  title: string | null;
  fitScore: number | null;
  signal: string | null;
  /** Already has outreach drafted or sent. */
  contacted: boolean;
}

/** Drafting is an AI call per lead (the route takes at most this many). */
const MAX = 5;

/**
 * Choose the leads to draft outreach for, from Aura's suggestion
 * (POST /api/outreach/from-recommendation). Drafts go to review; nothing is
 * sent from here.
 */
export function OutreachFromSuggestion({
  recommendationId,
  leads,
  acceptsOnCreate,
}: {
  recommendationId: string;
  leads: PickableLead[];
  /** Drafting also says yes to the suggestion. */
  acceptsOnCreate: boolean;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX ? p : [...p, id]));
  }

  async function draft() {
    setBusy(true);
    try {
      const res = await fetch('/api/outreach/from-recommendation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recommendationId, leadIds: picked }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        drafted?: { who: string }[];
        failed?: { who: string; error: string }[];
      };
      if (!res.ok && !body.drafted?.length) {
        toast.error(body.error ?? body.failed?.[0]?.error ?? 'Could not draft the outreach.');
        return;
      }
      const n = body.drafted?.length ?? 0;
      toast.success(`Drafted outreach for ${n} lead${n === 1 ? '' : 's'}. Review and approve it in Outreach.`);
      if (body.failed?.length) toast.error(`Not drafted: ${body.failed.map((f) => f.who).join(', ')}.`);
      router.push('/dashboard/outreach');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Who should hear from you?</CardTitle>
        <CardDescription>
          Pick up to {MAX} leads. Aura drafts a LinkedIn connection note and a follow-up for each, from this suggestion and
          the lead’s own signal. They land in review — nothing is sent from here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {leads.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No leads yet. Add some in Outreach or find them with Lead discovery, then come back.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {leads.map((l) => {
              const on = picked.includes(l.id);
              const full = !on && picked.length >= MAX;
              return (
                <li key={l.id}>
                  <label className={`flex items-start gap-3 p-3 text-sm ${full ? 'opacity-50' : ''}`}>
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 accent-primary"
                      checked={on}
                      disabled={full || busy}
                      onChange={() => toggle(l.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-foreground">{l.name ?? l.companyName}</span>
                      <span className="text-muted-foreground">
                        {l.name ? ` · ${l.companyName}` : ''}
                        {l.title ? ` · ${l.title}` : ''}
                        {l.fitScore != null ? ` · fit ${l.fitScore}` : ''}
                        {l.contacted ? ' · already contacted' : ''}
                      </span>
                      {l.signal && <span className="block truncate text-xs text-muted-foreground">Signal: {l.signal}</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {acceptsOnCreate ? 'Drafting also says yes to this suggestion.' : `${picked.length} of ${MAX} chosen`}
        </p>
        <Button onClick={draft} loading={busy} disabled={picked.length === 0}>
          <Send className="h-4 w-4" /> Draft outreach{picked.length ? ` (${picked.length})` : ''}
        </Button>
      </CardFooter>
    </Card>
  );
}
