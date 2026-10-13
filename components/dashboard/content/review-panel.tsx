'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  CircleDashed,
  ClipboardCheck,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from '@/components/ui/toaster';
import {
  DIMENSION_INFO,
  REVIEW_STATUS_LABEL,
  REVIEW_THRESHOLDS,
  type ContentReview,
  type DimensionVerdict,
  type ReviewIssue,
} from '@/lib/content-review';

/**
 * The AI Reviewer's result for a draft (lib/content-review.ts): a structured
 * evaluation on ten dimensions, what failed, and what a person must look at.
 * The review never edits the piece — "Regenerate with review feedback" is a
 * separate step the person chooses.
 */

const STATUS_VARIANT = {
  pass: 'success',
  review_required: 'warning',
  fail: 'destructive',
} as const;

const VERDICT: Record<
  DimensionVerdict,
  { label: string; icon: typeof CheckCircle2; className: string; bar: string }
> = {
  pass: {
    label: 'Pass',
    icon: CheckCircle2,
    className: 'text-primary',
    bar: 'bg-primary',
  },
  review: {
    label: 'Review',
    icon: TriangleAlert,
    className: 'text-amber-600',
    bar: 'bg-amber-500',
  },
  fail: {
    label: 'Fail',
    icon: XCircle,
    className: 'text-destructive',
    bar: 'bg-destructive',
  },
  not_assessed: {
    label: 'Not assessed',
    icon: CircleDashed,
    className: 'text-muted-foreground',
    bar: 'bg-muted-foreground/40',
  },
};

const SOURCE_LABEL: Record<ReviewIssue['source'], string> = {
  reviewer: 'reviewer',
  rules: 'rules',
  fact_check: 'fact check',
};

const SEVERITY_CLASS: Record<ReviewIssue['severity'], string> = {
  blocker: 'text-destructive',
  major: 'text-amber-600',
  minor: 'text-muted-foreground',
};

