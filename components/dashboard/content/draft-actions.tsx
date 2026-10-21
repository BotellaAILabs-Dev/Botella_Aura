'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatInZone } from '@/lib/timezone';
import {
  Send,
  Check,
  X,
  RotateCcw,
  Sparkles,
  Pencil,
  Copy,
  CalendarClock,
  Upload,
  ExternalLink,
  Minimize2,
  Maximize2,
  Wand2,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import {
  CONTENT_TONES,
  type ContentTone,
  type ContentTypeKey,
} from '@/lib/validations/content';
import { TONE_LABEL } from '@/components/dashboard/content/generation-options';

type Status = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'PUBLISHED';

interface Props {
  /** The draft's updatedAt (ISO) — sent with an edit so a changed draft is not overwritten. */
  updatedAt?: string;
  draftId: string;
  type: ContentTypeKey;
  status: Status;
  bodyJson: string;
  manualText: string;
  publishedUrl: string | null;
  canPublish: boolean;
  /** There is a previous version to go back to. */
  canUndo?: boolean;
  /** Email / ad copy: copied out, never scheduled or published. */
  copyOnly?: boolean;
  /**
   * The fact check (lib/fact-check.ts): a contradiction blocks approval;
   * claims it could not verify need the approver to confirm they checked them.
   */
  factCheck?: { status: string; toReview: number; mustFix: number } | null;
  /**
   * The AI Reviewer, when its review is of the body as it stands: a failed
   * review blocks submitting; one that needs a person needs the approver to
   * confirm they looked.
   */
  review?: { status: 'pass' | 'review_required' | 'fail'; reasons: number } | null;
  /** The workspace timezone: the time picked is in it, whoever is picking. */
  timeZone?: string;
}

export function DraftActions({
  draftId,
  type,
  status,
  bodyJson,
  manualText,
  publishedUrl,
  canPublish,
  canUndo = false,
  copyOnly = false,
  factCheck = null,
  review = null,
  updatedAt,
  timeZone = 'UTC',
}: Props) {
  const [factsReviewed, setFactsReviewed] = useState(false);
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  const reviewFailed = review?.status === 'fail';
  const reviewNeedsHuman = review?.status === 'review_required';
  // Claims a person cannot vouch for (contradictions, unsupported figures
  // and absolutes) block approval; the rest need the approver to confirm.
  const contradicted = (factCheck?.mustFix ?? 0) > 0;
  const needsReview = !contradicted && factCheck?.status === 'needs_review';
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [json, setJson] = useState(bodyJson);
  const [refineOpen, setRefineOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduledFor, setScheduledFor] = useState('');
  const [tone, setTone] = useState<ContentTone>('friendly');

  async function call(
    url: string,
    body?: unknown,
    label = 'action',
  ): Promise<Response | null> {
    setBusy(label);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Something went wrong.');
        return null;
      }
      return res;
    } finally {
      setBusy(null);
    }
  }

  async function transition(action: string, reason?: string) {
    const res = await call(
      `/api/content/drafts/${draftId}/status`,
      {
        action,
        reason,
        ...(action === 'approve' && needsReview ? { factsReviewed } : {}),
        ...(action === 'approve' && reviewNeedsHuman ? { reviewAcknowledged } : {}),
      },
      action,
    );
    if (res) {
      toast.success('Updated.');
      router.refresh();
    }
  }

  async function saveEdit() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      toast.error('That is not valid JSON.');
      return;
    }
    setBusy('edit');
    try {
      const res = await fetch(`/api/content/drafts/${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: parsed, ...(updatedAt ? { baseUpdatedAt: updatedAt } : {}) }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not save (does it match the content shape?).');
        return;
      }
      toast.success('Saved. Back to Draft — re-approve to publish.');
      setEditing(false);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function refine() {
    if (feedback.trim().length < 3) {
      toast.error('Add a note on what to change.');
      return;
    }
    const res = await call(
      `/api/content/drafts/${draftId}/refine`,
      { action: 'custom', feedback: feedback.trim() },
      'refine',
    );
    if (res) {
      toast.success('Regenerated with your feedback.');
      setRefineOpen(false);
      setFeedback('');
      router.refresh();
    }
  }

  /** One-click AI rewrites. Each keeps the previous version for Undo. */
  async function rewrite(
    action: 'regenerate' | 'shorten' | 'expand' | 'improve' | 'tone',
    done: string,
  ) {
    const res = await call(
      `/api/content/drafts/${draftId}/refine`,
      action === 'tone' ? { action, tone } : { action },
      action,
    );
    if (res) {
      toast.success(done);
      router.refresh();
    }
  }

  async function undo() {
    const res = await call(`/api/content/drafts/${draftId}/undo`, undefined, 'undo');
    if (res) {
      toast.success('Restored the previous version.');
      router.refresh();
    }
  }

  async function publish() {
    const res = await call(`/api/content/drafts/${draftId}/publish`, undefined, 'publish');
    if (!res) return;
    const result = (await res.json()) as
      | { mode: 'published'; url: string | null }
      | { mode: 'manual'; text: string; reason: string }
      | { mode: 'reconnect'; message: string }
      | { mode: 'processing'; message: string };

    if (result.mode === 'published') {
      toast.success('Published to LinkedIn.');
      router.refresh();
    } else if (result.mode === 'processing') {
      toast(result.message, { duration: 8000 });
      router.refresh();
    } else if (result.mode === 'reconnect') {
      toast.error(result.message);
    } else {
      await navigator.clipboard.writeText(result.text).catch(() => undefined);
      toast(`${result.reason} — copied to clipboard.`, { duration: 8000 });
    }
  }

  async function schedule() {
    if (!scheduledFor) return;
    // A wall time in the workspace's timezone — converted on the server, so
    // it means the same whichever timezone this browser is in.
    const res = await call(`/api/content/drafts/${draftId}/schedule`, { localTime: scheduledFor, timeZone }, 'schedule');
    if (res) {
      const body = (await res.clone().json().catch(() => ({}))) as { scheduledFor?: string; note?: string | null };
      toast.success(
        `Scheduled for ${body.scheduledFor ? formatInZone(body.scheduledFor, timeZone) : scheduledFor}.${body.note ? ` ${body.note}` : ''}`,
        { duration: 8000 },
      );
      setScheduleOpen(false);
      router.refresh();
    }
  }

  async function copyManual() {
    await navigator.clipboard.writeText(manualText).catch(() => undefined);
    toast.success(
      type === 'EMAIL'
        ? 'Copied — paste it into your email tool.'
        : type === 'AD'
          ? 'Copied — paste it into your ad manager.'
          : type === 'CAMPAIGN_COPY'
            ? 'Copied — use it across your campaign’s channels.'
            : type === 'PROMO'
              ? 'Copied — paste it into your site, newsletter or post.'
              : 'Copied — paste it into LinkedIn / X.',
    );
  }

  const loading = (k: string) => busy === k;

  return (
    <div className="space-y-4">
      {/* Primary status actions */}
      <div className="flex flex-wrap gap-2">
        {status === 'DRAFT' && (
          <>
            {reviewFailed && (
              <p className="w-full text-xs text-destructive">
                The review failed — fix the piece or regenerate it with the review’s feedback (see
                Review) before submitting.
              </p>
            )}
            <Button
              onClick={() => transition('submit')}
              loading={loading('submit')}
              disabled={reviewFailed}
            >
              <Send className="h-4 w-4" /> Submit for approval
            </Button>
          </>
        )}
        {status === 'PENDING_APPROVAL' && (
          <>
            {needsReview && (
              <label className="flex w-full items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={factsReviewed}
                  onChange={(e) => setFactsReviewed(e.target.checked)}
                />
                <span>
                  I’ve checked the {factCheck!.toReview} claim
                  {factCheck!.toReview === 1 ? '' : 's'} Aura could not verify (see Fact check) and
                  they are true.
                </span>
              </label>
            )}
            {reviewNeedsHuman && (
              <label className="flex w-full items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={reviewAcknowledged}
                  onChange={(e) => setReviewAcknowledged(e.target.checked)}
                />
                <span>
                  I’ve looked at what the review marked for human review (see Review) and this is
                  fine to approve.
                </span>
              </label>
            )}
            {reviewFailed && (
              <p className="w-full text-xs text-destructive">
                The review failed — request changes, or fix it, before approving.
              </p>
            )}
            {contradicted && (
              <p className="w-full text-xs text-destructive">
                {factCheck?.status === 'contradicted'
                  ? 'A claim contradicts what Aura knows — fix it (see Fact check) before approving.'
                  : 'A figure or claim nothing supports must be fixed (see Fact check) before approving.'}
              </p>
            )}
            <Button
              onClick={() => transition('approve')}
              loading={loading('approve')}
              disabled={
                contradicted ||
                reviewFailed ||
                (needsReview && !factsReviewed) ||
                (reviewNeedsHuman && !reviewAcknowledged)
              }
            >
              <Check className="h-4 w-4" /> Approve
            </Button>
            <Button
              variant="outline"
              onClick={() => transition('request_changes')}
              loading={loading('request_changes')}
            >
              <RotateCcw className="h-4 w-4" /> Request changes
            </Button>
          </>
        )}
        {status === 'APPROVED' && (
          <>
            {canPublish && (
              <Button onClick={publish} loading={loading('publish')}>
                <Upload className="h-4 w-4" /> Publish
              </Button>
            )}
            {!copyOnly && (
              <Button variant="outline" onClick={() => setScheduleOpen((v) => !v)}>
                <CalendarClock className="h-4 w-4" /> Schedule
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => transition('request_changes')}
              loading={loading('request_changes')}
            >
              <RotateCcw className="h-4 w-4" /> Request changes
            </Button>
          </>
        )}
        {status === 'REJECTED' && (
          <Button
            variant="outline"
            onClick={() => transition('request_changes')}
            loading={loading('request_changes')}
          >
            <RotateCcw className="h-4 w-4" /> Reopen as draft
          </Button>
        )}
        {status === 'PUBLISHED' && publishedUrl && (
          <Button asChild variant="outline">
            <a href={publishedUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" /> View published post
            </a>
          </Button>
        )}

        {/* Reject is available from Draft/Pending */}
        {(status === 'DRAFT' || status === 'PENDING_APPROVAL') && (
          <Button
            variant="ghost"
            className="text-destructive"
            onClick={() => transition('reject')}
            loading={loading('reject')}
          >
            <X className="h-4 w-4" /> Reject
          </Button>
        )}
      </div>

      {scheduleOpen && status === 'APPROVED' && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
          <div className="space-y-1">
            <Label htmlFor="sched">
              Publish at <span className="font-normal text-muted-foreground">({timeZone} time)</span>
            </Label>
            <input
              id="sched"
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            />
          </div>
          <Button onClick={schedule} loading={loading('schedule')}>
            Schedule publish
          </Button>
        </div>
      )}

      {/* Rewrite with AI: one click each, all undoable */}
      {status !== 'PUBLISHED' && (
        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Rewrite with AI
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => rewrite('regenerate', 'Fresh version written.')}
              loading={loading('regenerate')}
            >
              <RotateCcw className="h-4 w-4" /> Regenerate
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => rewrite('shorten', 'Shortened.')}
              loading={loading('shorten')}
            >
              <Minimize2 className="h-4 w-4" /> Shorten
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => rewrite('expand', 'Expanded.')}
              loading={loading('expand')}
            >
              <Maximize2 className="h-4 w-4" /> Expand
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => rewrite('improve', 'Improved.')}
              loading={loading('improve')}
            >
              <Wand2 className="h-4 w-4" /> Improve
            </Button>
            <div className="flex items-center gap-1">
              <label htmlFor="tone" className="sr-only">
                Tone
              </label>
              <select
                id="tone"
                value={tone}
                onChange={(e) => setTone(e.target.value as ContentTone)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                {CONTENT_TONES.map((t) => (
                  <option key={t} value={t}>
                    {TONE_LABEL[t]}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  rewrite('tone', `Rewritten in a ${TONE_LABEL[tone].toLowerCase()} tone.`)
                }
                loading={loading('tone')}
              >
                Change tone
              </Button>
            </div>
            {canUndo && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={undo}
                loading={loading('undo')}
              >
                <Undo2 className="h-4 w-4" /> Undo
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Your own changes: a note, a direct edit, or copy it out */}
      <div className="flex flex-wrap gap-2">
        {status !== 'PUBLISHED' && (
          <>
            <Button variant="outline" size="sm" onClick={() => setRefineOpen((v) => !v)}>
              <Sparkles className="h-4 w-4" /> Custom instruction
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
              <Pencil className="h-4 w-4" /> {editing ? 'Cancel edit' : 'Edit'}
            </Button>
          </>
        )}
        <Button variant="ghost" size="sm" onClick={copyManual}>
          <Copy className="h-4 w-4" />{' '}
          {type === 'EMAIL'
            ? 'Copy email'
            : type === 'AD'
              ? 'Copy ad'
              : type === 'CAMPAIGN_COPY'
                ? 'Copy campaign copy'
                : type === 'PROMO'
                  ? 'Copy promotion'
                  : 'Copy for manual posting'}
        </Button>
      </div>

      {refineOpen && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <Label htmlFor="feedback">What should change?</Label>
          <Textarea
            id="feedback"
            rows={3}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="e.g. Make it punchier, drop the third paragraph, add a stat"
          />
          <Button size="sm" onClick={refine} loading={loading('refine')}>
            <Sparkles className="h-4 w-4" /> Apply feedback
          </Button>
        </div>
      )}

      {editing && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <Label htmlFor="json">Structured content (JSON)</Label>
          <Textarea
            id="json"
            rows={14}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            Edits are validated against the {type} content shape. Saving returns
            the draft to Draft status for re-approval.
          </p>
          <Button size="sm" onClick={saveEdit} loading={loading('edit')}>
            Save edits
          </Button>
        </div>
      )}
    </div>
  );
}
