'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PencilLine } from 'lucide-react';

import { toast } from '@/components/ui/toaster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/**
 * Log measured results by hand.
 *
 * Until a connector is approved there is no automatic source of truth, and
 * without one Results reads as broken and "what works for you" can never reach
 * the sample size it needs to say anything. Typed numbers are stored as the
 * same kind of snapshot a connector writes, so the loop closes today and
 * nothing has to be re-plumbed when the API arrives.
 */
const FIELDS = [
  { key: 'impressions', label: 'Impressions' },
  { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' },
  { key: 'shares', label: 'Shares' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'followers', label: 'Followers (total)' },
] as const;

export function LogResultDialog({
  drafts,
}: {
  drafts: { id: string; title: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draftId, setDraftId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function save() {
    const metrics: Record<string, number> = {};
    for (const field of FIELDS) {
      const raw = values[field.key]?.trim();
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        toast.error(`${field.label} must be a whole number.`);
        return;
      }
      metrics[field.key] = Math.round(n);
    }
    if (Object.keys(metrics).length === 0) {
      toast.error('Enter at least one number.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/analytics/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentDraftId: draftId || undefined,
          metrics,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? 'Could not save those numbers.');
        return;
      }
      toast.success('Results logged — they feed Results and “What works for you”.');
      setValues({});
      setDraftId('');
      setOpen(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <PencilLine className="h-4 w-4" /> Log results
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log results manually</DialogTitle>
          <DialogDescription>
            Read the numbers off the post and type them here. They are stored
            exactly like connector-sourced metrics, so Analytics and Marketing
            Memory both use them — you do not have to wait for an integration.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="draft">Attach to</Label>
            <select
              id="draft"
              value={draftId}
              onChange={(e) => setDraftId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
            >
              <option value="">Account level (no specific post)</option>
              {drafts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {FIELDS.map((field) => (
              <div key={field.key} className="space-y-1.5">
                <Label htmlFor={field.key}>{field.label}</Label>
                <Input
                  id={field.key}
                  inputMode="numeric"
                  placeholder="—"
                  value={values[field.key] ?? ''}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [field.key]: e.target.value }))
                  }
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Leave anything you don&apos;t have blank — partial numbers are still
            useful, and a blank field is never treated as a zero.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save results
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