export function ReviewPanel({
  draftId,
  review,
  current,
  canEdit,
  editable,
}: {
  draftId: string;
  review: ContentReview | null;
  /** The review describes the body as it stands. */
  current: boolean;
  /** The person may run a review and regenerate. */
  canEdit: boolean;
  /** The draft can still change (not published). */
  editable: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'review' | 'fix' | null>(null);

  async function post(kind: 'review' | 'fix') {
    setBusy(kind);
    try {
      const res = await fetch(
        kind === 'review'
          ? `/api/content/drafts/${draftId}/review`
          : `/api/content/drafts/${draftId}/refine`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body:
            kind === 'fix'
              ? JSON.stringify({ action: 'fix_review' })
              : undefined,
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Something went wrong.');
        return;
      }
      toast.success(
        kind === 'review' ? 'Reviewed.' : 'Regenerated and reviewed again.',
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const actions = canEdit && editable && (
    <div className="flex flex-wrap gap-2 pt-1">
      {review &&
        review.status !== 'pass' &&
        review.issues.length > 0 &&
        current && (
          <Button
            size="sm"
            onClick={() => post('fix')}
            loading={busy === 'fix'}
            disabled={busy !== null}
          >
            <Sparkles className="h-3.5 w-3.5" /> Regenerate with review feedback
          </Button>
        )}
      <Button
        size="sm"
        variant="outline"
        onClick={() => post('review')}
        loading={busy === 'review'}
        disabled={busy !== null}
      >
        <RefreshCw className="h-3.5 w-3.5" />{' '}
        {review ? 'Review again' : 'Run review'}
      </Button>
    </div>
  );

  if (!review) {
    return (
      <Card>
        <CardContent className="space-y-2 p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-primary" aria-hidden />
            <span className="font-medium text-foreground">Review</span>
            <Badge variant="muted">Not reviewed yet</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Every piece is reviewed before it enters approval. It runs on
            submit, or now.
          </p>
          {actions}
        </CardContent>
      </Card>
    );
  }

  const failedLabels = review.failed.map((d) => DIMENSION_INFO[d].label);

  return (
    <Card
      data-testid="review-panel"
      data-review-status={review.status}
      className={
        review.status === 'fail'
          ? 'border-destructive/40'
          : review.status === 'review_required'
            ? 'border-amber-300/60'
            : ''
      }
    >
      <CardContent className="space-y-3 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-primary" aria-hidden />
          <span className="font-medium text-foreground">Review</span>
          <Badge variant={STATUS_VARIANT[review.status]}>
            {REVIEW_STATUS_LABEL[review.status]}
          </Badge>
          {review.score !== null && (
            <span className="text-xs text-muted-foreground">
              Score {review.score}/100 · pass at {REVIEW_THRESHOLDS.overallPass}
            </span>
          )}
          {!current && (
            <Badge variant="muted">Out of date — the piece changed</Badge>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {review.status === 'pass'
            ? 'An independent review found it ready for approval.'
            : review.status === 'fail'
              ? `It does not meet the quality bar${failedLabels.length ? ` on ${failedLabels.join(', ')}` : ''}. Fix it or regenerate before it goes for approval.`
              : 'A person must look at the points below before this is approved.'}{' '}
          {review.reviewer.ran
            ? 'Reviewed separately from the writer; the review never changes the piece.'
            : `The independent reviewer did not run${review.reviewer.unavailable ? ` (${review.reviewer.unavailable})` : ''} — rules and fact check only.`}
        </p>

        {review.summary && (
          <p className="rounded-md bg-muted/50 p-2 text-xs text-foreground">
            {review.summary}
          </p>
        )}

        {review.status !== 'pass' && review.humanReviewReasons.length > 0 && (
          <ul className="space-y-1 text-xs" aria-label="Why it needs a person">
            {review.humanReviewReasons.map((r) => (
              <li
                key={r}
                className="flex gap-1.5 text-amber-700 dark:text-amber-300"
              >
                <ShieldAlert
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  aria-hidden
                />
                <span className="min-w-0">{r}</span>
              </li>
            ))}
          </ul>
        )}

        <ul
          className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2"
          aria-label="Review dimensions"
        >
          {review.dimensions.map((d) => {
            const v = VERDICT[d.verdict];
            const Icon = v.icon;
            return (
              <li
                key={d.dimension}
                className="min-w-0 text-xs"
                title={d.summary}
              >
                <div className="flex items-center gap-1.5">
                  <Icon
                    className={`h-3.5 w-3.5 shrink-0 ${v.className}`}
                    aria-hidden
                  />
                  <span className="font-medium text-foreground">{d.label}</span>
                  <span className={`ml-auto shrink-0 ${v.className}`}>
                    {v.label}
                    {d.score !== null ? ` · ${d.score}` : ''}
                  </span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded bg-muted">
                  <div
                    className={`h-full ${v.bar}`}
                    style={{ width: `${d.score ?? 0}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>

        {review.issues.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">
              {review.issues.length} issue
              {review.issues.length === 1 ? '' : 's'}
            </p>
            <ul className="space-y-1.5">
              {review.issues.slice(0, 12).map((i, n) => (
                <li key={n} className="text-xs">
                  <span className={`font-medium ${SEVERITY_CLASS[i.severity]}`}>
                    {i.severity === 'blocker'
                      ? 'Must fix'
                      : i.severity === 'major'
                        ? 'Check'
                        : 'Minor'}{' '}
                    · {DIMENSION_INFO[i.dimension].label}
                  </span>{' '}
                  <span className="text-foreground">{i.message}</span>
                  {i.quote && (
                    <span className="text-muted-foreground">
                      {' '}
                      — “{i.quote}”
                    </span>
                  )}
                  {i.suggestion && (
                    <span className="block text-muted-foreground">
                      Suggestion: {i.suggestion}
                    </span>
                  )}
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                    {' '}
                    {SOURCE_LABEL[i.source]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Reviewed{' '}
          {/* Local time: the server's locale and zone differ from the browser's. */}
          <time dateTime={review.reviewedAt} suppressHydrationWarning>
            {new Date(review.reviewedAt).toLocaleString()}
          </time>
          {review.acknowledgedBy ? ' · checked by the approver' : ''}
        </p>
        {actions}
      </CardContent>
    </Card>
  );
}
