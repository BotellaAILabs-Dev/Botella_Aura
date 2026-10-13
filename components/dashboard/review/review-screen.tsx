'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  CalendarClock,
  Check,
  ClipboardCheck,
  ExternalLink,
  Image as ImageIcon,
  Info,
  Pencil,
  RefreshCw,
  Save,
  Send,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  X,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';
import { cn } from '@/lib/utils';
import {
  changedEdits,
  editsStorageKey,
  type ReviewFlag,
  type ReviewItem,
} from '@/lib/review-item';

/**
 * The unified review screen (lib/review-item.ts): the same layout and the
 * same actions — Back, Edit, Save, Regenerate, Approve, Reject, Schedule — for
 * every kind of generated Aura work.
 */

const STATE_VARIANT = {
  draft: 'muted',
  in_review: 'warning',
  approved: 'success',
  rejected: 'destructive',
  done: 'default',
} as const;
const VERDICT = {
  pass: { label: 'Review passed', variant: 'success' },
  review_required: { label: 'Needs human review', variant: 'warning' },
  fail: { label: 'Review failed', variant: 'destructive' },
} as const;
const FLAG = {
  block: { label: 'Must fix', icon: XCircle, className: 'text-destructive' },
  review: { label: 'Check', icon: TriangleAlert, className: 'text-amber-600' },
  info: { label: 'Note', icon: Info, className: 'text-muted-foreground' },
} as const;

type Panel = 'regenerate' | 'reject' | 'schedule' | null;

function readStored(key: string): Record<string, string> | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}
function writeStored(key: string, edits: Record<string, string> | null) {
  try {
    if (edits && Object.keys(edits).length)
      window.localStorage.setItem(key, JSON.stringify(edits));
    else window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable: edits live in memory only */
  }
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}

function FlagRow({ f }: { f: ReviewFlag }) {
  const s = FLAG[f.severity];
  const Icon = s.icon;
  return (
    <li className="flex gap-2 text-sm">
      <Icon
        className={cn('mt-0.5 h-4 w-4 shrink-0', s.className)}
        aria-hidden
      />
      <span className="min-w-0">
        <span className={cn('font-medium', s.className)}>
          {s.label} · {f.label}
        </span>{' '}
        <span className="text-foreground">{f.message}</span>
        {f.quote && (
          <span className="text-muted-foreground"> — “{f.quote}”</span>
        )}
        <span className="ml-1 text-[11px] uppercase tracking-wide text-muted-foreground/70">
          {f.source}
        </span>
      </span>
    </li>
  );
}

