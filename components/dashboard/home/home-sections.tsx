import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  AlertCircle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  CircleDot,
  Minus,
  Sparkles,
  Telescope,
  TrendingUp,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  closesIn,
  type ActivityItem,
  type HomeOpportunity,
  type WaitingItem,
  type ResultTile,
} from '@/lib/aura-home';
import type { WhatMatters } from '@/lib/what-matters';

/**
 * The sections of Aura Home (lib/aura-home.ts). Server components: nothing
 * here needs the browser except Aura Suggests, which has its own component.
 */

export function HomeSection({
  id,
  icon: Icon,
  title,
  hint,
  link,
  children,
  className,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  hint?: string;
  link?: { label: string; href: string };
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn('space-y-3', className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2
            id={`${id}-title`}
            className="flex items-center gap-1.5 text-base font-semibold text-foreground"
          >
            <Icon className="h-4 w-4 text-primary" aria-hidden /> {title}
          </h2>
          {hint && (
            <span className="text-xs text-muted-foreground">{hint}</span>
          )}
        </div>
        {link && (
          <Link
            href={link.href}
            className="text-sm text-primary hover:underline"
          >
            {link.label}
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------

const STATE_HINT: Record<WhatMatters['state'], string | null> = {
  ready: null,
  limited: 'Based on limited information',
  quiet: null,
  insufficient: 'Not enough information yet',
};

export function WhatMattersNow({
  data,
  waiting,
}: {
  data: WhatMatters | null;
  waiting: WaitingItem[];
}) {
  return (
    <HomeSection
      id="matters"
      icon={CircleDot}
      title="What matters now"
      hint={data ? (STATE_HINT[data.state] ?? undefined) : undefined}
    >
      <Card>
        <CardContent className="space-y-4 p-4 sm:p-5">
          {!data ? (
            <p className="text-sm text-muted-foreground">
              Aura couldn’t load the current picture just now. Refresh in a
              moment.
            </p>
          ) : (
            <>
              <p
                className={cn(
                  'text-sm',
                  data.state === 'ready' || data.state === 'limited'
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                {data.state === 'quiet' && (
                  <CheckCircle2
                    className="mr-1.5 inline h-4 w-4 align-text-bottom text-primary"
                    aria-hidden
                  />
                )}
                {data.summary}
              </p>

              {data.items.length > 0 && (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {data.items.map((m) => (
                    <li key={m.key} className="space-y-1.5 p-3">
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <Badge
                          variant={
                            m.kind === 'opportunity' ? 'default' : 'muted'
                          }
                        >
                          {m.kind === 'opportunity' ? 'Opportunity' : 'Change'}
                        </Badge>
                        {m.urgency && (
                          <Badge variant="warning">{m.urgency}</Badge>
                        )}
                        <span className="text-muted-foreground">
                          {m.source}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-foreground">
                        {m.title}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        <span className="font-medium text-foreground/80">
                          Why it matters:
                        </span>{' '}
                        {m.why}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1',
                            m.confidence.weak
                              ? '[color:hsl(38_92%_35%)] dark:[color:hsl(var(--warning))]'
                              : 'text-muted-foreground',
                          )}
                        >
                          {m.confidence.weak && (
                            <AlertCircle className="h-3.5 w-3.5" aria-hidden />
                          )}
                          {m.confidence.label}
                        </span>
                        <Link
                          href={m.href}
                          className="text-primary hover:underline"
                        >
                          {m.kind === 'opportunity'
                            ? 'Open the opportunity'
                            : 'See where this came from'}
                        </Link>
                        {m.related && (
                          <Link
                            href={m.related.href}
                            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                          >
                            <Sparkles className="h-3 w-3" aria-hidden />
                            {m.related.label}
                          </Link>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {data.gaps.length > 0 && data.state !== 'ready' && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground">
                    {data.state === 'insufficient'
                      ? 'To tell you what matters, Aura needs:'
                      : 'Aura could say more with:'}
                  </p>
                  <ul className="space-y-1">
                    {data.gaps.map((g) => (
                      <li
                        key={g.key}
                        className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
                      >
                        <span>{g.text}</span>
                        <Link
                          href={g.action.href}
                          className="font-medium text-primary hover:underline"
                        >
                          {g.action.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {data.basis && (
                <p className="text-xs text-muted-foreground">{data.basis}</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {waiting.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs font-medium text-muted-foreground">
            Waiting on you:
          </span>
          {waiting.map((w) => (
            <Link
              key={w.key}
              href={w.href}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-foreground transition-colors hover:border-primary/50"
            >
              {w.title}
              <span className="font-medium text-primary">{w.action}</span>
              <ArrowRight className="h-3 w-3 text-primary" aria-hidden />
            </Link>
          ))}
        </div>
      )}
    </HomeSection>
  );
}

// ---------------------------------------------------------------------------

export function ActiveOpportunities({
  items,
  total,
}: {
  items: HomeOpportunity[];
  total: number;
}) {
  return (
    <HomeSection
      id="opportunities"
      icon={Telescope}
      title="Active opportunities"
      link={{
        label: total > 0 ? `All opportunities (${total})` : 'Opportunities',
        href: '/dashboard/opportunities',
      }}
    >
      {items.length === 0 ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            No open opportunities. Aura looks for them in your market trends,
            competitors and results, and lists them here when it finds one.
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {items.map((o) => {
            const closes = closesIn(o.daysLeft);
            return (
              <li key={o.id}>
                <Link
                  href={`/dashboard/opportunities?focus=${o.id}`}
                  className="block rounded-md border border-border bg-card p-3 transition-colors hover:border-primary/50"
                >
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <Badge variant="muted">{o.typeLabel}</Badge>
                    {closes && (
                      <Badge variant={o.daysLeft! <= 3 ? 'warning' : 'outline'}>
                        {closes}
                      </Badge>
                    )}
                    {o.status === 'RECOMMENDED' && (
                      <span className="inline-flex items-center gap-1 text-primary">
                        <Sparkles className="h-3 w-3" aria-hidden /> Aura has a
                        suggestion
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-sm font-medium text-foreground">
                    {o.title}
                  </p>
                  {o.why && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {o.why}
                    </p>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </HomeSection>
  );
}

// ---------------------------------------------------------------------------

const CHANGE_ICON = {
  up: ArrowUpRight,
  down: ArrowDownRight,
  flat: Minus,
} as const;

export function ResultsSummary({ tiles }: { tiles: ResultTile[] }) {
  return (
    <HomeSection
      id="results"
      icon={TrendingUp}
      title="Results"
      hint="This week, compared with last."
      link={{ label: 'See what worked', href: '/dashboard/analytics' }}
    >
      <div className="grid grid-cols-2 gap-3">
        {tiles.map((t) => {
          const Icon = t.change ? CHANGE_ICON[t.change.direction] : null;
          return (
            <Link
              key={t.key}
              href={t.href}
              className="rounded-md border border-border bg-card p-3 transition-colors hover:border-primary/50"
            >
              <p className="text-xs text-muted-foreground">{t.label}</p>
              <p className="mt-0.5 text-xl font-semibold text-foreground">
                {t.value}
              </p>
              {t.change && Icon && (
                <p
                  className={cn(
                    'mt-0.5 inline-flex items-center gap-0.5 text-xs font-medium',
                    t.change.direction === 'up' &&
                      'text-success [color:hsl(var(--success))]',
                    t.change.direction === 'down' &&
                      '[color:hsl(var(--destructive))]',
                    t.change.direction === 'flat' && 'text-muted-foreground',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden /> {t.change.text}
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">{t.note}</p>
            </Link>
          );
        })}
      </div>
    </HomeSection>
  );
}

// ---------------------------------------------------------------------------

export function RecentActivity({ items }: { items: ActivityItem[] }) {
  return (
    <HomeSection
      id="activity"
      icon={Activity}
      title="Recent activity"
      hint="The last two weeks."
    >
      {items.length === 0 ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            Nothing yet. What Aura and your team do — suggestions, posts,
            opportunities, decisions — will show up here.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {items.map((a) => {
                const line = (
                  <span className="text-sm text-foreground">
                    <span
                      className={cn('font-medium', a.byAura && 'text-primary')}
                    >
                      {a.by}
                    </span>{' '}
                    {a.text}
                  </span>
                );
                return (
                  <li
                    key={a.key}
                    className="flex items-start justify-between gap-3 px-4 py-2.5"
                  >
                    {a.href ? (
                      <Link href={a.href} className="min-w-0 hover:underline">
                        {line}
                      </Link>
                    ) : (
                      <span className="min-w-0">{line}</span>
                    )}
                    <time
                      dateTime={a.at}
                      className="shrink-0 text-xs text-muted-foreground"
                    >
                      {a.when}
                    </time>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </HomeSection>
  );
}
