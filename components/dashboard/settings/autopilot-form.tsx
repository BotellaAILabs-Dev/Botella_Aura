'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Bot, ShieldCheck, AlertTriangle, Plug } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { cn } from '@/lib/utils';
import type { PublishMode } from '@/server/briefing/autopilot.service';

interface AutopilotInitial {
  enabled: boolean;
  postsPerWeek: number;
  generateGraphics: boolean;
  publishMode: PublishMode;
}

/**
 * Each mode says what will HAPPEN, not what it is called. Someone choosing
 * between these is deciding how much authority to hand over, and the only
 * honest way to present that is in terms of the outcome they will live with.
 */
const MODES: {
  id: PublishMode;
  label: string;
  detail: string;
  risk?: string;
}[] = [
  {
    id: 'review',
    label: 'Write drafts and wait for me',
    detail:
      'Aura writes the week’s posts and leaves them. You decide what goes out and when.',
  },
  {
    id: 'schedule',
    label: 'Write and put them on the calendar',
    detail:
      'Aura also picks a time for each post based on when your posts have done best. You still approve before anything publishes.',
  },
  {
    id: 'auto',
    label: 'Write, schedule and publish without me',
    detail:
      'Aura approves its own posts and publishes them at the scheduled time.',
    risk: 'Posts go out publicly without anyone reading them first. You can still edit or delete a post before its scheduled time, but not after it has published.',
  },
];

export function AutopilotForm({
  initial,
  canManage,
  hasConnectedChannel,
  maxAutoPerWeek,
}: {
  initial: AutopilotInitial;
  canManage: boolean;
  /** Auto mode does nothing without somewhere to publish to. */
  hasConnectedChannel: boolean;
  maxAutoPerWeek: number;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [postsPerWeek, setPostsPerWeek] = useState(initial.postsPerWeek);
  const [generateGraphics, setGenerateGraphics] = useState(initial.generateGraphics);
  const [publishMode, setPublishMode] = useState<PublishMode>(initial.publishMode);
  /** Auto is a two-step choice: pick it, then confirm you meant it. */
  const [confirmedAuto, setConfirmedAuto] = useState(initial.publishMode === 'auto');

  const choosingAuto = publishMode === 'auto';
  const blocked = choosingAuto && (!confirmedAuto || !hasConnectedChannel);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/company/autopilot', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, postsPerWeek, generateGraphics, publishMode }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? 'Could not save.');
        return;
      }
      toast.success(
        publishMode === 'auto'
          ? 'Saved. Aura will publish on its own from now on.'
          : 'Saved.',
      );
      router.refresh();
    } catch {
      toast.error('Could not reach the server. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4 text-primary" /> Should Aura work on its own?
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!canManage}
              onChange={(e) => setEnabled(e.target.checked)}
              className="mt-1 h-4 w-4"
            />
            <span>
              <span className="block text-sm font-medium text-foreground">
                Write my week&apos;s posts every Monday
              </span>
              <span className="block text-xs text-muted-foreground">
                Turn this off and Aura still reports on trends, competitors and
                results — it just stops writing.
              </span>
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="postsPerWeek">Posts per week</Label>
              <select
                id="postsPerWeek"
                value={postsPerWeek}
                disabled={!canManage || !enabled}
                onChange={(e) => setPostsPerWeek(Number(e.target.value))}
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm disabled:opacity-60"
              >
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? 'None' : `${n} post${n === 1 ? '' : 's'}`}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="graphics">Graphics</Label>
              <label className="flex h-9 items-center gap-2 text-sm">
                <input
                  id="graphics"
                  type="checkbox"
                  checked={generateGraphics}
                  disabled={!canManage || !enabled}
                  onChange={(e) => setGenerateGraphics(e.target.checked)}
                  className="h-4 w-4"
                />
                Make an image for each post
              </label>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" /> What happens to
            those posts?
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {MODES.map((mode) => {
            const on = publishMode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                disabled={!canManage || !enabled}
                aria-pressed={on}
                onClick={() => {
                  setPublishMode(mode.id);
                  // Re-arm the confirmation every time auto is selected afresh,
                  // so it can never be inherited from an earlier click.
                  if (mode.id === 'auto') setConfirmedAuto(false);
                }}
                className={cn(
                  'w-full rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                  on ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted',
                )}
              >
                <p
                  className={cn(
                    'text-sm font-medium',
                    on ? 'text-primary' : 'text-foreground',
                  )}
                >
                  {mode.label}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{mode.detail}</p>
              </button>
            );
          })}

          {choosingAuto && (
            <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 [color:hsl(var(--warning))]" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium text-foreground">
                    This publishes to the public without you.
                  </p>
                  <p className="text-muted-foreground">
                    {MODES.find((m) => m.id === 'auto')?.risk} Aura will publish
                    at most {maxAutoPerWeek} posts a week this way, and every one
                    is recorded in your audit log.
                  </p>
                </div>
              </div>

              {hasConnectedChannel ? (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={confirmedAuto}
                    disabled={!canManage}
                    onChange={(e) => setConfirmedAuto(e.target.checked)}
                    className="mt-0.5 h-4 w-4"
                  />
                  <span className="text-foreground">
                    I understand posts will go out publicly without my review.
                  </span>
                </label>
              ) : (
                // Saving auto with nowhere to publish would look like it was on
                // when nothing could actually happen.
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">
                    Connect a channel first — there is nowhere to publish to yet.
                  </span>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/dashboard/settings/connections">
                      <Plug className="h-4 w-4" /> Connect a channel
                    </Link>
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {canManage ? (
        <Button onClick={save} loading={saving} disabled={blocked}>
          Save settings
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          Your role can view these settings but not change them. Only someone who
          can approve posts can change what Aura does on its own.
        </p>
      )}
    </div>
  );
}
