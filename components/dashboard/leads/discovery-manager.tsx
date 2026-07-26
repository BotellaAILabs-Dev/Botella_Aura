'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Play, Trash2, Radar, Clock } from 'lucide-react';
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

const EMPTY = {
  name: '',
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
      };
      if (!res.ok) {
        toast.error(data.error ?? 'Discovery run failed.');
        return;
      }
      toast.success(
        `Found ${data.leadsFound ?? 0} candidate(s), added ${data.leadsCreated ?? 0} new lead(s).`,
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
            <div className="space-y-1.5">
              <Label>Profile name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="AI devtool founders, seed–Series A"
              />
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
            </label>
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
                  <div className="flex items-center gap-2">
                    <Radar className="h-4 w-4 text-primary" />
                    <span className="font-medium">{p.name}</span>
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
                </div>
                {canManage && (
                  <div className="flex items-center gap-2">
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
            </Card>
          ))
        )}
      </div>
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
