'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  History,
  Info,
  Lightbulb,
  RefreshCw,
  Search,
} from 'lucide-react';

import { toast } from '@/components/ui/toaster';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LocalTime } from '@/components/ui/local-time';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  OPPORTUNITY_TYPES,
  OPPORTUNITY_TYPE_INFO,
  type OpportunitySource,
  type OpportunityStatus,
  type OpportunityType,
} from '@/lib/opportunities';
import {
  CONFIDENCE_INFO,
  DEFAULT_FILTERS,
  PRIORITY_INFO,
  SORTS,
  SOURCE_LABEL,
  STATUS_FILTERS,
  STATUS_INFO,
  countByGroup,
  filterOpportunities,
  personTransitions,
  transitionLabel,
  type OpportunityFilters,
  type OpportunityView,
  type SortId,
  type StatusFilter,
} from '@/lib/opportunity-ui';

const selectClass =
  'rounded-md border border-input bg-background px-2 py-1.5 text-sm';

export function OpportunitiesView({
  opportunities,
  canAct,
  focusId,
}: {
  opportunities: OpportunityView[];
  canAct: boolean;
  focusId: string | null;
}) {
  const router = useRouter();
  const focused = opportunities.find((o) => o.id === focusId);
  const [filters, setFilters] = useState<OpportunityFilters>(() => ({
    ...DEFAULT_FILTERS,
    // Opening a link to a closed opportunity should show it, not hide it.
    ...(focused && focused.statusGroup !== 'active'
      ? { status: 'all' as const }
      : {}),
  }));
  const [detecting, setDetecting] = useState(false);

  const counts = useMemo(() => countByGroup(opportunities), [opportunities]);
  const shown = useMemo(
    () => filterOpportunities([...opportunities], filters),
    [opportunities, filters],
  );
  // Only offer filters that would match something.
  const types = OPPORTUNITY_TYPES.filter((t) =>
    opportunities.some((o) => o.type === t),
  );
  const sources = [...new Set(opportunities.map((o) => o.source))];

  useEffect(() => {
    if (focusId) {
      document
        .getElementById(`opp-${focusId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [focusId]);

  async function detect() {
    setDetecting(true);
    try {
      const res = await fetch('/api/opportunities/detect', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        outcomes?: { outcome: string }[];
        ai?: { outcomes?: { outcome: string }[]; status?: string } | null;
      };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not look for opportunities.');
        return;
      }
      const all = [...(body.outcomes ?? []), ...(body.ai?.outcomes ?? [])];
      const created = all.filter(
        (o) => o.outcome === 'created' || o.outcome === 'reopened',
      ).length;
      toast.success(
        created
          ? `${created} new opportunit${created === 1 ? 'y' : 'ies'} found.`
          : 'Checked your latest signals — nothing new right now.',
      );
      router.refresh();
    } finally {
      setDetecting(false);
    }
  }

  const detectBtn = canAct ? (
    <Button onClick={detect} loading={detecting} size="sm">
      <RefreshCw className="h-4 w-4" /> Look for new opportunities
    </Button>
  ) : null;

  if (opportunities.length === 0) {
    return (
      <EmptyState
        icon={Lightbulb}
        title="No opportunities yet"
        description="Aura finds opportunities in what your competitors do, what your market discusses and what has worked for you. Track a competitor or refresh Market trends, then look again."
        action={detectBtn}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 lg:flex-row lg:items-center lg:justify-between">
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Show opportunities"
        >
          {STATUS_FILTERS.map((s) => (
            <Button
              key={s.id}
              type="button"
              size="sm"
              aria-pressed={filters.status === s.id}
              variant={filters.status === s.id ? 'default' : 'outline'}
              onClick={() =>
                setFilters((f) => ({ ...f, status: s.id as StatusFilter }))
              }
            >
              {s.label}
              <span className="text-xs opacity-75">{counts[s.id]}</span>
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="opp-type">
            Type
          </label>
          <select
            id="opp-type"
            className={selectClass}
            value={filters.type}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                type: e.target.value as OpportunityType | 'all',
              }))
            }
          >
            <option value="all">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {OPPORTUNITY_TYPE_INFO[t].label}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="opp-source">
            Source
          </label>
          <select
            id="opp-source"
            className={selectClass}
            value={filters.source}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                source: e.target.value as OpportunitySource | 'all',
              }))
            }
          >
            <option value="all">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
          <label className="text-sm text-muted-foreground" htmlFor="opp-sort">
            Sort
          </label>
          <select
            id="opp-sort"
            className={selectClass}
            value={filters.sort}
            onChange={(e) =>
              setFilters((f) => ({ ...f, sort: e.target.value as SortId }))
            }
          >
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          {detectBtn}
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon={Search}
          title="Nothing matches these filters"
          description={
            filters.status === 'active'
              ? 'No open opportunities right now. Accepted, rejected and expired ones are under the other tabs.'
              : 'Try a different status, type or source.'
          }
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilters(DEFAULT_FILTERS)}
            >
              Reset filters
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {shown.map((o) => (
            <OpportunityCard
              key={o.id}
              opportunity={o}
              canAct={canAct}
              initiallyOpen={o.id === focusId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OpportunityCard({
  opportunity: o,
  canAct,
  initiallyOpen,
}: {
  opportunity: OpportunityView;
  canAct: boolean;
  initiallyOpen: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(initiallyOpen);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState<OpportunityStatus | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const status = STATUS_INFO[o.status];
  const closed = o.statusGroup === 'closed';

  async function move(to: OpportunityStatus, withNote?: string) {
    setBusy(to);
    try {
      const res = await fetch(`/api/opportunities/${o.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: to,
          ...(withNote?.trim() ? { note: withNote.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not update this opportunity.');
        return;
      }
      toast.success(`Marked ${STATUS_INFO[to].label.toLowerCase()}.`);
      setRejecting(false);
      setNote('');
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      id={`opp-${o.id}`}
      className={cn(
        'scroll-mt-20',
        closed && 'bg-muted/30',
        initiallyOpen && 'ring-2 ring-primary/40',
      )}
    >
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={status.variant} title={status.description}>
            {status.label}
          </Badge>
          {!closed && (
            <Badge
              variant={PRIORITY_INFO[o.priority].variant}
              title={`Priority score ${o.priorityScore}/100`}
            >
              {PRIORITY_INFO[o.priority].label}
            </Badge>
          )}
          <Badge variant="outline" title={o.confidenceReason ?? undefined}>
            {CONFIDENCE_INFO[o.confidence].label}
          </Badge>
          <Badge variant="muted">{o.typeLabel}</Badge>
        </div>
        <CardTitle
          className={cn('text-base', closed && 'text-muted-foreground')}
        >
          {o.title}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {o.sourceLabel} · {o.detectedByLabel} · Detected{' '}
          <LocalTime iso={o.detectedAt} kind="date" />
          {' · '}
          <Timing o={o} />
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {o.summary && <p className="text-sm">{o.summary}</p>}

        <section aria-label="Why Aura identified this">
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Why Aura found this
          </h4>
          {o.why.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {o.why.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              See the evidence below.
            </p>
          )}
          {o.confidenceReason && (
            <p className="mt-2 text-xs text-muted-foreground">
              <Info className="mr-1 inline h-3 w-3" aria-hidden />
              {CONFIDENCE_INFO[o.confidence].label}: {o.confidenceReason}
            </p>
          )}
          {o.warnings.map((w, i) => (
            <p key={i} className="mt-1 text-xs text-muted-foreground">
              Note: {w}
            </p>
          ))}
        </section>

        {o.angle && (
          <p className="text-sm">
            <span className="font-medium">Angle: </span>
            {o.angle}
          </p>
        )}

        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            Evidence ({o.evidence.length})
          </button>
          {open && (
            <ul className="mt-2 space-y-2">
              {o.evidence.map((e) => (
                <li
                  key={e.id}
                  className="rounded-md border border-border bg-background p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {e.kindLabel}
                    </span>
                    {e.observedAt && (
                      <span>
                        · <LocalTime iso={e.observedAt} kind="date" />
                      </span>
                    )}
                    {e.signal && (
                      <span title={e.signal.reliabilityReason}>
                        · {e.signal.source} signal,{' '}
                        {e.signal.reliability.toLowerCase()} reliability
                        {e.signal.occurrences > 1 &&
                          `, seen ${e.signal.occurrences}×`}
                        {e.signal.expired && ' (no longer current)'}
                      </span>
                    )}
                    {e.signalRemoved && (
                      <span>· original signal no longer stored</span>
                    )}
                  </div>
                  <p className="mt-1 font-medium">{e.label}</p>
                  <p className="text-muted-foreground">{e.detail}</p>
                  {e.supports && (
                    <p className="mt-1 text-xs">
                      <span className="font-medium">
                        How it supports this:{' '}
                      </span>
                      {e.supports}
                    </p>
                  )}
                  {(e.sourcePage || e.externalUrl) && (
                    <div className="mt-2 flex flex-wrap gap-3 text-xs">
                      {e.sourcePage && (
                        <Link
                          href={e.sourcePage.href}
                          className="text-primary hover:underline"
                        >
                          {e.sourcePage.label}
                        </Link>
                      )}
                      {e.externalUrl && (
                        <a
                          href={e.externalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          Original source <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
          <p className="text-sm">
            <span className="font-medium">Next step: </span>
            {o.nextStep.text}
          </p>
          {o.decisionNote && (
            <p className="mt-1 text-xs text-muted-foreground">
              Decision note: {o.decisionNote}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {o.nextStep.link && (
              <Button asChild size="sm">
                <Link href={o.nextStep.link.href}>
                  {o.nextStep.link.label} <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            )}
            {canAct &&
              !rejecting &&
              personTransitions(o).map((to) => (
                <Button
                  key={to}
                  size="sm"
                  variant={
                    to === 'REJECTED'
                      ? 'ghost'
                      : to === 'ACCEPTED'
                        ? 'default'
                        : 'outline'
                  }
                  loading={busy === to}
                  disabled={busy !== null}
                  onClick={() =>
                    to === 'REJECTED' ? setRejecting(true) : move(to)
                  }
                >
                  {transitionLabel(o.status, to)}
                </Button>
              ))}
          </div>
          {rejecting && (
            <div className="mt-3 space-y-2">
              <label
                htmlFor={`reject-${o.id}`}
                className="text-xs text-muted-foreground"
              >
                Why not? (optional — helps Aura stop suggesting things like
                this)
              </label>
              <Textarea
                id={`reject-${o.id}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={2000}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  loading={busy === 'REJECTED'}
                  onClick={() => move('REJECTED', note)}
                >
                  Reject
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRejecting(false);
                    setNote('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>

        {o.history.length > 0 && (
          <div>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              aria-expanded={showHistory}
              onClick={() => setShowHistory((v) => !v)}
            >
              <History className="h-3 w-3" /> History ({o.history.length})
            </button>
            {showHistory && (
              <ol className="mt-2 space-y-1 border-l border-border pl-3 text-xs text-muted-foreground">
                {o.history.map((h) => (
                  <li key={h.id}>
                    <LocalTime iso={h.at} /> —{' '}
                    {h.from
                      ? `${STATUS_INFO[h.from].label} → ${STATUS_INFO[h.to].label}`
                      : `${STATUS_INFO[h.to].label}`}{' '}
                    {h.byPerson ? 'by a teammate' : 'by Aura'}
                    {h.note && `: ${h.note}`}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** When it stops (or stopped) being worth acting on. */
function Timing({ o }: { o: OpportunityView }) {
  if (o.status === 'EXPIRED') {
    return (
      <>
        Expired{' '}
        {o.relevantUntil ? (
          <LocalTime iso={o.relevantUntil} kind="date" />
        ) : (
          <LocalTime iso={o.statusChangedAt} kind="date" />
        )}
      </>
    );
  }
  if (o.status === 'REJECTED' || o.status === 'ACCEPTED') {
    return (
      <>
        {STATUS_INFO[o.status].label}{' '}
        <LocalTime iso={o.statusChangedAt} kind="date" />
      </>
    );
  }
  if (o.daysLeft === null) return <>No expiry</>;
  if (o.daysLeft <= 1) return <>Closes today</>;
  return (
    <span className={cn(o.daysLeft <= 7 && 'font-medium text-foreground')}>
      Relevant for {o.daysLeft} more days
    </span>
  );
}
