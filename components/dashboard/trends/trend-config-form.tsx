'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { TagInput } from '@/components/ui/tag-input';
import { updateTrendConfigSchema } from '@/lib/validations/trends';
import type { TrendSourceId } from '@/server/trends/types';

interface TrendConfigValue {
  keywords: string[];
  subreddits: string[];
  rssFeeds: string[];
  competitorNames: string[];
  enabledSources: Record<'reddit' | 'hackernews' | 'news' | 'twitter', boolean>;
  geoCountry: string;
  geoRegion: string;
  geoCity: string;
  language: string;
  timeRangeDays: number;
}

const SOURCES: Array<{ id: TrendSourceId; label: string; note: string }> = [
  { id: 'hackernews', label: 'Hacker News', note: 'No key needed' },
  { id: 'news', label: 'Google News (RSS)', note: 'No key needed' },
  { id: 'reddit', label: 'Reddit', note: 'No key needed (public RSS)' },
  { id: 'twitter', label: 'X / Twitter', note: 'Optional — needs bearer token' },
];

const COUNTRIES: Array<{ code: string; name: string }> = [
  { code: '', name: 'Global (any country)' },
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'IN', name: 'India' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'ES', name: 'Spain' },
  { code: 'BR', name: 'Brazil' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'SG', name: 'Singapore' },
];
const LANGUAGES: Array<{ code: string; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'hi', name: 'Hindi' },
];
const TIME_RANGES: Array<{ days: number; label: string }> = [
  { days: 1, label: 'Last 24 hours' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
];

export function TrendConfigForm({ initial }: { initial: TrendConfigValue }) {
  const router = useRouter();
  const [value, setValue] = useState<TrendConfigValue>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof TrendConfigValue>(key: K, v: TrendConfigValue[K]) {
    setValue((prev) => ({ ...prev, [key]: v }));
  }
  function toggleSource(id: TrendSourceId) {
    setValue((prev) => ({
      ...prev,
      enabledSources: {
        ...prev.enabledSources,
        [id]: !prev.enabledSources[id],
      },
    }));
  }

  async function save() {
    setError(null);
    const parsed = updateTrendConfigSchema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please check your inputs.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/trends/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not save.');
        return;
      }
      toast.success('Trend sources saved.');
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>What Aura monitors</CardTitle>
        <CardDescription>
          Keywords, subreddits, and competitors drive your daily digest. We
          suggested some starters from your onboarding — edit freely.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="keywords">Keywords &amp; topics</Label>
          <TagInput
            id="keywords"
            value={value.keywords}
            onChange={(v) => set('keywords', v)}
            placeholder="Type a topic and press Enter (e.g. AI marketing)"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="subreddits">Subreddits</Label>
          <TagInput
            id="subreddits"
            value={value.subreddits}
            onChange={(v) => set('subreddits', v)}
            transform={(raw) => raw.replace(/^\/?r\//i, '')}
            placeholder="e.g. SaaS, marketing"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="competitors">Competitors to watch</Label>
          <TagInput
            id="competitors"
            value={value.competitorNames}
            onChange={(v) => set('competitorNames', v)}
            placeholder="Competitor names (also used in Sprint 5)"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="feeds">Extra RSS feeds</Label>
          <TagInput
            id="feeds"
            value={value.rssFeeds}
            onChange={(v) => set('rssFeeds', v)}
            placeholder="https://example.com/feed.xml"
          />
        </div>

        {/* Geo & scope filters — make insights local/regional */}
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
          <Label>Location &amp; scope</Label>
          <p className="-mt-1 text-xs text-muted-foreground">
            Focus trends on a country, region, and time window for local marketing.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="country" className="text-xs">Country</Label>
              <select
                id="country"
                value={value.geoCountry}
                onChange={(e) => set('geoCountry', e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="language" className="text-xs">Language</Label>
              <select
                id="language"
                value={value.language}
                onChange={(e) => set('language', e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="region" className="text-xs">Region / State (optional)</Label>
              <Input
                id="region"
                value={value.geoRegion}
                onChange={(e) => set('geoRegion', e.target.value)}
                placeholder="e.g. California"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="city" className="text-xs">City (optional)</Label>
              <Input
                id="city"
                value={value.geoCity}
                onChange={(e) => set('geoCity', e.target.value)}
                placeholder="e.g. San Francisco"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timeRange" className="text-xs">Time range</Label>
              <select
                id="timeRange"
                value={value.timeRangeDays}
                onChange={(e) => set('timeRangeDays', Number(e.target.value))}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {TIME_RANGES.map((t) => (
                  <option key={t.days} value={t.days}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Sources</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {SOURCES.map((s) => {
              const on = value.enabledSources[s.id];
              return (
                <button
                  key={s.id}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  onClick={() => toggleSource(s.id)}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                >
                  <span>
                    <span className="font-medium text-foreground">{s.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {s.note}
                    </span>
                  </span>
                  <span
                    className={
                      'relative h-5 w-9 shrink-0 rounded-full transition-colors ' +
                      (on ? 'bg-primary' : 'bg-input')
                    }
                  >
                    <span
                      className={
                        'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ' +
                        (on ? 'left-0.5 translate-x-4' : 'left-0.5')
                      }
                    />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </CardContent>
      <CardFooter className="justify-end">
        <Button onClick={save} loading={saving}>
          Save trend sources
        </Button>
      </CardFooter>
    </Card>
  );
}
