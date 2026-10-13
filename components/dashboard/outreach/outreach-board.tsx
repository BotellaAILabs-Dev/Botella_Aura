'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ClipboardCheck } from 'lucide-react';
import {
  Sparkles,
  Pencil,
  Trash2,
  ExternalLink,
  Linkedin,
  Send,
  Check,
  X,
  CornerUpLeft,
} from 'lucide-react';
import { toast } from '@/components/ui/toaster';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  OUTREACH_STATUS_LABELS,
  OUTREACH_TYPE_LABELS,
  OUTREACH_STEPS,
  SIGNAL_LABELS,
  outreachStatusVariant,
  outreachStepState,
  type OutreachStatusKey,
} from '@/lib/outreach-ui';
import { cn } from '@/lib/utils';
import { classifyLinkedInUrl } from '@/lib/linkedin-url';

export interface OutreachMessageRow {
  id: string;
  type: string;
  status: OutreachStatusKey;
  draftText: string;
  connectionAccepted?: boolean;
  replyReceived?: boolean;
}
export interface OutreachSignalRow {
  id: string;
  signalType: string;
  description: string;
  sourceUrl: string | null;
}
export interface LeadRow {
  id: string;
  name: string | null;
  title: string | null;
  companyName: string;
  linkedInProfileUrl: string | null;
  sourceUrl: string | null;
  status: string;
  /** LeadSource — SIGNAL | DISCOVERY_ENGINE | MANUAL. */
  source: string;
  /** The requirement this lead was discovered for, e.g. "Distillery". */
  category: string | null;
  fitScore: number | null;
  fitRationale: string | null;
  signals: OutreachSignalRow[];
  messages: OutreachMessageRow[];
}

export interface LeadCategoryOption {
  category: string | null;
  label: string;
  count: number;
}

const UNCATEGORISED = '__none__';

const SOURCE_LABEL: Record<string, string> = {
  SIGNAL: 'Signal',
  DISCOVERY_ENGINE: 'Discovery',
  MANUAL: 'Manual',
};

/** Fit score badge variant by band (0–100). */
function fitVariant(score: number): 'success' | 'default' | 'warning' | 'muted' {
  if (score >= 75) return 'success';
  if (score >= 50) return 'default';
  if (score >= 25) return 'warning';
  return 'muted';
}

/**
 * Put the sequence in send order — connection note(s) first, then follow-ups —
 * and give each a human label ("Connection note", "Follow-up #1", …) so the
 * order and role of every message is explicit.
 */
function orderMessages(
  messages: OutreachMessageRow[],
): { message: OutreachMessageRow; sequenceLabel: string }[] {
  const connectionNotes = messages.filter((m) => m.type === 'CONNECTION_NOTE');
  const followups = messages.filter((m) => m.type === 'FOLLOWUP');
  const other = messages.filter(
    (m) => m.type !== 'CONNECTION_NOTE' && m.type !== 'FOLLOWUP',
  );
  return [
    ...connectionNotes.map((message) => ({
      message,
      sequenceLabel: OUTREACH_TYPE_LABELS.CONNECTION_NOTE ?? 'Connection note',
    })),
    ...followups.map((message, i) => ({
      message,
      sequenceLabel: `${OUTREACH_TYPE_LABELS.FOLLOWUP ?? 'Follow-up'} #${i + 1}`,
    })),
    ...other.map((message) => ({
      message,
      sequenceLabel: OUTREACH_TYPE_LABELS[message.type] ?? message.type,
    })),
  ];
}

