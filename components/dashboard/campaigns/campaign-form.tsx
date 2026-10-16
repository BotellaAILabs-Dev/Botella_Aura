'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { toast } from '@/components/ui/toaster';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const MODULES = [
  { key: 'content', label: 'Content posts', note: 'Scheduled on-brand drafts for your review' },
  { key: 'outreach', label: 'Outreach', note: 'Weekly batches of drafted connection notes' },
  { key: 'discovery', label: 'Lead discovery', note: 'Periodic prospecting runs' },
  { key: 'engagement', label: 'Engagement', note: 'Handled live in the extension (no schedule)' },
] as const;

export function CampaignForm({
  initial,
  recommendationId,
  executionHeld = false,
}: {
  /** Filled in from an Aura recommendation (lib/creation-handoff.ts), editable. */
  initial?: {
    name: string;
    goal: string;
    targetAudience: string | null;
    themes: string[];
    durationDays?: number;
    modules?: { content: boolean; outreach: boolean; discovery: boolean; engagement: boolean };
  };
  recommendationId?: string;
  /** Saved as a plan: running it waits for execution (lib/execution-gate.ts). */
  executionHeld?: boolean;
} = {}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    goal: initial?.goal ?? '',
    durationDays: initial?.durationDays ?? 30,
    targetAudience: initial?.targetAudience ?? '',
    themes: initial?.themes.join(', ') ?? '',
  });
  const [modules, setModules] = useState(
    initial?.modules ?? {
      content: true,
      outreach: false,
      discovery: false,
      engagement: false,
    },
  );

  async function create() {
    if (form.name.trim().length < 2 || form.goal.trim().length < 4) {
      toast.error('Add a name and a goal.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/campaigns/orchestrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          goal: form.goal,
          durationDays: Number(form.durationDays) || 30,
          modules,
          targetAudience: form.targetAudience,
          themes: form.themes.split(',').map((s) => s.trim()).filter(Boolean),
          ...(recommendationId ? { recommendationId } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? 'Could not create the campaign.');
        return;
      }
      toast.success(
        executionHeld
          ? 'Campaign planned and saved. Review the schedule — it runs once execution arrives.'
          : 'Campaign planned! Review the schedule.',
      );
      router.push(`/dashboard/campaigns/${data.id}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New campaign</CardTitle>
        <CardDescription>
          Aura plans a day-by-day schedule across the modules you pick. Everything
          it generates still lands in your normal approval queues — nothing
          publishes or sends without you.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <Label>Campaign name</Label>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Launch FlowOS"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Goal</Label>
          <Textarea
            rows={2}
            value={form.goal}
            onChange={(e) => setForm({ ...form, goal: e.target.value })}
            placeholder="Grow awareness of FlowOS among fintech CTOs and fill Q3 pipeline."
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Duration (days)</Label>
            <Input
              type="number"
              min={3}
              max={60}
              value={form.durationDays}
              onChange={(e) => setForm({ ...form, durationDays: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Themes to emphasize</Label>
            <Input
              value={form.themes}
              onChange={(e) => setForm({ ...form, themes: e.target.value })}
              placeholder="reliability, developer experience"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Target audience</Label>
          <Textarea
            rows={2}
            value={form.targetAudience}
            onChange={(e) => setForm({ ...form, targetAudience: e.target.value })}
            placeholder="Fintech CTOs and heads of engineering at seed–Series B startups."
          />
        </div>

        <div className="space-y-2">
          <Label>Modules to include</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {MODULES.map((m) => (
              <label
                key={m.key}
                className="flex items-start gap-2 rounded-md border border-border p-3"
              >
                <input
                  type="checkbox"
                  checked={modules[m.key]}
                  onChange={(e) => setModules({ ...modules, [m.key]: e.target.checked })}
                  className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]"
                />
                <span>
                  <span className="text-sm font-medium">{m.label}</span>
                  <span className="block text-xs text-muted-foreground">{m.note}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      </CardContent>
      <CardFooter className="justify-end">
        <Button onClick={create} loading={saving}>
          <Sparkles className="h-4 w-4" />
          {saving ? 'Planning…' : executionHeld ? 'Plan and save campaign' : 'Plan campaign'}
        </Button>
      </CardFooter>
    </Card>
  );
}
