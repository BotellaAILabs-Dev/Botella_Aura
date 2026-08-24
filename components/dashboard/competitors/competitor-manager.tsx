'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus,
  RefreshCw,
  Trash2,
  Pencil,
  Github,
  Globe,
  Linkedin,
  ExternalLink,
} from 'lucide-react';
import { toast } from '@/components/ui/toaster';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Users } from 'lucide-react';
import type { ChangesSummary } from '@/server/competitors/types';
import { classifyLinkedInUrl } from '@/lib/linkedin-url';

export interface CompetitorRow {
  id: string;
  name: string;
  url: string | null;
  pricingUrl: string | null;
  linkedInUrl: string | null;
  githubOrg: string | null;
  notes: string | null;
  trackingEnabled: boolean;
  latest: { capturedAt: string; summary: ChangesSummary } | null;
}

type FormState = {
  name: string;
  url: string;
  pricingUrl: string;
  linkedInUrl: string;
  githubOrg: string;
  notes: string;
};

const EMPTY: FormState = {
  name: '',
  url: '',
  pricingUrl: '',
  linkedInUrl: '',
  githubOrg: '',
  notes: '',
};

export function CompetitorManager({
  competitors,
  canManage,
}: {
  competitors: CompetitorRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [trackingId, setTrackingId] = useState<string | null>(null);

  function openAdd() {
    setEditingId(null);
    setForm(EMPTY);
    setDialogOpen(true);
  }
  function openEdit(c: CompetitorRow) {
    setEditingId(c.id);
    setForm({
      name: c.name,
      url: c.url ?? '',
      pricingUrl: c.pricingUrl ?? '',
      linkedInUrl: c.linkedInUrl ?? '',
      githubOrg: c.githubOrg ?? '',
      notes: c.notes ?? '',
    });
    setDialogOpen(true);
  }

  const linkedInInfo = form.linkedInUrl.trim()
    ? classifyLinkedInUrl(form.linkedInUrl)
    : null;

  async function save() {
    if (form.name.trim().length < 2) {
      toast.error('Competitor name is required.');
      return;
    }
    if (form.linkedInUrl.trim() && !classifyLinkedInUrl(form.linkedInUrl).valid) {
      toast.error(
        'Enter a valid LinkedIn company page URL (linkedin.com/company/…), or leave it blank.',
      );
      return;
    }
    setSaving(true);
    try {
      const url = editingId ? `/api/competitors/${editingId}` : '/api/competitors';
      const res = await fetch(url, {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not save competitor.');
        return;
      }
      toast.success(editingId ? 'Competitor updated.' : 'Competitor added.');
      setDialogOpen(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Remove ${name}? This deletes its tracking history.`)) return;
    const res = await fetch(`/api/competitors/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Could not remove competitor.');
      return;
    }
    toast.success('Competitor removed.');
    router.refresh();
  }

  async function trackNow(id: string) {
    setTrackingId(id);
    try {
      const res = await fetch(`/api/competitors/${id}/track`, { method: 'POST' });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Tracking failed.');
        return;
      }
      const data = (await res.json()) as { hasChanges?: boolean };
      toast.success(
        data.hasChanges ? 'Snapshot captured — changes detected.' : 'Snapshot captured.',
      );
      router.refresh();
    } finally {
      setTrackingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {competitors.length} tracked{' '}
          {competitors.length === 1 ? 'competitor' : 'competitors'}
        </p>
        {canManage && (
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={openAdd} size="sm">
                <Plus className="h-4 w-4" /> Add competitor
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {editingId ? 'Edit competitor' : 'Add a competitor'}
                </DialogTitle>
                <DialogDescription>
                  Aura tracks public signal only — website changes, public news,
                  and GitHub activity. No scraping.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <Field label="Name" required>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Acme Rival Inc."
                  />
                </Field>
                <Field label="Website (homepage)">
                  <Input
                    value={form.url}
                    onChange={(e) => setForm({ ...form, url: e.target.value })}
                    placeholder="rival.com"
                  />
                </Field>
                <Field label="Pricing page URL">
                  <Input
                    value={form.pricingUrl}
                    onChange={(e) => setForm({ ...form, pricingUrl: e.target.value })}
                    placeholder="rival.com/pricing"
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="LinkedIn page">
                    <Input
                      value={form.linkedInUrl}
                      onChange={(e) =>
                        setForm({ ...form, linkedInUrl: e.target.value })
                      }
                      placeholder="linkedin.com/company/rival"
                    />
                    {/* A competitor is an organization: a personal /in/ profile
                        here is almost always a mistake, so say so. */}
                    {linkedInInfo && (
                      <p className="text-xs">
                        {!linkedInInfo.valid ? (
                          <span className="text-destructive">
                            Not a valid LinkedIn URL — use
                            linkedin.com/company/…
                          </span>
                        ) : linkedInInfo.kind === 'company' ? (
                          <span className="text-primary">
                            ✓ Company / organization page
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            That is a personal profile (/in/). A competitor
                            should be a company page (/company/).
                          </span>
                        )}
                      </p>
                    )}
                  </Field>
                  <Field label="GitHub org">
                    <Input
                      value={form.githubOrg}
                      onChange={(e) => setForm({ ...form, githubOrg: e.target.value })}
                      placeholder="rival"
                    />
                  </Field>
                </div>
                <Field label="Notes">
                  <Textarea
                    rows={2}
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    placeholder="Why you're tracking them…"
                  />
                </Field>
              </div>
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => setDialogOpen(false)}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button onClick={save} loading={saving}>
                  {editingId ? 'Save' : 'Add competitor'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {competitors.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No competitors yet"
          description="Add competitors to track their website changes, public news, and GitHub activity — summarized into a weekly report."
          action={
            canManage ? (
              <Button onClick={openAdd}>
                <Plus className="h-4 w-4" /> Add your first competitor
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-4">
          {competitors.map((c) => (
            <Card key={c.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      {c.name}
                      {!c.trackingEnabled && (
                        <Badge variant="muted">Paused</Badge>
                      )}
                    </CardTitle>
                    <CardDescription className="mt-1 flex flex-wrap items-center gap-3">
                      {c.url && <LinkPill icon={Globe} href={c.url} label="Website" />}
                      {c.pricingUrl && (
                        <LinkPill icon={ExternalLink} href={c.pricingUrl} label="Pricing" />
                      )}
                      {c.linkedInUrl && (
                        <LinkPill icon={Linkedin} href={c.linkedInUrl} label="LinkedIn" />
                      )}
                      {c.githubOrg && (
                        <LinkPill
                          icon={Github}
                          href={`https://github.com/${c.githubOrg}`}
                          label={c.githubOrg}
                        />
                      )}
                    </CardDescription>
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => trackNow(c.id)}
                        loading={trackingId === c.id}
                        title="Capture a snapshot now"
                      >
                        <RefreshCw className="h-4 w-4" /> Track now
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => openEdit(c)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => remove(c.id, c.name)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <LatestSnapshot row={c} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function LatestSnapshot({ row }: { row: CompetitorRow }) {
  if (!row.latest) {
    return (
      <p className="text-sm text-muted-foreground">
        No snapshot yet. Click <span className="font-medium">Track now</span> to
        capture the first one.
      </p>
    );
  }
  const s = row.latest.summary;
  const captured = new Date(row.latest.capturedAt).toLocaleString();
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Last checked {captured}</span>
        {s.isBaseline ? (
          <Badge variant="default">Baseline captured</Badge>
        ) : s.hasChanges ? (
          <Badge variant="warning">Changes detected</Badge>
        ) : (
          <Badge variant="muted">No website change</Badge>
        )}
      </div>

      {/* The first capture has nothing to diff against, so show what the pages
          say today rather than an empty "no changes" result. */}
      {s.isBaseline && s.baseline && (
        <div className="rounded-md border border-border bg-muted/30 p-2.5">
          <p className="text-xs font-medium text-foreground">
            First capture — this is the reference point. Changes are reported
            from the next run onward.
          </p>
          {s.baseline.homepage && (
            <p className="mt-1 text-muted-foreground">{s.baseline.homepage}</p>
          )}
          {s.baseline.pricing && (
            <p className="mt-1 text-muted-foreground">{s.baseline.pricing}</p>
          )}
        </div>
      )}
      {s.homepage && (
        <p>
          <span className="font-medium">Homepage:</span> {s.homepage}
        </p>
      )}
      {s.pricing && (
        <p>
          <span className="font-medium">Pricing:</span> {s.pricing}
        </p>
      )}
      {s.news.length > 0 && (
        <div>
          <span className="font-medium">Recent news:</span>
          <ul className="ml-4 list-disc text-muted-foreground">
            {s.news.slice(0, 3).map((n) => (
              <li key={n.url}>
                <a
                  href={n.url}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-primary hover:underline"
                >
                  {n.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.github?.latestRelease && (
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">GitHub:</span> latest
          release {s.github.latestRelease.name} in {s.github.latestRelease.repo}
        </p>
      )}
      {s.skipped.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Skipped: {s.skipped.join('; ')}
        </p>
      )}
    </div>
  );
}

function LinkPill({
  icon: Icon,
  href,
  label,
}: {
  icon: typeof Globe;
  href: string;
  label: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs hover:text-primary hover:underline"
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </a>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {children}
    </div>
  );
}
