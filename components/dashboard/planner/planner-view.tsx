'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarDays, Sparkles, Target, Info, Wand2 } from 'lucide-react';

import { toast } from '@/components/ui/toaster';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useGenerationJob } from '@/components/dashboard/jobs/use-generation-job';
import { JobProgressBar } from '@/components/dashboard/jobs/job-progress';
import { CONTENT_CHANNELS } from '@/lib/validations/planner';
import type { CreationPlan } from '@/lib/recommendation-creation';
import { CONTENT_TYPE_LABELS } from '@/lib/content-ui';
import type { ContentTypeKey } from '@/lib/validations/content';
import { DATE_LOCALE } from '@/lib/dates';
import { LocalTime } from '@/components/ui/local-time';

export interface PlanItemView {
  date: string;
  week: number;
  channel: string;
  contentType: string;
  theme: string;
  title: string;
  hook: string;
  brief: string;
  cta: string;
  hashtags: string[];
  objective: string;
}

export interface PlanView {
  month: string;
  generatedAt: string;
  model: string;
  summary: string;
  weeks: { week: number; theme: string; goal: string }[];
  items: PlanItemView[];
  groundedOn: string[];
  /** Weeks / slots filled from the brief because the model ran out of time. */
  outline?: { weeks: number[]; slots: number; strategy: boolean };
}

