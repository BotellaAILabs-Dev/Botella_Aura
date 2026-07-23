'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import type { ContentTypeKey } from '@/lib/validations/content';

type Status = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'PUBLISHED';

interface Props {
  draftId: string;
  type: ContentTypeKey;
  status: Status;
  bodyJson: string;
  manualText: string;
  publishedUrl: string | null;
  canPublish: boolean;
}

export function DraftActions({
  draftId,
  type,
  status,
  bodyJson,
  manualText,
  publishedUrl,
  canPublish,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [json, setJson] = useState(bodyJson);
  const [refineOpen, setRefineOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduledFor, setScheduledFor] = useState('');

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
      { action, reason },
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
        body: JSON.stringify({ body: parsed }),
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
      { feedback: feedback.trim() },
      'refine',
    );
    if (res) {
      toast.success('Regenerated with your feedback.');
      setRefineOpen(false);
      setFeedback('');
      router.refresh();
    }
  }

  async function regenerate() {
    const res = await call(`/api/content/drafts/${draftId}/refine`, { feedback: 'Give a noticeably fresh take.' }, 'regen');
    if (res) {
      toast.success('Fresh draft generated.');
      router.refresh();
    }
  }

  async function publish() {
    const res = await call(`/api/content/drafts/${draftId}/publish`, undefined, 'publish');
    if (!res) return;
    const result = (await res.json()) as
      | { mode: 'published'; url: string | null }
      | { mode: 'manual'; text: string; reason: string }
      | { mode: 'reconnect'; message: string };

    if (result.mode === 'published') {
      toast.success('Published to LinkedIn.');
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
    const res = await call(
      `/api/content/drafts/${draftId}/schedule`,
      { scheduledFor: new Date(scheduledFor).toISOString() },
      'schedule',
    );
    if (res) {
      toast.success('Scheduled.');
      setScheduleOpen(false);
      router.refresh();
    }
  }

  async function copyManual() {
    await navigator.clipboard.writeText(manualText).catch(() => undefined);
    toast.success('Copied — paste it into LinkedIn / X.');
  }

  const loading = (k: string) => busy === k;

  return (
    <div className="space-y-4">
      {/* Primary status actions */}
      <div className="flex flex-wrap gap-2">
        {status === 'DRAFT' && (
          <Button onClick={() => transition('submit')} loading={loading('submit')}>
            <Send className="h-4 w-4" /> Submit for approval
          </Button>
        )}
        {status === 'PENDING_APPROVAL' && (
          <>
            <Button onClick={() => transition('approve')} loading={loading('approve')}>
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
            <Button variant="outline" onClick={() => setScheduleOpen((v) => !v)}>
              <CalendarClock className="h-4 w-4" /> Schedule
            </Button>
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
            <Label htmlFor="sched">Publish at</Label>
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

      {/* Iterate: refine / regenerate / edit / copy */}
      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        {status !== 'PUBLISHED' && (
          <>
            <Button variant="outline" size="sm" onClick={() => setRefineOpen((v) => !v)}>
              <Sparkles className="h-4 w-4" /> Refine
            </Button>
            <Button variant="outline" size="sm" onClick={regenerate} loading={loading('regen')}>
              <RotateCcw className="h-4 w-4" /> Regenerate
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
              <Pencil className="h-4 w-4" /> {editing ? 'Cancel edit' : 'Edit'}
            </Button>
          </>
        )}
        <Button variant="ghost" size="sm" onClick={copyManual}>
          <Copy className="h-4 w-4" /> Copy for manual posting
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
