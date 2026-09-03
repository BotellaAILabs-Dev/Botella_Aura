'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Users, Target, Megaphone, Store } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';
import { cn } from '@/lib/utils';
import { CONTENT_CHANNELS } from '@/lib/validations/planner';
import type { MarketMode } from '@/lib/validations/profile';

/** Phrased as "who buys from you", not "B2B or B2C" — the jargon is ours. */
const MARKET_MODE_OPTIONS: { id: MarketMode; label: string; blurb: string }[] = [
  {
    id: 'B2C',
    label: 'People, for themselves',
    blurb: 'Someone spending their own money on something they want.',
  },
  {
    id: 'B2B',
    label: 'Other businesses',
    blurb: 'Someone buying on behalf of a company, answerable for the spend.',
  },
];

interface AudienceInitial {
  audience: string;
  goals: string;
  channels: string[];
  marketMode: MarketMode;
}

/**
 * Audience and goals, in the user's own words.
 *
 * Free text rather than dropdowns because the useful part of an answer here is
 * the specifics — "ops leads who still run everything in spreadsheets" steers a
 * model far harder than picking "Operations" from a list. The placeholders are
 * doing real work: they show the level of detail that helps, which is the thing
 * a blank textarea never communicates.
 */
export function AudienceGoalsForm({
  initial,
  canManage,
}: {
  initial: AudienceInitial;
  canManage: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [audience, setAudience] = useState(initial.audience);
  const [goals, setGoals] = useState(initial.goals);
  const [channels, setChannels] = useState<string[]>(initial.channels);
  const [marketMode, setMarketMode] = useState<MarketMode>(initial.marketMode);
  const consumer = marketMode === 'B2C';

  // The placeholder is the real instruction here — it shows the level of detail
  // that helps, which a blank textarea never communicates. So it has to follow
  // the mode: a bourbon brand shown a logistics-CFO example learns the wrong
  // lesson about what to write.
  const audiencePlaceholder = consumer
    ? 'People in their 30s and 40s who already drink bourbon and have opinions about it. They read the back label, they like knowing where something was distilled, and they are tired of being sold "smooth".'
    : 'Operations leads at 50-200 person logistics firms. They still run scheduling in spreadsheets, they answer to a CFO about cost per delivery, and they have been burned by software that took six months to roll out.';
  const audienceHelp = consumer
    ? 'Describe one real person, not a segment. What do they already like, what do they know, and what are they tired of hearing? Every post Aura writes is addressed to them.'
    : 'Describe one real person, not a segment. What is their job, what are they measured on, and what are they sick of? Every post Aura writes is addressed to them.';
  const goalsPlaceholder = consumer
    ? 'Get 5,000 app downloads this quarter, and be the bottle people photograph and post when friends come over.'
    : 'Book 15 demos a month from inbound, and be the name that comes up when a logistics ops lead asks peers what they use.';

  function toggleChannel(channel: string) {
    setChannels((prev) =>
      prev.includes(channel)
        ? prev.filter((c) => c !== channel)
        : [...prev, channel],
    );
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/company/audience', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audience, goals, channels, marketMode }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? 'Could not save.');
        return;
      }
      toast.success('Saved. Aura will write for this reader from now on.');
      router.refresh();
    } catch {
      toast.error('Could not reach the server. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/*
        First, because it changes everything below it. A consumer brand told to
        justify every sentence against revenue and cost writes a procurement
        memo; a business buyer given sensory storytelling gets nothing they can
        take to their boss. There is no neutral setting that serves both.
      */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Store className="h-4 w-4 text-primary" /> Who buys from you?
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {MARKET_MODE_OPTIONS.map((option) => {
              const on = marketMode === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={!canManage}
                  aria-pressed={on}
                  onClick={() => setMarketMode(option.id)}
                  className={cn(
                    'rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                    on
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:bg-muted',
                  )}
                >
                  <p
                    className={cn(
                      'text-sm font-medium',
                      on ? 'text-primary' : 'text-foreground',
                    )}
                  >
                    {option.label}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {option.blurb}
                  </p>
                </button>
              );
            })}
          </div>
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {consumer
              ? 'Aura will write about the experience — how it tastes, looks and feels — and end with one human ask. It will not try to justify anything as a business case.'
              : 'Aura will lead with the business consequence and tie claims to revenue, cost, risk or time.'}{' '}
            Selling to both? Keep them in separate workspaces so neither voice
            gets watered down.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-primary" /> Who are you trying to
            reach?
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="audience" className="sr-only">
            Your audience
          </Label>
          <Textarea
            id="audience"
            rows={4}
            value={audience}
            disabled={!canManage}
            onChange={(e) => setAudience(e.target.value)}
            placeholder={audiencePlaceholder}
          />
          <p className="text-xs text-muted-foreground">
            {audienceHelp}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Target className="h-4 w-4 text-primary" /> What do you want to
            happen?
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="goals" className="sr-only">
            Your goals
          </Label>
          <Textarea
            id="goals"
            rows={3}
            value={goals}
            disabled={!canManage}
            onChange={(e) => setGoals(e.target.value)}
            placeholder={goalsPlaceholder}
          />
          <p className="text-xs text-muted-foreground">
            This steers what Aura writes about and what it asks readers to do.
            It never appears in a post — your objective is not your
            reader&apos;s concern.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone className="h-4 w-4 text-primary" /> Where do you publish?
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {CONTENT_CHANNELS.map((channel) => {
              const on = channels.includes(channel);
              return (
                <button
                  key={channel}
                  type="button"
                  disabled={!canManage}
                  aria-pressed={on}
                  onClick={() => toggleChannel(channel)}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                    on
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {channel}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Used to pre-fill your monthly plan. You can still change channels on
            any individual plan.
          </p>
        </CardContent>
      </Card>

      {canManage ? (
        <Button onClick={save} loading={saving}>
          Save audience &amp; goals
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          Your role can view this but not change it.
        </p>
      )}
    </div>
  );
}
