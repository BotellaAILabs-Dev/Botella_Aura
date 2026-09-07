'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Sparkles,
  RefreshCw,
  CalendarDays,
  Swords,
  Lightbulb,
  Gauge,
  ArrowRight,
  ImageIcon,
  Inbox,
  Info,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from '@/components/ui/toaster';
import { CONTENT_TYPE_LABELS, CONTENT_STATUS_LABELS } from '@/lib/content-ui';
import { platformSpec, type SocialPlatformKey } from '@/lib/platforms';
import type {
  BriefingPayload,
  BriefingActivity,
} from '@/lib/validations/briefing';
import type { ContentTypeKey } from '@/lib/validations/content';
import { DATE_LOCALE } from '@/lib/dates';
import { LocalTime } from '@/components/ui/local-time';

/**
 * The weekly briefing, as a person reads it.
 *
 * Ordering is the whole design: what Aura DID, then what NEEDS YOU, then the
 * week ahead, then context. A dashboard leads with numbers; an employee leads
 * with work. Scores are near the bottom on purpose — they are the least
 * actionable thing on the page.
 */
interface Props {
  briefingId: string;
  payload: BriefingPayload;
  activity: BriefingActivity;
  weekStart: string;
  isCurrentWeek: boolean;
  status: 'WORKING' | 'READY' | 'FAILED';
  error: string | null;
  generatedAt: string;
  canRun: boolean;
}

