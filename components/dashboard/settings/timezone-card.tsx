'use client';

import { useMemo, useState } from 'react';
import { Globe2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toaster';
import { commonTimeZones, formatInZone, offsetLabel } from '@/lib/timezone';

/**
 * The workspace timezone: scheduled posts are picked and shown in it, whatever
 * the timezone of the person looking (Scheduling & Timezone Handling).
 */
export function TimezoneCard({ initial, canEdit }: { initial: string; canEdit: boolean }) {
  const zones = useMemo(() => commonTimeZones(), []);
  const [saved, setSaved] = useState(initial);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const browser = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : null;

  async function save() {
    setBusy(true);
    try {
      const res = await fetch('/api/company/timezone', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: value }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; scheduledPostsKept?: number };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not change the timezone.');
        return;
      }
      setSaved(value);
      toast.success(
        body.scheduledPostsKept
          ? `Timezone saved. ${body.scheduledPostsKept} scheduled post(s) keep their exact time and are now shown in ${value}.`
          : 'Timezone saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="mb-1 flex items-center gap-2">
          <Globe2 className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">Workspace timezone</CardTitle>
        </div>
        <CardDescription>
          Posts are scheduled and shown in this timezone, for everyone in the workspace. Now:{' '}
          <span suppressHydrationWarning>{formatInZone(new Date(), saved)}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <label htmlFor="workspace-timezone" className="sr-only">
          Workspace timezone
        </label>
        <select
          id="workspace-timezone"
          value={value}
          disabled={!canEdit || busy}
          onChange={(e) => setValue(e.target.value)}
          className="h-9 min-w-0 max-w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          {(zones.includes(value) ? zones : [value, ...zones]).map((z) => (
            <option key={z} value={z}>
              {z} ({offsetLabel(new Date(), z)})
            </option>
          ))}
        </select>
        {canEdit ? (
          <Button size="sm" onClick={save} disabled={busy || value === saved} loading={busy}>
            Save
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">Only owners and admins can change it.</span>
        )}
        {canEdit && browser && browser !== value ? (
          <Button size="sm" variant="ghost" onClick={() => setValue(browser)} disabled={busy}>
            Use my timezone ({browser})
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