/** Compact horizontal progression: Draft → Pending → Approved → Queued → Sent. */
function OutreachStepper({ status }: { status: OutreachStatusKey }) {
  const { reached, rejected } = outreachStepState(status);
  if (rejected) {
    return (
      <div className="mt-2 text-xs font-medium text-destructive">
        Rejected — reopen as a draft to revise.
      </div>
    );
  }
  return (
    <ol className="mt-2 flex flex-wrap items-center gap-1 text-[11px]">
      {OUTREACH_STEPS.map((label, i) => {
        const done = i <= reached;
        const current = i === reached;
        return (
          <li key={label} className="flex items-center gap-1">
            <span
              className={cn(
                'flex h-4 w-4 items-center justify-center rounded-full border text-[9px] font-semibold',
                done
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground',
              )}
            >
              {i + 1}
            </span>
            <span
              className={cn(
                current
                  ? 'font-semibold text-foreground'
                  : done
                    ? 'text-foreground'
                    : 'text-muted-foreground',
              )}
            >
              {label}
            </span>
            {i < OUTREACH_STEPS.length - 1 && (
              <span
                className={cn(
                  'mx-0.5 h-px w-3',
                  i < reached ? 'bg-primary' : 'bg-border',
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    toast.error(b.error ?? 'Something went wrong.');
    return false;
  }
  return true;
}

export function OutreachBoard({
  leads,
  categories,
  initialCategory = null,
  canManage,
}: {
  leads: LeadRow[];
  categories: LeadCategoryOption[];
  /** Pre-selected requirement, e.g. arriving from "Send to Outreach". */
  initialCategory?: string | null;
  canManage: boolean;
}) {
  const [category, setCategory] = useState<string>(initialCategory ?? 'ALL');
  const [status, setStatus] = useState<string>('ALL');

  const filtered = useMemo(
    () =>
      leads.filter(
        (l) =>
          (category === 'ALL' ||
            (category === UNCATEGORISED ? !l.category : l.category === category)) &&
          (status === 'ALL' || l.status === status),
      ),
    [leads, category, status],
  );

  const selectCls = 'rounded-md border border-input bg-background px-2 py-1';

  return (
    <div className="space-y-4">
      {/* Same requirement filter as the Leads page, so the two screens agree. */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {categories.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Requirement</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className={selectCls}
            >
              <option value="ALL">All requirements</option>
              {categories.map((c) => (
                <option
                  key={c.category ?? UNCATEGORISED}
                  value={c.category ?? UNCATEGORISED}
                >
                  {c.label} ({c.count})
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className={selectCls}
          >
            <option value="ALL">All</option>
            <option value="NEW">New</option>
            <option value="QUALIFIED">Qualified</option>
            <option value="DRAFTED">Drafted</option>
            <option value="CONTACTED">Contacted</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </div>
        <span className="text-muted-foreground">
          {filtered.length} of {leads.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          No leads match these filters. Every lead from the Leads page is on this
          board — widen the requirement or status filter to see them.
        </p>
      ) : (
        filtered.map((lead) => (
          <LeadCard key={lead.id} lead={lead} canManage={canManage} />
        ))
      )}
    </div>
  );
}

function LeadCard({ lead, canManage }: { lead: LeadRow; canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function draft() {
    setBusy(true);
    try {
      if (await call(`/api/outreach/leads/${lead.id}/draft`, 'POST'))
        toast.success('Draft ready — review below.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!confirm(`Remove ${lead.companyName}?`)) return;
    if (await call(`/api/outreach/leads/${lead.id}`, 'DELETE')) router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {/* Company is always known; Contact is a separate, clearly-labeled line. */}
            <CardTitle className="text-base">{lead.companyName}</CardTitle>
            <div className="mt-1 grid gap-0.5 text-xs">
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">Contact:</span>{' '}
                {lead.name ? (
                  <>
                    {lead.name}
                    {lead.title ? ` · ${lead.title}` : ''}
                  </>
                ) : (
                  <span className="italic">Company-only lead — no contact yet</span>
                )}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">{lead.status}</Badge>
              {lead.category && (
                <Badge
                  variant="outline"
                  title="The requirement this lead was discovered for"
                >
                  {lead.category}
                </Badge>
              )}
              <Badge variant="muted">
                {SOURCE_LABEL[lead.source] ?? lead.source}
              </Badge>
              {typeof lead.fitScore === 'number' && (
                <Badge variant={fitVariant(lead.fitScore)} title="AI fit score (0–100)">
                  Fit {lead.fitScore}/100
                </Badge>
              )}
              {lead.linkedInProfileUrl && (
                <a
                  href={lead.linkedInProfileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-primary hover:underline"
                >
                  <Linkedin className="h-3.5 w-3.5" /> Profile
                </a>
              )}
            </div>
            {/* "Why this score?" — grounded in the lead's real signals/criteria. */}
            {typeof lead.fitScore === 'number' && lead.fitRationale && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Why {lead.fitScore}/100:</span>{' '}
                {lead.fitRationale}
              </p>
            )}
          </div>
          {canManage && (
            <div className="flex shrink-0 gap-1">
              <EditLeadDialog lead={lead} />
              <Button variant="ghost" size="icon" onClick={remove}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Signals */}
        {lead.signals.length > 0 && (
          <div className="space-y-1.5">
            {lead.signals.map((s) => (
              <div key={s.id} className="flex items-start gap-2 text-sm">
                <Badge variant="outline" className="shrink-0">
                  {SIGNAL_LABELS[s.signalType] ?? s.signalType}
                </Badge>
                <span className="text-muted-foreground">
                  {s.description}{' '}
                  {s.sourceUrl && (
                    <a
                      href={s.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center text-primary hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Messages / drafts — the outreach sequence, in send order:
            the connection note first, then follow-ups (only sent after the
            connection is accepted). */}
        {lead.messages.length === 0 ? (
          canManage && (
            <Button size="sm" onClick={draft} loading={busy}>
              <Sparkles className="h-4 w-4" /> Draft outreach
            </Button>
          )
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Sequence:</span> the
              connection note goes first — follow-ups are only sent once the
              connection is accepted.
            </p>
            {orderMessages(lead.messages).map(({ message, sequenceLabel }) => (
              <MessageBlock
                key={message.id}
                message={message}
                sequenceLabel={sequenceLabel}
                canManage={canManage}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MessageBlock({
  message,
  sequenceLabel,
  canManage,
}: {
  message: OutreachMessageRow;
  sequenceLabel: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(message.draftText);

  async function transition(action: string) {
    if (
      await call(`/api/outreach/messages/${message.id}/status`, 'POST', { action })
    ) {
      toast.success('Updated.');
      router.refresh();
    }
  }
  async function saveEdit() {
    if (
      await call(`/api/outreach/messages/${message.id}`, 'PATCH', { draftText: text })
    ) {
      toast.success('Saved — back to draft, re-approve to send.');
      setEditing(false);
      router.refresh();
    }
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-medium">{sequenceLabel}</span>
        <Badge variant={outreachStatusVariant(message.status)}>
          {message.status === 'APPROVED'
            ? 'Approved · queued'
            : OUTREACH_STATUS_LABELS[message.status]}
        </Badge>
      </div>

      {/* Visible progression so the send workflow is legible at a glance. */}
      <OutreachStepper status={message.status} />

      <div className="mt-2" />


      {editing ? (
        <div className="space-y-2">
          <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" onClick={saveEdit}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
          {message.draftText}
        </p>
      )}

      {canManage && !editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          {message.status !== 'SENT' && (
            <Button asChild size="sm" variant="outline">
              <Link href={`/dashboard/review/outreach/${message.id}`}>
                <ClipboardCheck className="h-4 w-4" /> Review
              </Link>
            </Button>
          )}
          {message.status === 'DRAFT' && (
            <>
              <Button size="sm" onClick={() => transition('submit')}>
                Submit for approval
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
            </>
          )}
          {message.status === 'PENDING_APPROVAL' && (
            <>
              <Button size="sm" onClick={() => transition('approve')}>
                <Check className="h-4 w-4" /> Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => transition('request_changes')}>
                <CornerUpLeft className="h-4 w-4" /> Changes
              </Button>
              <Button size="sm" variant="ghost" onClick={() => transition('reject')}>
                <X className="h-4 w-4" /> Reject
              </Button>
            </>
          )}
          {message.status === 'APPROVED' && (
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <Send className="h-4 w-4" /> In your extension queue — send it on the
              lead&apos;s profile.
            </span>
          )}
          {message.status === 'REJECTED' && (
            <Button size="sm" variant="outline" onClick={() => transition('request_changes')}>
              Reopen as draft
            </Button>
          )}
        </div>
      )}

      {/* Sprint 5 — manual "did it work" outcome (feeds what Aura learns) */}
      {canManage && message.status === 'SENT' && (
        <OutcomeToggles message={message} />
      )}
    </div>
  );
}

function OutcomeToggles({ message }: { message: OutreachMessageRow }) {
  const router = useRouter();
  const [accepted, setAccepted] = useState(!!message.connectionAccepted);
  const [replied, setReplied] = useState(!!message.replyReceived);

  async function update(patch: { connectionAccepted?: boolean; replyReceived?: boolean }) {
    const res = await fetch(`/api/outreach/messages/${message.id}/outcome`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      toast.error('Could not save outcome.');
      return;
    }
    router.refresh();
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-border pt-2 text-sm">
      <span className="text-xs text-muted-foreground">Did it work?</span>
      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => {
            setAccepted(e.target.checked);
            update({ connectionAccepted: e.target.checked });
          }}
          className="h-4 w-4 accent-[hsl(var(--primary))]"
        />
        Connection accepted
      </label>
      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={replied}
          onChange={(e) => {
            setReplied(e.target.checked);
            update({ replyReceived: e.target.checked });
          }}
          className="h-4 w-4 accent-[hsl(var(--primary))]"
        />
        Reply received
      </label>
    </div>
  );
}

function EditLeadDialog({ lead }: { lead: LeadRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(lead.name ?? '');
  const [title, setTitle] = useState(lead.title ?? '');
  const [url, setUrl] = useState(lead.linkedInProfileUrl ?? '');

  const urlInfo = url.trim() ? classifyLinkedInUrl(url) : null;

  async function save() {
    if (url.trim() && !classifyLinkedInUrl(url).valid) {
      toast.error('Enter a valid LinkedIn /in/ profile or /company/ page URL, or leave it blank.');
      return;
    }
    if (
      await call(`/api/outreach/leads/${lead.id}`, 'PATCH', {
        name,
        title,
        linkedInProfileUrl: url,
        status: 'QUALIFIED',
      })
    ) {
      toast.success('Lead updated.');
      setOpen(false);
      router.refresh();
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" title="Add person / LinkedIn">
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit lead — {lead.companyName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Person name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Input
            placeholder="LinkedIn profile URL (you confirm it)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {urlInfo && (
            <p className="text-xs">
              {urlInfo.valid ? (
                <span className="text-primary">
                  ✓ {urlInfo.kind === 'person' ? 'Personal profile' : 'Company page'}
                </span>
              ) : (
                <span className="text-destructive">
                  Not a valid LinkedIn profile/company URL.
                </span>
              )}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Add the person and their public profile URL — we never scrape it.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
