'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckCheck, X, CalendarClock, Image as ImageIcon } from 'lucide-react';
import { Badge, statusBadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import { CONTENT_TYPE_LABELS, CONTENT_STATUS_LABELS } from '@/lib/content-ui';
import type { ContentTypeKey } from '@/lib/validations/content';

export interface DraftCard {
  id: string;
  type: ContentTypeKey;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'PUBLISHED';
  title: string | null;
  snippet: string;
  sourceKind: string | null;
  campaignName: string | null;
  scheduledFor: string | null;
  updatedAt: string;
  /** Where this post is aimed, so the board shows LinkedIn vs Instagram at a glance. */
  platformLabel: string;
  /** How many graphics are attached. Zero renders no badge. */
  mediaCount: number;
}

const COLUMNS: DraftCard['status'][] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PUBLISHED',
];

/**
 * Per-column empty copy.
 *
 * A single "Nothing here" in every column is ambiguous: an empty Pending column
 * is good news, an empty Published column is a to-do, and neither should be
 * mistakable for a load that stalled. Each column now says which it is.
 */
const EMPTY_COPY: Record<DraftCard['status'], string> = {
  DRAFT: 'No drafts in progress — generate one to start.',
  PENDING_APPROVAL: 'Nothing waiting on you.',
  APPROVED: 'Nothing approved and waiting to publish.',
  PUBLISHED: 'Nothing published yet.',
  REJECTED: 'Nothing rejected.',
};

export function QueueBoard({ drafts }: { drafts: DraftCard[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulk(action: 'approve' | 'reject') {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const res = await fetch('/api/content/drafts/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected], action }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: string[];
        failed?: unknown[];
      };
      const okCount = data.ok?.length ?? 0;
      const failCount = data.failed?.length ?? 0;
      toast.success(
        `${action === 'approve' ? 'Approved' : 'Rejected'} ${okCount}` +
          (failCount ? ` · ${failCount} skipped (invalid state)` : ''),
      );
      setSelected(new Set());
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const rejected = drafts.filter((d) => d.status === 'REJECTED');

  return (
    <div>
      <div className="grid gap-4 lg:grid-cols-4">
        {COLUMNS.map((status) => {
          const items = drafts.filter((d) => d.status === status);
          return (
            <div key={status} className="flex flex-col">
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-medium text-foreground">
                  {CONTENT_STATUS_LABELS[status]}
                </span>
                <span className="text-xs text-muted-foreground">{items.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {items.length === 0 && (
                  <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                    {EMPTY_COPY[status]}
                  </p>
                )}
                {items.map((d) => (
                  <Card
                    key={d.id}
                    draft={d}
                    checked={selected.has(d.id)}
                    onToggle={() => toggle(d.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {rejected.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Rejected ({rejected.length})
          </summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {rejected.map((d) => (
              <Card
                key={d.id}
                draft={d}
                checked={selected.has(d.id)}
                onToggle={() => toggle(d.id)}
              />
            ))}
          </div>
        </details>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-4 z-30 mx-auto flex w-fit items-center gap-3 rounded-full border border-border bg-card px-4 py-2 shadow-lg">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <Button size="sm" onClick={() => bulk('approve')} loading={busy}>
            <CheckCheck className="h-4 w-4" /> Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => bulk('reject')} loading={busy}>
            <X className="h-4 w-4" /> Reject
          </Button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

function Card({
  draft,
  checked,
  onToggle,
}: {
  draft: DraftCard;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-xs transition-shadow hover:shadow-sm">
      <div className="mb-1.5 flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="h-4 w-4 rounded border-input"
          aria-label="Select draft"
        />
        <Badge variant="muted">{CONTENT_TYPE_LABELS[draft.type]}</Badge>
        <Badge variant={statusBadgeVariant(draft.status)}>
          {CONTENT_STATUS_LABELS[draft.status]}
        </Badge>
      </div>
      <Link
        href={`/dashboard/content/${draft.id}`}
        className="block text-sm font-medium text-foreground hover:text-primary"
      >
        {draft.snippet || draft.title || 'Untitled'}
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{draft.platformLabel}</span>
        {draft.mediaCount > 0 && (
          <span
            className="inline-flex items-center gap-1"
            title={`${draft.mediaCount} graphic${draft.mediaCount > 1 ? 's' : ''} attached`}
          >
            <ImageIcon className="h-3 w-3" />
            {draft.mediaCount > 1 ? draft.mediaCount : ''}
          </span>
        )}
        {draft.sourceKind && <span>· from {draft.sourceKind.toLowerCase()}</span>}
        {draft.campaignName && <span>· {draft.campaignName}</span>}
        {draft.scheduledFor && (
          <span className="inline-flex items-center gap-1 text-primary">
            <CalendarClock className="h-3 w-3" />
            {new Date(draft.scheduledFor).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}
