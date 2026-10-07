'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';

/**
 * The way out of an empty Aura Suggests:
 *   · open opportunities without a suggestion → "Get Aura’s suggestions"
 *     (runs the engine over them; its guardrails still decide)
 *   · none → "Check for new opportunities" (refreshes signals, detects,
 *     and suggests in one go)
 * What the engine skipped is said, with its reason — never a silent nothing.
 */
interface Report {
  created: { title: string }[];
  skipped: { title: string; reasons: string[] }[];
  remaining: number;
}

export function SuggestActions({
  pending,
  canAct,
}: {
  /** Open opportunities that have no suggestion yet. */
  pending: number;
  canAct: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!canAct) {
    return (
      <p className="text-xs text-muted-foreground">
        An owner or admin can ask Aura for suggestions.
      </p>
    );
  }

  async function run() {
    setBusy(true);
    try {
      const res = await fetch(
        pending > 0
          ? '/api/recommendations/generate'
          : '/api/opportunities/detect',
        { method: 'POST' },
      );
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        suggestions?: Report | null;
      } & Partial<Report>;
      if (!res.ok) {
        toast.error(data.error ?? 'Aura could not do that just now.');
        return;
      }
      const report: Report | null =
        pending > 0 ? (data as Report) : (data.suggestions ?? null);
      const made = report?.created.length ?? 0;
      if (made > 0) {
        toast.success(
          `Aura made ${made} suggestion${made === 1 ? '' : 's'}.${
            report!.remaining ? ` ${report!.remaining} more next time.` : ''
          }`,
        );
      } else if (
        report?.skipped.some((s) =>
          s.reasons.some((r) => /has not said where it publishes/.test(r)),
        )
      ) {
        toast.message?.(
          'Aura found opportunities but won’t guess where you publish. Add your channels in About my business.',
        );
      } else if (report && report.skipped.length > 0) {
        toast.message?.(
          `Aura looked at ${report.skipped.length} opportunit${
            report.skipped.length === 1 ? 'y' : 'ies'
          } but none passed its checks yet: ${report.skipped[0]!.reasons[0] ?? 'not enough evidence'}`,
        );
      } else {
        toast.message?.('Nothing new to suggest right now.');
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={run} loading={busy} disabled={busy}>
      {pending > 0 ? (
        <>
          <Sparkles className="h-4 w-4" /> Get Aura’s suggestions
        </>
      ) : (
        <>
          <RefreshCw className="h-4 w-4" /> Check for new opportunities
        </>
      )}
    </Button>
  );
}
