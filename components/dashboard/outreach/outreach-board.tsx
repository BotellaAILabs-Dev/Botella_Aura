'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
  SIGNAL_LABELS,
  outreachStatusVariant,
  type OutreachStatusKey,
} from '@/lib/outreach-ui';

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
  signals: OutreachSignalRow[];
  messages: OutreachMessageRow[];
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
  canManage,
}: {
  leads: LeadRow[];
  canManage: boolean;
}) {
  return (
    <div className="space-y-4">
      {leads.map((lead) => (
        <LeadCard key={lead.id} lead={lead} canManage={canManage} />
      ))}
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
          <div>
            <CardTitle className="text-base">
              {lead.name ? `${lead.name} · ` : ''}
              {lead.companyName}
            </CardTitle>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {lead.title && <span>{lead.title}</span>}
              <Badge variant="secondary">{lead.status}</Badge>
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

        {/* Messages / drafts */}
        {lead.messages.length === 0 ? (
          canManage && (
            <Button size="sm" onClick={draft} loading={busy}>
              <Sparkles className="h-4 w-4" /> Draft outreach
            </Button>
          )
        ) : (
          <div className="space-y-3">
            {lead.messages.map((m) => (
              <MessageBlock key={m.id} message={m} canManage={canManage} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MessageBlock({
  message,
  canManage,
}: {
  message: OutreachMessageRow;
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
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">
          {OUTREACH_TYPE_LABELS[message.type] ?? message.type}
        </span>
        <Badge variant={outreachStatusVariant(message.status)}>
          {OUTREACH_STATUS_LABELS[message.status]}
        </Badge>
      </div>

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

      {/* Sprint 5 — manual "did it work" outcome (feeds Marketing Memory) */}
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

  async function save() {
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
