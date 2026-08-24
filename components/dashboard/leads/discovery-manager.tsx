'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus,
  Play,
  Trash2,
  Radar,
  Clock,
  Gauge,
  AlertTriangle,
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
import { Badge } from '@/components/ui/badge';

export interface DiscoveryProfileRow {
  id: string;
  name: string;
  /** Requirement label stamped on every lead this profile discovers. */
  category: string | null;
  criteria: {
    industries?: string[];
    companyStages?: string[];
    roleTitles?: string[];
    geographies?: string[];
    keywords?: string[];
  };
  autoRun: boolean;
  isActive: boolean;
  lastRunAt: string | null;
  leadCount: number;
  runCount: number;
}

const toList = (t: string) => t.split(',').map((s) => s.trim()).filter(Boolean);

/** Next weekly auto-run: last run + 7 days, or "after the first run" if never run. */
function nextRunLabel(lastRunAt: string | null): string {
  if (!lastRunAt) return 'after the first run';
  const next = new Date(new Date(lastRunAt).getTime() + 7 * 24 * 60 * 60 * 1000);
  return next.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

interface EstimatedSource {
  id: string;
  label: string;
  willRun: boolean;
  reason?: string;
}

interface DiscoveryEstimate {
  profileName: string;
  category: string;
  sources: EstimatedSource[];
  expectedResults: { min: number; max: number };
  expectedNewLeads: { min: number; max: number };
  estimatedSeconds: { min: number; max: number };
  usage: {
    aiEnabled: boolean;
    model: string;
    estimatedAiCalls: { min: number; max: number };
    estimatedTokens: { min: number; max: number };
    note: string;
  };
  existingLeads: number;
  basedOnHistory: boolean;
  warnings: string[];
}

function seconds(n: number): string {
  return n >= 90 ? `${Math.round(n / 60)} min` : `${n}s`;
}

const EMPTY = {
  name: '',
  category: '',
  industries: '',
  companyStages: '',
  roleTitles: '',
  geographies: '',
  keywords: '',
  autoRun: false,
};

export function DiscoveryManager({
  profiles,
  canManage,
}: {
  profiles: DiscoveryProfileRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  /** Pre-run estimates, keyed by profile id. */
  const [estimates, setEstimates] = useState<Record<string, DiscoveryEstimate>>({});
  const [estimatingId, setEstimatingId] = useState<string | null>(null);

  async function create() {
    if (form.name.trim().length < 2) {
      toast.error('Give the profile a name.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/leads/discovery/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          category: form.category.trim() || undefined,
          autoRun: form.autoRun,
          criteria: {
            industries: toList(form.industries),
            companyStages: toList(form.companyStages),
            roleTitles: toList(form.roleTitles),
            geographies: toList(form.geographies),
            keywords: toList(form.keywords),
          },
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not save profile.');
        return;
      }
      toast.success('Discovery profile saved.');
      setForm(EMPTY);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  /**
   * Fetch what a run would actually produce before spending time and tokens on
   * it. Nothing runs here - this is read-only.
   */
  async function estimate(id: string) {
    setEstimatingId(id);
    try {
      const res = await fetch(`/api/leads/discovery/profiles/${id}/estimate`);
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not estimate this run.');
        return;
      }
      const data = (await res.json()) as DiscoveryEstimate;
      setEstimates((prev) => ({ ...prev, [id]: data }));
    } finally {
      setEstimatingId(null);
    }
  }

  async function run(id: string) {
    setRunningId(id);
    try {
      const res = await fetch(`/api/leads/discovery/profiles/${id}/run`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        leadsCreated?: number;
        leadsFound?: number;
        skipped?: string[];
        category?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? 'Discovery run failed.');
        return;
      }
      toast.success(
        `Found ${data.leadsFound ?? 0} candidate(s), added ${data.leadsCreated ?? 0} new lead(s)` +
          (data.category ? ` under “${data.category}”.` : '.') +
          ' They are on the Leads page and the Outreach board.',
      );
      if (data.skipped?.length) {
        toast.message?.('Some sources were skipped', {
          description: data.skipped.join(' · '),
        });
      }
      router.refresh();
    } finally {
      setRunningId(null);
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this discovery profile?')) return;
    const res = await fetch(`/api/leads/discovery/profiles/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      toast.error('Could not delete.');
      return;
    }
    toast.success('Profile deleted.');
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>New discovery profile</CardTitle>
            <CardDescription>
              Describe who you want to reach. Discovery searches legitimate public
              sources (GitHub, company sites, and — with keys — Crunchbase / Google
              Custom Search). No LinkedIn scraping.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Requirement name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="AI devtool founders, seed–Series A"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Lead category</Label>
                <Input
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder="e.g. Distillery, Liquor Store, Head of Marketing"
                />
                <p className="text-xs text-muted-foreground">
                  Every lead this requirement finds is filed under this label, so
                  results from different requirements never get mixed together.
                  Defaults to the requirement name.
                </p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Industries / keywords topics">
                <Input
                  value={form.industries}
                  onChange={(e) => setForm({ ...form, industries: e.target.value })}
                  placeholder="devtools, AI infrastructure"
                />
              </Field>
              <Field label="Role titles">
                <Input
                  value={form.roleTitles}
                  onChange={(e) => setForm({ ...form, roleTitles: e.target.value })}
                  placeholder="Founder, CTO, Head of AI"
                />
              </Field>
              <Field label="Company stage / size">
                <Input
                  value={form.companyStages}
                  onChange={(e) => setForm({ ...form, companyStages: e.target.value })}
                  placeholder="seed, series a, 10-50"
                />
              </Field>
              <Field label="Geographies">
                <Input
                  value={form.geographies}
                  onChange={(e) => setForm({ ...form, geographies: e.target.value })}
                  placeholder="US, Europe"
                />
              </Field>
            </div>
            <Field label="Signal keywords">
              <Input
                value={form.keywords}
                onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                placeholder="hiring AI engineers, raised Series A, open source"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.autoRun}
                onChange={(e) => setForm({ ...form, autoRun: e.target.checked })}
                className="h-4 w-4 accent-[hsl(var(--primary))]"
              />
              Auto-run weekly
              <span className="text-xs text-muted-foreground">
                (runs every 7 days; you review each result before any outreach)
              </span>
            </label>
            {/* Saved profiles get a precise, per-profile estimate below. */}
            <p className="rounded-md border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Before you run:</span>{' '}
              once saved, press{' '}
              <span className="font-medium text-foreground">Estimate</span> on the
              profile to see the expected number of results, how long the run will
              take, and what it will cost in AI usage — computed from your criteria,
              the sources you have connected, and this profile’s own run history.
              Nothing is contacted automatically.
            </p>
            <div>
              <Button onClick={create} loading={saving}>
                <Plus className="h-4 w-4" /> Save profile
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No profiles yet.</p>
        ) : (
          profiles.map((p) => (
            <Card key={p.id}>
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Radar className="h-4 w-4 text-primary" />
                    <span className="font-medium">{p.name}</span>
                    <Badge
                      variant="outline"
                      title="Leads from this requirement are filed under this label"
                    >
                      {p.category ?? p.name}
                    </Badge>
                    {p.autoRun && <Badge variant="secondary">Weekly</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {[...(p.criteria.roleTitles ?? []), ...(p.criteria.industries ?? [])]
                      .slice(0, 4)
                      .join(' · ') || 'no criteria'}
                  </p>
                  <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {p.lastRunAt
                      ? `Last run ${new Date(p.lastRunAt).toLocaleString()}`
                      : 'Never run'}{' '}
                    · {p.leadCount} leads · {p.runCount} runs
                  </p>
                  {p.autoRun && (
                    <p className="mt-0.5 text-xs text-primary">
                      Next auto-run: {nextRunLabel(p.lastRunAt)}
                    </p>
                  )}
                </div>
                {canManage && (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => estimate(p.id)}
                      loading={estimatingId === p.id}
                    >
                      <Gauge className="h-4 w-4" /> Estimate
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => run(p.id)}
                      loading={runningId === p.id}
                    >
                      <Play className="h-4 w-4" /> Run now
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => remove(p.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                )}
              </CardContent>

              {/* What this run will actually produce, before you spend on it. */}
              {estimates[p.id] && (
                <div className="border-t border-border px-4 pb-4 pt-3">
                  <EstimatePanel estimate={estimates[p.id]!} />
                </div>
              )}
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

/** Expected results, run time, and AI usage for one discovery profile. */
function EstimatePanel({ estimate }: { estimate: DiscoveryEstimate }) {
  const running = estimate.sources.filter((s) => s.willRun);
  const off = estimate.sources.filter((s) => !s.willRun);

  return (
    <div className="space-y-3 text-xs">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Expected results"
          value={
            estimate.expectedResults.min === estimate.expectedResults.max
              ? `${estimate.expectedResults.max}`
              : `${estimate.expectedResults.min}–${estimate.expectedResults.max}`
          }
          hint={`${estimate.expectedNewLeads.min}–${estimate.expectedNewLeads.max} new after de-duplication`}
        />
        <Stat
          label="Processing time"
          value={`${seconds(estimate.estimatedSeconds.min)}–${seconds(
            estimate.estimatedSeconds.max,
          )}`}
          hint={
            estimate.basedOnHistory
              ? 'Based on this profile\u2019s past runs'
              : 'Estimate \u2014 refines after the first run'
          }
        />
        <Stat
          label="AI usage"
          value={
            estimate.usage.aiEnabled
              ? `${estimate.usage.estimatedAiCalls.min}–${estimate.usage.estimatedAiCalls.max} calls`
              : 'None'
          }
          hint={
            estimate.usage.aiEnabled
              ? `~${estimate.usage.estimatedTokens.min.toLocaleString()}–${estimate.usage.estimatedTokens.max.toLocaleString()} output tokens · ${estimate.usage.model}`
              : 'No AI provider configured'
          }
        />
      </div>

      <p className="text-muted-foreground">{estimate.usage.note}</p>

      <div className="flex flex-wrap gap-1.5">
        {running.map((s) => (
          <Badge key={s.id} variant="success" title="Will run">
            {s.label}
          </Badge>
        ))}
        {off.map((s) => (
          <Badge key={s.id} variant="muted" title={s.reason}>
            {s.label} — off
          </Badge>
        ))}
      </div>

      {estimate.warnings.length > 0 && (
        <ul className="space-y-1">
          {estimate.warnings.map((w) => (
            <li key={w} className="flex items-start gap-1.5 text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {w}
            </li>
          ))}
        </ul>
      )}

      <p className="text-muted-foreground">
        Results are filed under{' '}
        <span className="font-medium text-foreground">{estimate.category}</span>
        {estimate.existingLeads > 0 && (
          <>
            {' '}
            · {estimate.existingLeads} lead
            {estimate.existingLeads === 1 ? '' : 's'} already found by this
            requirement (these are de-duplicated, not re-created)
          </>
        )}
        .
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-2.5">
      <p className="uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-base font-semibold text-foreground">{value}</p>
      <p className="text-muted-foreground">{hint}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
