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

type Sources = { crunchbase: boolean; github: boolean; jobs: boolean; news: boolean };

export interface OutreachConfigValue {
  industries: string[];
  roleTitles: string[];
  companyStages: string[];
  enabledSources: Sources;
}

const toText = (arr: string[]) => arr.join(', ');
const toList = (text: string) =>
  text.split(',').map((s) => s.trim()).filter(Boolean);

export function OutreachConfigForm({
  initial,
  canEdit,
}: {
  initial: OutreachConfigValue;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [industries, setIndustries] = useState(toText(initial.industries));
  const [roleTitles, setRoleTitles] = useState(toText(initial.roleTitles));
  const [companyStages, setCompanyStages] = useState(toText(initial.companyStages));
  const [sources, setSources] = useState<Sources>(initial.enabledSources);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/outreach/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          industries: toList(industries),
          roleTitles: toList(roleTitles),
          companyStages: toList(companyStages),
          enabledSources: sources,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not save.');
        return;
      }
      toast.success('Targeting saved.');
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const sourceRows: { key: keyof Sources; label: string; note: string }[] = [
    { key: 'github', label: 'GitHub', note: 'Public repo activity (keyless)' },
    { key: 'news', label: 'News / RSS', note: 'Funding, launches, leadership (keyless)' },
    { key: 'jobs', label: 'Hiring signals', note: 'Public job/news RSS (keyless)' },
    { key: 'crunchbase', label: 'Crunchbase', note: 'Funding data — needs CRUNCHBASE_API_KEY' },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Targeting</CardTitle>
        <CardDescription>
          Who to look for, and which public sources to scan. All sources are
          legitimate/official — no LinkedIn scraping.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <Label>Industries / keywords</Label>
          <Input
            disabled={!canEdit}
            value={industries}
            onChange={(e) => setIndustries(e.target.value)}
            placeholder="devtools, fintech, developer experience"
          />
          <p className="text-xs text-muted-foreground">Comma-separated.</p>
        </div>
        <div className="space-y-1.5">
          <Label>Role titles to reach</Label>
          <Input
            disabled={!canEdit}
            value={roleTitles}
            onChange={(e) => setRoleTitles(e.target.value)}
            placeholder="Head of Marketing, VP Growth, Founder"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Company size / stage</Label>
          <Input
            disabled={!canEdit}
            value={companyStages}
            onChange={(e) => setCompanyStages(e.target.value)}
            placeholder="seed, series a, 50-200"
          />
        </div>

        <div className="space-y-2">
          <Label>Signal sources</Label>
          <div className="space-y-2">
            {sourceRows.map((row) => (
              <label
                key={row.key}
                className="flex items-center justify-between rounded-md border border-border p-3"
              >
                <span>
                  <span className="text-sm font-medium">{row.label}</span>
                  <span className="block text-xs text-muted-foreground">{row.note}</span>
                </span>
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={sources[row.key]}
                  onChange={(e) =>
                    setSources({ ...sources, [row.key]: e.target.checked })
                  }
                  className="h-4 w-4 accent-[hsl(var(--primary))]"
                />
              </label>
            ))}
          </div>
        </div>
      </CardContent>
      {canEdit && (
        <CardFooter className="justify-end">
          <Button onClick={save} loading={saving}>
            Save targeting
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
