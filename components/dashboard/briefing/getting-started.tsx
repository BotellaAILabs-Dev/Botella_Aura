'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PlayCircle, CalendarDays, PenLine, Swords, Gauge } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from '@/components/ui/toaster';

/**
 * First run — before Aura has ever produced a briefing.
 *
 * This is deliberately NOT an empty state and NOT a fake briefing. It says
 * plainly what Aura will do, what it needs in order to do it well, and offers
 * to run immediately rather than making the user wait until Monday.
 */
export function GettingStarted({ canRun }: { canRun: boolean }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);

  async function runNow() {
    if (running) return;
    setRunning(true);
    try {
      const res = await fetch('/api/briefing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not run right now.');
        return;
      }
      const data = (await res.json()) as {
        activity?: { draftsWritten?: number; skipped?: string[] };
      };
      const wrote = data.activity?.draftsWritten ?? 0;
      toast.success(
        wrote > 0
          ? `Aura wrote ${wrote} post${wrote === 1 ? '' : 's'} for you.`
          : 'Briefing ready.',
      );
      router.refresh();
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="space-y-4 p-5">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Aura hasn&apos;t reported in yet
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Every Monday morning Aura writes your week&apos;s posts, makes a
              graphic for each, checks what competitors have been doing, and
              leaves it all here. Nothing publishes on its own — you approve
              everything.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: CalendarDays,
                title: 'Your week, planned',
                body: 'A dated calendar drawn from your goals and what your market is discussing.',
              },
              {
                icon: PenLine,
                title: 'Posts already written',
                body: 'In your brand voice, with a graphic attached, waiting for your approval.',
              },
              {
                icon: Swords,
                title: 'Competitor moves',
                body: 'What changed on their site and in their announcements, and what it means.',
              },
              {
                icon: Gauge,
                title: 'Business insights',
                body: 'Real numbers from what you published — never estimates.',
              },
            ].map((f) => (
              <div key={f.title} className="rounded-md border border-border p-3">
                <f.icon className="h-4 w-4 text-primary" />
                <p className="mt-2 text-sm font-medium text-foreground">
                  {f.title}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>

          {canRun && (
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <Button onClick={runNow} loading={running}>
                <PlayCircle className="h-4 w-4" /> Run Aura now
              </Button>
              <p className="text-xs text-muted-foreground">
                Takes a minute or two. You don&apos;t have to wait for Monday.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-5 text-sm">
          <p className="font-medium text-foreground">
            Aura works better with a bit of context
          </p>
          <p className="text-muted-foreground">
            None of this is required, but each one makes the weekly output
            noticeably more useful:
          </p>
          <ul className="mt-1 space-y-1.5 text-sm">
            {[
              {
                label: 'Build a monthly plan',
                href: '/dashboard/planner',
                why: 'gives Aura dated topics tied to your goals instead of guessing from trends',
              },
              {
                label: 'Add your competitors',
                href: '/dashboard/competitors',
                why: 'turns on the weekly competitor section',
              },
              {
                label: 'Add knowledge sources',
                href: '/dashboard/settings/knowledge-base',
                why: 'grounds the writing in your real products and positioning',
              },
              {
                label: 'Connect LinkedIn',
                href: '/dashboard/settings/connections',
                why: 'lets approved posts publish through the official API',
              },
            ].map((s) => (
              <li key={s.href} className="text-muted-foreground">
                <Link href={s.href} className="text-primary hover:underline">
                  {s.label}
                </Link>{' '}
                — {s.why}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
