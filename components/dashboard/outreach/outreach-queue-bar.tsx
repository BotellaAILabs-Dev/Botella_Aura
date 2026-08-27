'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Check, ShieldCheck, X } from 'lucide-react';

import { toast } from '@/components/ui/toaster';
import { Button } from '@/components/ui/button';

/**
 * Bulk approval + backlog warning for the outreach queue.
 *
 * Two problems this addresses. Approving message-by-message does not scale for
 * a small team, so the queue silently grows; and once approved, a message sits
 * in the extension queue until a human sends it, with nothing anywhere saying
 * it has been waiting. Both ends of that funnel are now visible and actionable.
 */
export function OutreachQueueBar({
  pendingCount,
  staleApproved,
  canApprove,
}: {
  pendingCount: number;
  /** Approved messages that have been waiting long enough to flag. */
  staleApproved: { count: number; oldestDays: number };
  canApprove: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function bulk(action: 'approve' | 'reject') {
    setBusy(action);
    try {
      const listRes = await fetch(
        '/api/outreach/messages/bulk?status=PENDING_APPROVAL',
      );
      const list = (await listRes.json().catch(() => ({}))) as { ids?: string[] };
      const ids = list.ids ?? [];
      if (ids.length === 0) {
        toast('Nothing is waiting for approval.');
        return;
      }
      if (
        action === 'approve' &&
        !confirm(
          `Approve ${ids.length} message${ids.length === 1 ? '' : 's'}? ` +
            'They move to your extension queue — you still send each one yourself.',
        )
      ) {
        return;
      }
      if (
        action === 'reject' &&
        !confirm(`Reject ${ids.length} message${ids.length === 1 ? '' : 's'}?`)
      ) {
        return;
      }

      const res = await fetch('/api/outreach/messages/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds: ids, action }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        succeeded?: number;
        failed?: { id: string }[];
        error?: string;
      };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not complete that.');
        return;
      }
      const failed = body.failed?.length ?? 0;
      toast.success(
        failed === 0
          ? `${body.succeeded} message${body.succeeded === 1 ? '' : 's'} ${action}d.`
          : `${body.succeeded} ${action}d, ${failed} could not be — they may have moved on already.`,
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mb-5 space-y-3">
      {/* Why sending is manual — explained where the sending happens, not
          only in Settings where a first-time user will not look. */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          Approved messages appear in your{' '}
          <span className="font-medium text-foreground">browser extension</span>{' '}
          queue, and you send each one yourself from the lead&apos;s profile.
          That is deliberate: LinkedIn&apos;s API does not permit automated
          connection requests or messages, so anything that sent them for you
          would put your account at risk.
        </p>
      </div>

      {staleApproved.count > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">
              {staleApproved.count} approved message
              {staleApproved.count === 1 ? '' : 's'} waiting to be sent
            </span>{' '}
            — the oldest has been queued {staleApproved.oldestDays} day
            {staleApproved.oldestDays === 1 ? '' : 's'}. Open the extension on
            LinkedIn to send them.
          </p>
        </div>
      )}

      {canApprove && pendingCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="text-foreground">
            {pendingCount} message{pendingCount === 1 ? '' : 's'} awaiting your
            review
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void bulk('approve')}
              loading={busy === 'approve'}
            >
              <Check className="h-4 w-4" /> Approve all {pendingCount}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void bulk('reject')}
              loading={busy === 'reject'}
            >
              <X className="h-4 w-4" /> Reject all
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