export function BriefingView({
  payload,
  activity,
  weekStart,
  isCurrentWeek,
  status,
  error,
  generatedAt,
  canRun,
}: Props) {
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
      const data = (await res.json()) as { activity?: BriefingActivity };
      const wrote = data.activity?.draftsWritten ?? 0;
      toast.success(
        wrote > 0
          ? `Wrote ${wrote} post${wrote === 1 ? '' : 's'}.`
          : 'Briefing refreshed.',
      );
      router.refresh();
    } finally {
      setRunning(false);
    }
  }

  const weekLabel = new Date(weekStart).toLocaleDateString(DATE_LOCALE, {
    month: 'long',
    day: 'numeric',
    // weekStart is UTC midnight (startOfIsoWeekUTC), so it must be read back
    // in UTC. Without this a viewer behind UTC sees the previous day and the
    // briefing is labelled a day early.
    timeZone: 'UTC',
  });

  return (
    <div className="space-y-5">
      {/* ---- What Aura did ------------------------------------------- */}
      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="rounded-md bg-primary/10 p-2">
                <Sparkles className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-foreground">
                  {payload.headline || 'Your week'}
                </h1>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {payload.summary}
                </p>
              </div>
            </div>
            {canRun && (
              <Button
                variant="outline"
                size="sm"
                onClick={runNow}
                loading={running}
                disabled={status === 'WORKING'}
              >
                <RefreshCw className="h-4 w-4" /> Catch me up
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
            <Badge variant={isCurrentWeek ? 'default' : 'muted'}>
              Week of {weekLabel}
            </Badge>
            {!isCurrentWeek && (
              <span>
                This is last week&apos;s briefing — a new one is produced Monday.
              </span>
            )}
            {activity.draftsWritten > 0 && (
              <span>
                · Aura wrote {activity.draftsWritten} post
                {activity.draftsWritten === 1 ? '' : 's'}
                {activity.graphicsGenerated > 0 &&
                  ` and made ${activity.graphicsGenerated} graphic${activity.graphicsGenerated === 1 ? '' : 's'}`}
              </span>
            )}
            <span>· Updated <LocalTime iso={generatedAt} /></span>
          </div>

          {status === 'WORKING' && (
            <p className="rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
              Aura is still working on this week. Refresh in a moment.
            </p>
          )}
          {status === 'FAILED' && error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ---- What needs you ------------------------------------------- */}
      {payload.attention.length > 0 && (
        <Section icon={Inbox} title="Needs you">
          <div className="grid gap-2 sm:grid-cols-2">
            {payload.attention.map((a) => (
              <Link
                key={a.label}
                href={a.href}
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2.5 text-sm transition-colors hover:border-primary/50"
              >
                <span className="text-foreground">{a.label}</span>
                <span className="flex items-center gap-2">
                  <Badge>{a.count}</Badge>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                </span>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {/* ---- Content Aura already wrote -------------------------------- */}
      {payload.readyContent.length > 0 && (
        <Section
          icon={Sparkles}
          title="Ready for you"
          hint="Written by Aura. Nothing publishes until you approve it."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {payload.readyContent.slice(0, 6).map((item) => (
              <Link
                key={item.draftId}
                href={`/dashboard/content/${item.draftId}`}
                className="flex gap-3 rounded-lg border border-border bg-card p-3 transition-shadow hover:shadow-sm"
              >
                {item.graphicUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.graphicUrl}
                    alt=""
                    className="h-16 w-16 shrink-0 rounded-md object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground">
                    <ImageIcon className="h-4 w-4" />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <Badge variant="muted">
                      {platformSpec(item.platform as SocialPlatformKey).label}
                    </Badge>
                    <Badge variant="outline">
                      {CONTENT_STATUS_LABELS[
                        item.status as keyof typeof CONTENT_STATUS_LABELS
                      ] ?? item.status}
                    </Badge>
                  </div>
                  <p className="line-clamp-2 text-sm text-foreground">
                    {item.snippet || item.title}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {/* ---- The week ahead -------------------------------------------- */}
      {payload.calendar.length > 0 && (
        <Section icon={CalendarDays} title="This week" hint="Your content calendar.">
          <div className="space-y-1.5">
            {payload.calendar.map((item, i) => (
              <CalendarRow key={`${item.date}-${i}`} item={item} />
            ))}
          </div>
        </Section>
      )}

      {/* ---- Competitors ------------------------------------------------ */}
      {payload.competitorMoves.length > 0 && (
        <Section icon={Swords} title="Competitor moves">
          <div className="space-y-2">
            {payload.competitorMoves.slice(0, 5).map((move, i) => (
              <div key={i} className="rounded-md border border-border bg-card p-3">
                <p className="text-sm font-medium text-foreground">
                  {move.competitor}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">{move.summary}</p>
                {move.takeaway && (
                  <p className="mt-1.5 text-xs text-foreground/80">
                    <span className="font-medium">What it means:</span>{' '}
                    {move.takeaway}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ---- Recommendations -------------------------------------------- */}
      {payload.recommendations.length > 0 && (
        <Section icon={Lightbulb} title="What to do next">
          <div className="space-y-2">
            {payload.recommendations.slice(0, 5).map((rec, i) => (
              <Link
                key={i}
                href={rec.href}
                className="block rounded-md border border-border bg-card p-3 transition-colors hover:border-primary/50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {rec.title}
                    </p>
                    {rec.why && (
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {rec.why}
                      </p>
                    )}
                  </div>
                  {rec.priority === 'high' && <Badge variant="warning">Now</Badge>}
                </div>
                <span className="mt-1.5 inline-flex items-center gap-1 text-xs text-primary">
                  {rec.action} <ArrowRight className="h-3 w-3" />
                </span>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {/* ---- Numbers, last: least actionable thing on the page ---------- */}
      {payload.insights.length > 0 && (
        <Section icon={Gauge} title="Business insights">
          <div className="grid gap-3 sm:grid-cols-3">
            {payload.insights.map((insight, i) => (
              <div key={i} className="rounded-md border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground">{insight.label}</p>
                <p className="mt-0.5 text-xl font-semibold text-foreground">
                  {insight.value}
                </p>
                {insight.note && (
                  <p className="mt-1 text-xs text-muted-foreground">{insight.note}</p>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ---- Honest gaps ------------------------------------------------ */}
      {(payload.coverage.skipped.length > 0 || activity.skipped.length > 0) && (
        <Card>
          <CardContent className="space-y-1.5 p-4">
            <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <Info className="h-3.5 w-3.5" /> What Aura could not do this week
            </p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {activity.skipped.map((s, i) => (
                <li key={`a${i}`}>· {s}</li>
              ))}
              {payload.coverage.skipped.map((s, i) => (
                <li key={`c${i}`}>· {s.reason}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: typeof Inbox;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Icon className="h-4 w-4 text-muted-foreground" /> {title}
        </h2>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function CalendarRow({
  item,
}: {
  item: BriefingPayload['calendar'][number];
}) {
  const day = new Date(`${item.date}T00:00:00.000Z`).toLocaleDateString(DATE_LOCALE, {
    weekday: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

  const row = (
    <div className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{day}</span>
      {item.graphicUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.graphicUrl}
          alt=""
          className="h-8 w-8 shrink-0 rounded object-cover"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className="h-8 w-8 shrink-0 rounded border border-dashed border-border" />
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {item.title}
      </span>
      <Badge variant="muted" className="hidden sm:inline-flex">
        {CONTENT_TYPE_LABELS[item.contentType as ContentTypeKey]}
      </Badge>
      <Badge variant={item.status === 'PLANNED' ? 'outline' : 'default'}>
        {item.status === 'PLANNED'
          ? 'Planned'
          : (CONTENT_STATUS_LABELS[
              item.status as keyof typeof CONTENT_STATUS_LABELS
            ] ?? item.status)}
      </Badge>
    </div>
  );

  // Planned-but-unwritten items have nowhere to go yet.
  return item.draftId ? (
    <Link href={`/dashboard/content/${item.draftId}`} className="block hover:opacity-90">
      {row}
    </Link>
  ) : (
    row
  );
}