export interface PlannerInputsView {
  month: string;
  businessGoals: string;
  campaignObjectives: string;
  topics: string[];
  brandGuidelines?: string;
  audience?: string;
  channels: string[];
  postsPerWeek: number;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

const EMPTY: PlannerInputsView = {
  month: currentMonth(),
  businessGoals: '',
  campaignObjectives: '',
  topics: [],
  brandGuidelines: '',
  audience: '',
  channels: ['LinkedIn'],
  postsPerWeek: 3,
};

export function PlannerView({
  plan,
  savedInputs,
  defaults,
  canGenerate,
  fromSuggestion = null,
}: {
  plan: PlanView | null;
  savedInputs: PlannerInputsView | null;
  /**
   * The workspace's audience, goals and channels from settings, used to
   * pre-fill a FIRST plan. Someone who already described their buyers once
   * should not be asked to retype it here — that duplicate question is exactly
   * what makes a first plan feel like paperwork.
   *
   * Only ever a starting point: a plan that has already been generated keeps
   * its own saved brief, since editing that plan must not silently revert to
   * workspace defaults.
   */
  defaults: Partial<PlannerInputsView> | null;
  canGenerate: boolean;
  /**
   * Opened from an Aura recommendation (`?rec=`): the brief is prefilled from
   * what it already knows, and the plan is linked back to it.
   */
  fromSuggestion?: {
    id: string;
    title: string;
    plan: CreationPlan;
    prefill: Partial<PlannerInputsView> | null;
  } | null;
}) {
  const router = useRouter();
  const prefill = fromSuggestion?.prefill ?? null;
  const hasPrefill = prefill !== null;
  const [form, setForm] = useState<PlannerInputsView>({
    ...(savedInputs ?? { ...EMPTY, ...(defaults ?? {}) }),
    ...(prefill ?? {}),
  });
  const [topicsText, setTopicsText] = useState(
    (prefill?.topics ?? savedInputs?.topics ?? []).join(', '),
  );
  // Only a suggestion that can be planned from travels with the plan.
  const recommendationId =
    fromSuggestion?.plan.canCreate ? fromSuggestion.id : undefined;
  const draftKey = 'aura.planner.brief';

  function toggleChannel(ch: string) {
    setForm((f) => ({
      ...f,
      channels: f.channels.includes(ch)
        ? f.channels.filter((c) => c !== ch)
        : [...f.channels, ch],
    }));
  }

  /**
   * A generation that fails must never cost the user their brief. The server
   * keeps it on the job row for retry; this keeps it in the box in front of
   * them too, so a reload mid-run doesn't wipe the form either.
   */
  useEffect(() => {
    // A saved plan, or a suggestion's prefill, wins over a local draft.
    if (savedInputs || hasPrefill) return;
    try {
      const raw = window.localStorage.getItem(draftKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PlannerInputsView;
      setForm(parsed);
      setTopicsText((parsed.topics ?? []).join(', '));
    } catch {
      // A corrupt draft is not worth surfacing — just start clean.
    }
  }, [savedInputs, hasPrefill]);

  const { job, start, attach, running } = useGenerationJob('MARKETING_PLAN', {
    // Matches the server's fuse for a plan run (stuckAfterMs): past this the
    // run is dead, and Try again starts a fresh one rather than reattaching.
    giveUpAfterMs: 2 * 60 * 1000,
    onDone(finished) {
      if (finished.status !== 'SUCCEEDED') return;
      const items = Number(finished.result?.items ?? 0);
      toast.success(`Calendar ready — ${items} piece${items === 1 ? '' : 's'} scheduled.`);
      try {
        window.localStorage.removeItem(draftKey);
      } catch {
        // Non-fatal.
      }
      router.refresh();
    },
  });

  // Reattach to a calendar already being generated (e.g. after a reload).
  useEffect(() => {
    void attach();
  }, [attach]);

  function buildInputs() {
    return {
      ...form,
      topics: topicsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      brandGuidelines: form.brandGuidelines || undefined,
      audience: form.audience || undefined,
      ...(recommendationId ? { recommendationId } : {}),
    };
  }

  async function generate() {
    if (form.businessGoals.trim().length < 10) {
      toast.error('Describe the business goal this month should move.');
      return;
    }
    if (form.campaignObjectives.trim().length < 5) {
      toast.error('Say what the campaign should achieve.');
      return;
    }
    if (form.channels.length === 0) {
      toast.error('Pick at least one channel.');
      return;
    }
    // Planning from a suggestion that is still open says yes to it first.
    if (recommendationId && fromSuggestion?.plan.acceptsOnCreate) {
      const yes = await fetch(`/api/recommendations/${recommendationId}/creation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: 'content-plan' }),
      });
      if (!yes.ok) {
        const b = (await yes.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not say yes to this suggestion.');
        return;
      }
    }
    const inputs = buildInputs();
    try {
      window.localStorage.setItem(draftKey, JSON.stringify(inputs));
    } catch {
      // Storage can be unavailable (private mode) — the server copy still covers retry.
    }
    await start(inputs);
  }

  const busy = running;

  return (
    <div className="space-y-6">
      {/* The explicit brief the client asked for. */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Target className="h-5 w-5 text-primary" />
            <div>
              <CardTitle className="text-base">Your brief</CardTitle>
              <CardDescription>
                Tell Aura what this month is for. The calendar is built from these
                answers — nothing is assumed.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {fromSuggestion && (
            <div
              className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground"
              role="status"
            >
              <span className="flex items-center gap-1.5 font-medium text-foreground">
                <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
                From Aura’s suggestion: “{fromSuggestion.title}”
              </span>
              {fromSuggestion.plan.canCreate ? (
                <span>
                  The goal, objective, topic
                  {prefill?.audience ? ', audience' : ''}
                  {prefill?.channels ? ' and channel' : ''} are filled in from
                  it — change anything before generating.
                  {fromSuggestion.plan.acceptsOnCreate
                    ? ' Generating the plan also says yes to the suggestion.'
                    : ''}
                </span>
              ) : (
                <span>
                  {fromSuggestion.plan.message}{' '}
                  {fromSuggestion.plan.fix && (
                    <Link
                      href={fromSuggestion.plan.fix.href}
                      className="text-primary hover:underline"
                    >
                      {fromSuggestion.plan.fix.label}
                    </Link>
                  )}
                </span>
              )}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="month">Month</Label>
              <Input
                id="month"
                type="month"
                value={form.month}
                onChange={(e) => setForm({ ...form, month: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cadence">Posts per week</Label>
              <Input
                id="cadence"
                type="number"
                min={1}
                max={14}
                value={form.postsPerWeek}
                onChange={(e) =>
                  setForm({ ...form, postsPerWeek: Number(e.target.value) || 1 })
                }
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="goals">Business goals *</Label>
            <Textarea
              id="goals"
              rows={3}
              value={form.businessGoals}
              onChange={(e) => setForm({ ...form, businessGoals: e.target.value })}
              placeholder="e.g. Move upmarket to 50–200 person distilleries; we need pipeline from operations leads, not founders."
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="objectives">Campaign objectives *</Label>
            <Textarea
              id="objectives"
              rows={2}
              value={form.campaignObjectives}
              onChange={(e) =>
                setForm({ ...form, campaignObjectives: e.target.value })
              }
              placeholder="e.g. 15 booked demos, 200 newsletter signups, double LinkedIn comment rate."
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="topics">Topics to cover</Label>
              <Input
                id="topics"
                value={topicsText}
                onChange={(e) => setTopicsText(e.target.value)}
                placeholder="compliance, batch tracking, distributor relationships"
              />
              <p className="text-xs text-muted-foreground">Comma-separated.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audience">Audience</Label>
              <Input
                id="audience"
                value={form.audience ?? ''}
                onChange={(e) => setForm({ ...form, audience: e.target.value })}
                placeholder="Operations leads at mid-size distilleries"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="guidelines">Brand guidelines</Label>
            <Textarea
              id="guidelines"
              rows={3}
              value={form.brandGuidelines ?? ''}
              onChange={(e) =>
                setForm({ ...form, brandGuidelines: e.target.value })
              }
              placeholder="e.g. Plain English, no emoji, never claim ROI numbers we can't cite, always name the customer role we're speaking to."
            />
            <p className="text-xs text-muted-foreground">
              Applied on top of your saved brand voice profile. Anything you forbid
              here is treated as a hard rule.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Channels *</Label>
            <div className="flex flex-wrap gap-2">
              {CONTENT_CHANNELS.map((ch) => {
                const on = form.channels.includes(ch);
                return (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => toggleChannel(ch)}
                    aria-pressed={on}
                    className={
                      'rounded-full border px-3 py-1 text-sm transition-colors ' +
                      (on
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted')
                    }
                  >
                    {ch}
                  </button>
                );
              })}
            </div>
          </div>

          {canGenerate && (
            <Button onClick={generate} loading={busy}>
              <Wand2 className="h-4 w-4" />
              {plan ? 'Regenerate calendar' : 'Generate monthly calendar'}
            </Button>
          )}

          {/* Named steps + a retry that reuses this brief, instead of an
              indefinite buffering state that ends with no calendar. */}
          <JobProgressBar
            job={job}
            runningLabel="Building your monthly calendar"
            expectedSeconds={45}
            onRetry={() => void generate()}
          />

          {plan && (
            <p className="text-xs text-muted-foreground">
              Regenerating replaces the plan for {plan.month} — it never creates a
              duplicate month.
            </p>
          )}
        </CardContent>
      </Card>

      {plan && <Calendar plan={plan} />}
    </div>
  );
}

function Calendar({ plan }: { plan: PlanView }) {
  const byWeek = new Map<number, PlanItemView[]>();
  for (const item of plan.items) {
    if (!byWeek.has(item.week)) byWeek.set(item.week, []);
    byWeek.get(item.week)!.push(item);
  }
  const weekMeta = new Map(plan.weeks.map((w) => [w.week, w]));

  return (
    <div className="space-y-4">
      <Card className="border-primary/20">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-primary" />
            <div>
              <CardTitle className="text-base">
                {new Date(`${plan.month}-01T00:00:00Z`).toLocaleDateString(
                  undefined,
                  { month: 'long', year: 'numeric', timeZone: 'UTC' },
                )}{' '}
                calendar
              </CardTitle>
              <CardDescription>
                {plan.items.length} pieces ·{' '}
                {plan.model === 'none'
                  ? 'rule-based (no AI provider configured)'
                  : plan.model === 'outline'
                    ? 'outline from your brief (AI did not answer in time)'
                    : `AI: ${plan.model}`}{' '}
                · generated <LocalTime iso={plan.generatedAt} />
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">{plan.summary}</p>
          {plan.outline && plan.model !== 'outline' && (
            <p
              className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
              role="status"
            >
              {outlineNotice(plan.outline)}
            </p>
          )}
          {plan.groundedOn.length > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Grounded on: {plan.groundedOn.join(' · ')}
            </p>
          )}
        </CardContent>
      </Card>

      {[...byWeek.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([week, items]) => {
          const meta = weekMeta.get(week);
          return (
            <Card key={week}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  Week {week}
                  {meta?.theme ? ` — ${meta.theme}` : ''}
                </CardTitle>
                {meta?.goal && <CardDescription>{meta.goal}</CardDescription>}
              </CardHeader>
              <CardContent className="space-y-3">
                {items.map((item) => (
                  <PlanRow key={`${item.date}-${item.title}`} item={item} />
                ))}
              </CardContent>
            </Card>
          );
        })}
    </div>
  );
}

/**
 * Says which parts are an outline. The calendar is complete either way — every
 * slot is dated and briefed — but an outline slot is generic, and the user
 * should know which ones before drafting from them.
 */
function outlineNotice(outline: NonNullable<PlanView['outline']>): string {
  const weeks = outline.weeks;
  if (weeks.length > 0) {
    const list =
      weeks.length === 1
        ? `Week ${weeks[0]} is`
        : `Weeks ${weeks.slice(0, -1).join(', ')} and ${weeks[weeks.length - 1]} are`;
    const it = weeks.length === 1 ? 'it' : 'them';
    return `${list} a simple outline from your brief — Aura did not finish writing ${it} in time. Regenerate to have Aura write ${it} in full.`;
  }
  if (outline.slots > 0) {
    const it = outline.slots === 1 ? 'it' : 'them';
    return `${outline.slots} post${outline.slots === 1 ? ' is' : 's are'} a simple outline from your brief — Aura skipped ${it}. Regenerate to have Aura write ${it} in full.`;
  }
  return 'The weekly themes come from your stated topics — Aura did not finish planning the month in time. Regenerate for a strategy-led arc.';
}

function PlanRow({ item }: { item: PlanItemView }) {
  const typeLabel =
    CONTENT_TYPE_LABELS[item.contentType as ContentTypeKey] ?? item.contentType;
  const draftHref =
    `/dashboard/content/new?type=${encodeURIComponent(item.contentType)}` +
    `&brief=${encodeURIComponent(
      `${item.brief}\n\nHook: ${item.hook}\nCall to action: ${item.cta}\nObjective: ${item.objective}`,
    )}`;

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="default">
              {new Date(`${item.date}T00:00:00Z`).toLocaleDateString(DATE_LOCALE, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                timeZone: 'UTC',
              })}
            </Badge>
            <Badge variant="outline">{item.channel}</Badge>
            <Badge variant="muted">{typeLabel}</Badge>
          </div>
          <p className="mt-1.5 font-medium text-foreground">{item.title}</p>
          <p className="text-sm text-muted-foreground">{item.hook}</p>
        </div>
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link href={draftHref}>
            <Sparkles className="h-4 w-4" /> Draft this
          </Link>
        </Button>
      </div>

      <p className="mt-2 text-sm text-muted-foreground">{item.brief}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">CTA:</span> {item.cta}
        </span>
        <span>
          <span className="font-medium text-foreground">Objective:</span>{' '}
          {item.objective}
        </span>
        {item.hashtags.map((h) => (
          <Badge key={h} variant="secondary">
            #{h.replace(/^#/, '')}
          </Badge>
        ))}
      </div>
    </div>
  );
}