export function ReviewScreen({ item }: { item: ReviewItem }) {
  const router = useRouter();
  const storageKey = editsStorageKey(item);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [restored, setRestored] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState('');
  const [instructions, setInstructions] = useState('');
  const [when, setWhen] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const autoReviewed = useRef(false);

  const dirty = useMemo(
    () => changedEdits(item.fields, edits),
    [item.fields, edits],
  );
  const isDirty = Object.keys(dirty).length > 0;
  const a = item.actions;
  const reviewCurrent = item.reviewer?.current ?? false;

  // Preserve edits: unsaved edits survive a reload or navigating away and
  // back (kept per item and per version), and leaving warns first.
  useEffect(() => {
    const stored = readStored(storageKey);
    if (stored && Object.keys(changedEdits(item.fields, stored)).length) {
      setEdits(stored);
      setEditing(true);
      setRestored(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  useEffect(() => {
    writeStored(storageKey, isDirty ? dirty : null);
  }, [storageKey, dirty, isDirty]);
  useEffect(() => {
    if (!isDirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  // A content piece whose review is missing or out of date is reviewed now,
  // so its quality warnings are in front of the person before they decide.
  useEffect(() => {
    if (
      autoReviewed.current ||
      item.kind !== 'content' ||
      (item.state !== 'draft' && item.state !== 'in_review') ||
      !a.regenerate.available ||
      reviewCurrent
    )
      return;
    autoReviewed.current = true;
    setReviewing(true);
    fetch(`/api/content/drafts/${item.id}/review`, { method: 'POST' })
      .then(() => router.refresh())
      .catch(() => undefined)
      .finally(() => setReviewing(false));
  }, [
    item.kind,
    item.id,
    item.state,
    reviewCurrent,
    a.regenerate.available,
    router,
  ]);

  async function act(
    body: Record<string, unknown>,
    label: string,
  ): Promise<boolean> {
    setBusy(label);
    try {
      const res = await fetch(`/api/review/${item.kind}/${item.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? 'Something went wrong.');
        return false;
      }
      toast.success(data.message ?? 'Done.');
      return true;
    } catch {
      toast.error('Could not reach the server. Try again.');
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!isDirty) {
      setEditing(false);
      return;
    }
    const ok = await act(
      { action: 'save', edits: dirty, baseUpdatedAt: item.updatedAt },
      'save',
    );
    if (ok) {
      writeStored(storageKey, null);
      setEdits({});
      setEditing(false);
      setRestored(false);
      autoReviewed.current = false;
      router.refresh();
    }
  }
  function discard() {
    writeStored(storageKey, null);
    setEdits({});
    setEditing(false);
    setRestored(false);
  }
  async function regenerate(mode: 'fresh' | 'fix_review' | 'instructions') {
    const ok = await act(
      {
        action: 'regenerate',
        mode,
        instructions: mode === 'instructions' ? instructions : undefined,
      },
      'regenerate',
    );
    if (ok) {
      setPanel(null);
      setInstructions('');
      router.refresh();
    }
  }
  async function simple(
    action: 'submit' | 'approve',
    extra: Record<string, unknown> = {},
  ) {
    if (await act({ action, ...extra }, action)) router.refresh();
  }
  async function reject() {
    if (
      await act(
        { action: 'reject', reason: reason.trim() || undefined },
        'reject',
      )
    ) {
      setPanel(null);
      router.refresh();
    }
  }
  async function schedule() {
    if (!when) return;
    if (
      await act(
        { action: 'schedule', scheduledFor: new Date(when).toISOString() },
        'schedule',
      )
    ) {
      setPanel(null);
      router.refresh();
    }
  }

  const value = (key: string, fallback: string) =>
    key in edits ? edits[key]! : fallback;
  const blocks = item.flags.filter((f) => f.severity === 'block');
  const checks = item.flags.filter((f) => f.severity === 'review');
  const notes = item.flags.filter((f) => f.severity === 'info');
  const approveBlocked = isDirty
    ? 'Save or discard your edits first.'
    : a.approve.reason;
  const ctx = item.context;

  return (
    <div
      className="pb-60 sm:pb-40"
      data-testid="review-screen"
      data-kind={item.kind}
      data-state={item.state}
    >
      <Link
        href={item.backHref}
        className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Review queue
      </Link>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground">
            {item.title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {item.module} · {item.typeLabel}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={STATE_VARIANT[item.state]}>{item.statusLabel}</Badge>
          {item.reviewer?.current && (
            <Badge variant={VERDICT[item.reviewer.status].variant}>
              {VERDICT[item.reviewer.status].label}
            </Badge>
          )}
          {blocks.length > 0 && (
            <Badge variant="destructive">{blocks.length} must fix</Badge>
          )}
          <Link
            href={item.moduleHref}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            Open in {item.module} <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {item.approval.blockedBy &&
        (item.state === 'draft' || item.state === 'in_review') && (
          <p className="mb-4 flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{' '}
            {item.approval.blockedBy}
          </p>
        )}
      {reviewing && (
        <p className="mb-4 flex items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden /> Reviewing
          this version — quality warnings will appear in a moment.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          {/* The generated content */}
          <Card>
            <CardContent className="space-y-4 p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-foreground">
                  Content
                </h2>
                {editing && (
                  <span className="text-xs text-muted-foreground">
                    Editing — saved edits are re-checked
                  </span>
                )}
              </div>
              {restored && (
                <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                  Your unsaved edits were restored. Save them, or discard to go
                  back to the stored version.
                </p>
              )}
              <dl className="space-y-3" aria-label="Generated content">
                {item.fields.map((f) =>
                  editing ? (
                    <div key={f.key} className="space-y-1">
                      <label
                        htmlFor={`f-${f.key}`}
                        className="text-xs font-medium text-muted-foreground"
                      >
                        {f.label}
                        {f.list ? ' (separate with spaces)' : ''}
                      </label>
                      {f.multiline ? (
                        <Textarea
                          id={`f-${f.key}`}
                          rows={Math.min(
                            10,
                            Math.max(
                              3,
                              Math.ceil(value(f.key, f.value).length / 70),
                            ),
                          )}
                          value={value(f.key, f.value)}
                          onChange={(e) =>
                            setEdits((p) => ({ ...p, [f.key]: e.target.value }))
                          }
                        />
                      ) : (
                        <Input
                          id={`f-${f.key}`}
                          value={value(f.key, f.value)}
                          onChange={(e) =>
                            setEdits((p) => ({ ...p, [f.key]: e.target.value }))
                          }
                        />
                      )}
                      {f.maxLength && (
                        <p
                          className={cn(
                            'text-right text-[11px]',
                            value(f.key, f.value).length > f.maxLength
                              ? 'text-destructive'
                              : 'text-muted-foreground',
                          )}
                        >
                          {value(f.key, f.value).length}/{f.maxLength}
                        </p>
                      )}
                    </div>
                  ) : (
                    <Row key={f.key} label={f.label}>
                      <span className="whitespace-pre-wrap">
                        {f.list && f.value
                          ? f.value
                              .split(' ')
                              .map((t) => `#${t}`)
                              .join(' ')
                          : f.value || '—'}
                      </span>
                    </Row>
                  ),
                )}
              </dl>
            </CardContent>
          </Card>

          {/* The associated image */}
          {item.asset && (
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    <ImageIcon className="h-4 w-4 text-primary" aria-hidden />{' '}
                    Image
                  </h2>
                  {item.asset.manageHref && item.asset.need !== 'none' && (
                    <Link
                      href={item.asset.manageHref}
                      className="text-xs text-primary hover:underline"
                    >
                      {item.asset.images.length
                        ? 'Change the image'
                        : 'Add an image'}
                    </Link>
                  )}
                </div>
                {item.asset.images.length > 0 ? (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {item.asset.images.map((img) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={img.url}
                        src={img.url}
                        alt={img.alt || 'Attached image'}
                        className="aspect-square w-full rounded-md border object-cover"
                      />
                    ))}
                  </div>
                ) : null}
                {item.asset.note && (
                  <p
                    className={cn(
                      'text-sm',
                      item.asset.need === 'required'
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-muted-foreground',
                    )}
                  >
                    {item.asset.note}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Quality warnings */}
          <Card data-testid="review-flags">
            <CardContent className="space-y-3 p-4">
              <h2 className="text-sm font-semibold text-foreground">
                Quality warnings{' '}
                <span className="font-normal text-muted-foreground">
                  {item.flags.length === 0
                    ? '— none'
                    : `— ${[blocks.length && `${blocks.length} must fix`, checks.length && `${checks.length} to check`, notes.length && `${notes.length} notes`].filter(Boolean).join(', ')}`}
                </span>
              </h2>
              {item.flags.length > 0 && (
                <ul className="space-y-2">
                  {[...blocks, ...checks, ...notes].map((f, i) => (
                    <FlagRow key={i} f={f} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Reviewer feedback */}
          <Card>
            <CardContent className="space-y-3 p-4">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <ClipboardCheck className="h-4 w-4 text-primary" aria-hidden />{' '}
                Reviewer feedback
              </h2>
              {!item.reviewer ? (
                <p className="text-sm text-muted-foreground">
                  {item.kind === 'outreach'
                    ? 'Outreach is checked against LinkedIn’s limits and your compliance rules (above); it has no AI review.'
                    : 'Not reviewed yet.'}
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    <Badge variant={VERDICT[item.reviewer.status].variant}>
                      {VERDICT[item.reviewer.status].label}
                    </Badge>{' '}
                    {/* Without the AI reviewer the score is the rules' alone — not a quality score. */}
                    {item.reviewer.ran && item.reviewer.score !== null && (
                      <>Score {item.reviewer.score}/100. </>
                    )}
                    {!item.reviewer.current &&
                      'Out of date — this version has not been reviewed yet. '}
                    {!item.reviewer.ran &&
                      item.reviewer.unavailable &&
                      `The AI reviewer did not run (${item.reviewer.unavailable}).`}
                  </p>
                  {item.reviewer.summary && (
                    <p className="rounded-md bg-muted/50 p-2 text-sm text-foreground">
                      {item.reviewer.summary}
                    </p>
                  )}
                  {item.reviewer.issues.length > 0 && (
                    <ul className="space-y-1.5 text-sm">
                      {item.reviewer.issues.map((i, n) => (
                        <li key={n}>
                          <span
                            className={cn(
                              'font-medium',
                              i.severity === 'blocker'
                                ? 'text-destructive'
                                : i.severity === 'major'
                                  ? 'text-amber-600'
                                  : 'text-muted-foreground',
                            )}
                          >
                            {i.area}:
                          </span>{' '}
                          {i.message}
                          {i.suggestion && (
                            <span className="block text-xs text-muted-foreground">
                              Suggestion: {i.suggestion}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* What it was made for */}
        <aside className="min-w-0 space-y-5">
          <Card data-testid="review-context">
            <CardContent className="space-y-3 p-4">
              <h2 className="text-sm font-semibold text-foreground">
                What it’s for
              </h2>
              <dl className="space-y-3">
                {ctx.recommendation && (
                  <Row label="Recommendation">
                    {ctx.recommendation.href ? (
                      <Link
                        href={ctx.recommendation.href}
                        className="text-primary hover:underline"
                      >
                        {ctx.recommendation.title}
                      </Link>
                    ) : (
                      ctx.recommendation.title
                    )}
                    {ctx.recommendation.why && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {ctx.recommendation.why}
                      </span>
                    )}
                  </Row>
                )}
                <Row label="Goal">
                  {ctx.goal ?? (
                    <span className="text-muted-foreground">Not set</span>
                  )}
                </Row>
                <Row label="Audience">
                  {ctx.audience ?? (
                    <span className="text-muted-foreground">Not set</span>
                  )}
                </Row>
                <Row label="Channel">{ctx.channel ?? '—'}</Row>
                {ctx.keyMessage && (
                  <Row label="Key message">{ctx.keyMessage}</Row>
                )}
                {ctx.source && <Row label="Brief">{ctx.source}</Row>}
                {ctx.extra.map((e) => (
                  <Row key={e.label} label={e.label}>
                    {e.value}
                  </Row>
                ))}
                {item.scheduledFor && (
                  <Row label="Scheduled">
                    <time dateTime={item.scheduledFor} suppressHydrationWarning>
                      {new Date(item.scheduledFor).toLocaleString()}
                    </time>
                  </Row>
                )}
              </dl>
              {ctx.evidence.length > 0 && (
                <div className="space-y-1.5 border-t pt-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Evidence
                  </p>
                  <ul className="space-y-1.5 text-sm">
                    {ctx.evidence.slice(0, 6).map((e, i) => (
                      <li key={i} className="min-w-0 break-words">
                        {e.url ? (
                          <a
                            href={e.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline"
                          >
                            {e.label}
                          </a>
                        ) : (
                          e.label
                        )}
                        {e.detail && (
                          <span className="block text-xs text-muted-foreground">
                            {e.detail}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>

      {/* The actions — the same for every kind of work */}
      <div
        className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:left-64"
        data-testid="review-actions"
      >
        <div className="mx-auto max-w-6xl space-y-2 px-4 py-3">
          {panel === 'regenerate' && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">Regenerate</p>
              {isDirty && (
                <p className="text-xs text-destructive">
                  Save or discard your edits first — regenerating replaces the
                  text.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => regenerate('fresh')}
                  loading={busy === 'regenerate'}
                  disabled={busy !== null || isDirty}
                >
                  <RefreshCw className="h-4 w-4" /> A fresh take
                </Button>
                {item.regenerate.fixReview && (
                  <Button
                    size="sm"
                    onClick={() => regenerate('fix_review')}
                    loading={busy === 'regenerate'}
                    disabled={busy !== null || isDirty}
                  >
                    <Sparkles className="h-4 w-4" /> Fix what the review found
                  </Button>
                )}
              </div>
              {item.regenerate.instructions && (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    aria-label="Instructions"
                    placeholder="Or tell Aura what to change (e.g. warmer, mention Friday)"
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => regenerate('instructions')}
                    disabled={busy !== null || isDirty || !instructions.trim()}
                  >
                    Regenerate with this
                  </Button>
                </div>
              )}
            </div>
          )}
          {panel === 'reject' && (
            <div className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row">
              <Input
                aria-label="Reason"
                placeholder="Why? (optional — helps the next version)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button
                size="sm"
                variant="destructive"
                onClick={reject}
                loading={busy === 'reject'}
                disabled={busy !== null}
              >
                Reject
              </Button>
            </div>
          )}
          {panel === 'schedule' && (
            <div className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center">
              <Input
                aria-label="When"
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
              <Button
                size="sm"
                onClick={schedule}
                loading={busy === 'schedule'}
                disabled={busy !== null || !when}
              >
                Schedule
              </Button>
            </div>
          )}
          {item.approval.needsConfirmation && a.approve.available && (
            <label className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>{item.approval.confirmLabel}</span>
            </label>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href={item.backHref}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Link>
            </Button>
            {editing ? (
              <>
                <Button
                  size="sm"
                  onClick={save}
                  loading={busy === 'save'}
                  disabled={busy !== null || !a.save.available}
                >
                  <Save className="h-4 w-4" /> Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={discard}
                  disabled={busy !== null}
                >
                  <X className="h-4 w-4" />{' '}
                  {isDirty ? 'Discard edits' : 'Cancel'}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing(true)}
                disabled={!a.edit.available}
                title={a.edit.reason ?? undefined}
              >
                <Pencil className="h-4 w-4" /> Edit
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setPanel(panel === 'regenerate' ? null : 'regenerate')
              }
              disabled={!a.regenerate.available}
              title={a.regenerate.reason ?? undefined}
            >
              <Sparkles className="h-4 w-4" /> Regenerate
            </Button>
            <span className="hidden flex-1 sm:block" />
            {a.submit.available && !a.approve.available && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => simple('submit')}
                loading={busy === 'submit'}
                disabled={busy !== null || isDirty}
              >
                <Send className="h-4 w-4" /> Submit for approval
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPanel(panel === 'reject' ? null : 'reject')}
              disabled={!a.reject.available}
              title={a.reject.reason ?? undefined}
            >
              <X className="h-4 w-4" /> Reject
            </Button>
            {a.schedule.available && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setPanel(panel === 'schedule' ? null : 'schedule')
                }
              >
                <CalendarClock className="h-4 w-4" /> Schedule
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => simple('approve', { confirmed })}
              loading={busy === 'approve'}
              disabled={
                busy !== null ||
                !a.approve.available ||
                isDirty ||
                (item.approval.needsConfirmation && !confirmed)
              }
              title={approveBlocked ?? undefined}
            >
              <Check className="h-4 w-4" /> Approve
            </Button>
          </div>
          {(approveBlocked ||
            (!a.schedule.available && item.state === 'approved')) && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="action-note"
            >
              {approveBlocked &&
              item.state !== 'approved' &&
              item.state !== 'done'
                ? `Approve: ${approveBlocked}`
                : !a.schedule.available && item.state === 'approved'
                  ? a.schedule.reason
                  : null}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
