'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  SkipForward,
  Sparkles,
} from 'lucide-react';

import { toast } from '@/components/ui/toaster';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { SuggestionView } from '@/lib/aura-suggests';
import { CONTENT_CHANNELS } from '@/lib/validations/planner';

/**
 * "Aura Suggests" — what Aura believes the business should consider doing
 * next. Each card answers What, Why, Expected outcome and Based on (with the
 * evidence a click away), and ends in one clear next step: the action that
 * carries it out, Edit, or Skip.
 *
 * Shown suggestions are reported as presented (once — the server ignores
 * repeats). Only people who can decide (owners, admins) get the actions.
 */

async function send(
  url: string,
  method: 'POST' | 'PATCH',
  body: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: res.ok, error: data.error };
}

export function AuraSuggests({
  suggestions,
  accepted = [],
  canAct,
  canRecord,
  surface,
  compact = false,
}: {
  suggestions: SuggestionView[];
  accepted?: SuggestionView[];
  /** May accept, edit and skip (owners and admins). */
  canAct: boolean;
  /** May record that suggestions were seen (members and up). */
  canRecord: boolean;
  /** Where they are shown, recorded with each presentation. */
  surface: string;
  /** The home page shows the top few, more tightly. */
  compact?: boolean;
}) {
  const reported = useRef<string>('');
  useEffect(() => {
    if (!canRecord) return;
    const fresh = suggestions.filter((s) => s.status === 'GENERATED');
    const key = fresh.map((s) => s.id).join(',');
    if (!key || reported.current === key) return;
    reported.current = key;
    void fetch('/api/recommendations/presented', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: fresh.map((s) => s.id),
        surface,
        positions: Object.fromEntries(
          fresh.map((s) => [s.id, { rank: s.rank }]),
        ),
      }),
    }).catch(() => undefined);
  }, [suggestions, canRecord, surface]);

  return (
    <div className="space-y-4">
      {suggestions.map((s) => (
        <SuggestionCard key={s.id} s={s} canAct={canAct} compact={compact} />
      ))}
      {!canAct && suggestions.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Owners and admins can act on these suggestions.
        </p>
      )}
      {accepted.length > 0 && (
        <div className="space-y-2 pt-2">
          <h3 className="text-sm font-semibold text-foreground">
            You said yes to
          </h3>
          {accepted.map((s) => (
            <AcceptedRow key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function SuggestionCard({
  s,
  canAct,
  compact,
}: {
  s: SuggestionView;
  canAct: boolean;
  compact: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const url = `/api/recommendations/${s.id}`;

  async function decide(
    decision: 'ACCEPTED' | 'SKIPPED' | 'REJECTED',
  ): Promise<boolean> {
    const r = await send(`${url}/decision`, 'POST', {
      decision,
      expectedStatus: s.status,
    });
    if (!r.ok) {
      toast.error(r.error ?? 'Could not update this suggestion.');
      router.refresh();
    }
    return r.ok;
  }

  async function goNext() {
    setBusy('next');
    try {
      if (s.next.accepts && !(await decide('ACCEPTED'))) return;
      router.push(s.next.href);
    } finally {
      setBusy(null);
    }
  }

  async function skip(decision: 'SKIPPED' | 'REJECTED') {
    setBusy(decision);
    try {
      if (await decide(decision)) {
        toast.success(
          decision === 'SKIPPED'
            ? 'Skipped. Aura will suggest something else.'
            : 'Got it — Aura will suggest fewer like this.',
        );
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function notNow() {
    setBusy('snooze');
    try {
      const r = await send(`${url}/snooze`, 'POST', { days: 7 });
      if (!r.ok) {
        toast.error(r.error ?? 'Could not set this aside.');
        return;
      }
      toast.success('Set aside for a week. It will come back then.');
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardContent className={cn('space-y-4', compact ? 'p-4' : 'p-5')}>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1 font-semibold text-primary">
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Aura Suggests
          </span>
          <Badge variant={s.rank === 1 ? 'default' : 'muted'}>{s.place}</Badge>
          {s.timing && <Badge variant="warning">{s.timing}</Badge>}
          {s.resurfaced && <Badge variant="outline">Back from “Not now”</Badge>}
        </div>

        {editing ? (
          <EditForm
            s={s}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              router.refresh();
            }}
          />
        ) : (
          <>
            <div>
              <h3 className="text-lg font-semibold leading-snug text-foreground">
                {s.what}
              </h3>
              <p className="mt-1 text-sm text-foreground/90">{s.action}</p>
              {s.steps.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowSteps((v) => !v)}
                  className="mt-1.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  aria-expanded={showSteps}
                >
                  {showSteps ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  How to do it ({s.steps.length} step
                  {s.steps.length === 1 ? '' : 's'})
                </button>
              )}
              {showSteps && (
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                  {s.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              )}
            </div>

            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="sm:col-span-2">
                <dt className="font-medium text-foreground">Why</dt>
                <dd className="mt-0.5 text-muted-foreground">{s.why}</dd>
                {s.whyNow.length > 0 && (
                  <dd className="mt-1 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground/80">
                      Why now:
                    </span>{' '}
                    {s.whyNow.join(' · ')}
                  </dd>
                )}
              </div>
              <div>
                <dt className="font-medium text-foreground">
                  Expected outcome
                </dt>
                <dd className="mt-0.5 text-muted-foreground">
                  {s.expectedOutcome}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Based on</dt>
                <dd className="mt-0.5">
                  <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                    {s.basedOn.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {s.confidence}
                  </p>
                </dd>
              </div>
            </dl>

            {s.evidence.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowEvidence((v) => !v)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  aria-expanded={showEvidence}
                >
                  {showEvidence ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  See the evidence ({s.evidence.length})
                </button>
                {showEvidence && (
                  <ul className="mt-2 space-y-2">
                    {s.evidence.map((e) => (
                      <li
                        key={e.id}
                        className="rounded-md border border-border bg-muted/30 p-3 text-sm"
                      >
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground/80">
                            {e.source}
                          </span>
                          {e.seen && <span>· {e.seen}</span>}
                          {!e.current && (
                            <Badge variant="muted">No longer current</Badge>
                          )}
                        </div>
                        <p className="mt-1 font-medium text-foreground">
                          {e.label}
                        </p>
                        {e.detail && e.detail !== e.label && (
                          <p className="mt-0.5 text-muted-foreground">
                            {e.detail}
                          </p>
                        )}
                        {e.url && (
                          <a
                            href={e.url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            Open the source <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {s.caution && (
              <p className="flex items-start gap-2 rounded-md bg-warning/10 p-2.5 text-xs text-foreground/90">
                <AlertTriangle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 [color:hsl(38_92%_40%)]"
                  aria-hidden
                />
                {s.caution}
              </p>
            )}

            {canAct && (
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
                <Button onClick={goNext} disabled={busy !== null}>
                  {s.next.label} <ArrowRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setEditing(true)}
                  disabled={busy !== null}
                >
                  <Pencil className="h-4 w-4" /> Edit
                </Button>
                <Button
                  variant="outline"
                  onClick={() => skip('SKIPPED')}
                  disabled={busy !== null}
                >
                  <SkipForward className="h-4 w-4" /> Skip
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="More options"
                      disabled={busy !== null}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={notNow}>
                      Not now — remind me in a week
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => skip('REJECTED')}>
                      Not for us — suggest fewer like this
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
            {s.next.related.length > 0 && !s.next.blocked && (
              <p className="text-xs text-muted-foreground">
                Also useful:{' '}
                {s.next.related.map((r, i) => (
                  <span key={r.href}>
                    {i > 0 && ' · '}
                    <Link
                      href={r.href}
                      className="text-primary hover:underline"
                    >
                      {r.label}
                    </Link>
                  </span>
                ))}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function EditForm({
  s,
  onCancel,
  onSaved,
}: {
  s: SuggestionView;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(s.editable.title);
  const [action, setAction] = useState(s.editable.action);
  const [steps, setSteps] = useState(s.editable.steps.join('\n'));
  const [outcome, setOutcome] = useState(s.editable.expectedOutcome);
  const [channel, setChannel] = useState(s.editable.channel ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    const nextSteps = steps
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    const changes: Record<string, unknown> = {};
    if (title.trim() !== s.editable.title) changes.title = title.trim();
    if (action.trim() !== s.editable.action) changes.action = action.trim();
    if (JSON.stringify(nextSteps) !== JSON.stringify(s.editable.steps)) {
      changes.steps = nextSteps;
    }
    if (outcome.trim() !== s.editable.expectedOutcome) {
      changes.expectedOutcome = outcome.trim();
    }
    if ((channel || null) !== s.editable.channel)
      changes.channel = channel || null;
    if (Object.keys(changes).length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    try {
      const r = await send(`/api/recommendations/${s.id}`, 'PATCH', {
        changes,
        expectedStatus: s.status,
      });
      if (!r.ok) {
        toast.error(r.error ?? 'Could not save your changes.');
        return;
      }
      toast.success(
        'Saved. This suggestion is now in your plan, with your changes.',
      );
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="text-xs text-muted-foreground">
        Change anything that doesn’t fit. Saving says yes to the suggestion with
        your changes; Aura keeps the original too.
      </p>
      <div className="space-y-1">
        <Label htmlFor={`t-${s.id}`}>What</Label>
        <Input
          id={`t-${s.id}`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          required
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`a-${s.id}`}>What to do</Label>
        <Textarea
          id={`a-${s.id}`}
          value={action}
          onChange={(e) => setAction(e.target.value)}
          rows={2}
          maxLength={500}
          required
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`s-${s.id}`}>Steps (one per line)</Label>
        <Textarea
          id={`s-${s.id}`}
          value={steps}
          onChange={(e) => setSteps(e.target.value)}
          rows={3}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`o-${s.id}`}>Expected outcome</Label>
        <Textarea
          id={`o-${s.id}`}
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          rows={2}
          maxLength={1000}
          required
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`c-${s.id}`}>Channel</Label>
        <select
          id={`c-${s.id}`}
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">No specific channel</option>
          {CONTENT_CHANNELS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          Save changes
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AcceptedRow({ s }: { s: SuggestionView }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card p-3">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          {s.what}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {s.status === 'EDITED' ? 'Accepted with your changes' : 'Accepted'}
          {s.timing ? ` · ${s.timing.toLowerCase()}` : ''}
        </p>
        {s.caution && (
          <p className="mt-0.5 text-xs text-muted-foreground">{s.caution}</p>
        )}
      </div>
      <Button asChild size="sm" variant="outline">
        <Link href={s.next.href}>
          {s.next.label} <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  );
}
