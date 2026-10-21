'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ExternalLink, History, RotateCcw, XCircle } from 'lucide-react';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import { STATE_TONE, type ExecutionState } from '@/lib/execution-state';
import { formatInZone } from '@/lib/timezone';

export interface ExecutionRow {
  id: string;
  contentId: string;
  contentTitle: string | null;
  channel: string;
  provider: string | null;
  target: { kind: string | null; id: string; name: string | null } | null;
  status: ExecutionState;
  statusLabel: string;
  scheduledFor: string | null;
  scheduledTimeZone: string | null;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  completedAt: string | null;
  url: string | null;
  error: { code: string; message: string | null; at: string | null } | null;
  canCancel: boolean;
  canRetry: boolean;
  updatedAt: string;
}

interface EventRow {
  id: string;
  fromLabel: string | null;
  toLabel: string;
  actor: string;
  reason: string | null;
  at: string;
}

interface Chain {
  businessContext: { revision: string | null; name: string | null } | null;
  opportunity: { id: string; title?: string } | null;
  recommendation: { id: string; title?: string } | null;
  content: { id: string; title: string | null };
  approval: { id: string | null; version: number | null; by?: string | null; at?: string | null } | null;
  execution: { id: string; status: string; url: string | null };
}

const TONE: Record<string, BadgeProps['variant']> = {
  neutral: 'secondary',
  info: 'outline',
  progress: 'default',
  success: 'success',
  warning: 'warning',
  danger: 'destructive',
  muted: 'muted',
};
const NETWORK: Record<string, string> = { FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', LINKEDIN: 'LinkedIn', X: 'X' };

/** Executions with their state, history, trace and the actions a person can take. */
export function ExecutionList({
  executions,
  timeZone,
  canAct,
  showContent = true,
}: {
  executions: ExecutionRow[];
  timeZone: string;
  canAct: boolean;
  showContent?: boolean;
}) {
  if (executions.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing has been approved for publishing yet.</p>;
  }
  return (
    <ul className="space-y-3">
      {executions.map((e) => (
        <ExecutionItem key={e.id} e={e} timeZone={timeZone} canAct={canAct} showContent={showContent} />
      ))}
    </ul>
  );
}

function ExecutionItem({ e, timeZone, canAct, showContent }: { e: ExecutionRow; timeZone: string; canAct: boolean; showContent: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ events: EventRow[]; chain: Chain } | null>(null);

  async function act(kind: 'cancel' | 'retry') {
    if (kind === 'cancel' && !confirm('Cancel this? It will not be published unless someone publishes it.')) return;
    setBusy(kind);
    try {
      const res = await fetch(`/api/executions/${e.id}/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = (await res.json().catch(() => ({}))) as { error?: string; result?: { mode?: string; message?: string; reason?: string } };
      if (!res.ok) {
        toast.error(body.error ?? `Could not ${kind}.`);
        return;
      }
      if (kind === 'cancel') toast.success('Cancelled.');
      else if (body.result?.mode === 'published') toast.success('Published.');
      else toast(body.result?.message ?? body.result?.reason ?? 'Tried again — see the status.', { duration: 8000 });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function toggleHistory() {
    if (detail) {
      setDetail(null);
      return;
    }
    const res = await fetch(`/api/executions/${e.id}`);
    if (res.ok) setDetail((await res.json()) as { events: EventRow[]; chain: Chain });
    else toast.error('Could not load the history.');
  }

  const tz = timeZone;
  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {NETWORK[e.channel] ?? e.channel}
            {e.target?.name ? <span className="font-normal text-muted-foreground"> · {e.target.name}</span> : null}
          </p>
          {showContent ? (
            <Link href={`/dashboard/content/${e.contentId}`} className="block truncate text-xs text-primary hover:underline">
              {e.contentTitle ?? 'Untitled post'}
            </Link>
          ) : null}
        </div>
        <Badge variant={TONE[STATE_TONE[e.status]] ?? 'secondary'}>{e.statusLabel}</Badge>
      </div>

      <p className="mt-1 text-xs text-muted-foreground" suppressHydrationWarning>
        {e.status === 'COMPLETED' && e.completedAt
          ? `Published ${formatInZone(e.completedAt, tz)}`
          : e.scheduledFor
            ? `${e.status === 'SCHEDULED' ? 'Scheduled for' : 'Was scheduled for'} ${formatInZone(e.scheduledFor, tz)}`
            : 'No time set — publishes when a person publishes it'}
        {e.attemptCount > 0 ? ` · attempt ${e.attemptCount} of ${e.maxAttempts}` : ''}
        {e.provider ? ` · via ${e.provider === 'meta' ? 'Meta' : e.provider === 'linkedin' ? 'LinkedIn' : e.provider}` : ''}
      </p>

      {e.error && e.status !== 'COMPLETED' ? (
        <p className="mt-2 rounded bg-destructive/5 p-2 text-xs">
          {e.error.message}
          {e.nextAttemptAt ? (
            <span className="text-muted-foreground" suppressHydrationWarning>
              {' '}
              Next automatic try: {formatInZone(e.nextAttemptAt, tz)}.
            </span>
          ) : null}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-2">
        {e.url ? (
          <Button asChild size="sm" variant="outline">
            <a href={e.url} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" /> View post
            </a>
          </Button>
        ) : null}
        {canAct && e.canRetry ? (
          <Button size="sm" onClick={() => act('retry')} disabled={busy !== null} loading={busy === 'retry'}>
            <RotateCcw className="h-3.5 w-3.5" /> Retry now
          </Button>
        ) : null}
        {canAct && e.canCancel ? (
          <Button size="sm" variant="outline" onClick={() => act('cancel')} disabled={busy !== null} loading={busy === 'cancel'}>
            <XCircle className="h-3.5 w-3.5" /> Cancel
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={toggleHistory}>
          <History className="h-3.5 w-3.5" /> {detail ? 'Hide history' : 'History & trace'}
        </Button>
      </div>

      {detail ? (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label="Traceability">
            {[
              ['Business context', detail.chain.businessContext?.name ?? detail.chain.businessContext?.revision ?? null],
              ['Opportunity', detail.chain.opportunity ? (detail.chain.opportunity.title ?? detail.chain.opportunity.id) : null],
              ['Recommendation', detail.chain.recommendation ? (detail.chain.recommendation.title ?? detail.chain.recommendation.id) : null],
              ['Content', detail.chain.content.title ?? detail.chain.content.id],
              ['Approval', detail.chain.approval ? `v${detail.chain.approval.version ?? '?'}` : null],
              ['Execution', e.statusLabel],
            ].map(([label, value], i) => (
              <li key={label as string} className="flex items-center gap-1">
                {i > 0 ? <span className="text-muted-foreground">→</span> : null}
                <span className={value ? '' : 'text-muted-foreground line-through'} title={value ?? 'not linked'}>
                  {label}
                </span>
              </li>
            ))}
          </ol>
          <ol className="space-y-1 text-xs">
            {detail.events.map((ev) => (
              <li key={ev.id} className="flex flex-wrap gap-x-2">
                <span className="text-muted-foreground" suppressHydrationWarning>
                  {formatInZone(ev.at, tz, { withZone: false })}
                </span>
                <span className="font-medium">
                  {ev.fromLabel ? `${ev.fromLabel} → ` : ''}
                  {ev.toLabel}
                </span>
                <span className="text-muted-foreground">({ev.actor})</span>
                {ev.reason ? <span className="min-w-0 break-words">{ev.reason}</span> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </li>
  );
}
