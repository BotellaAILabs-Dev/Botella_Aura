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
  type MatterItem,
  type ResultTile,
} from '@/lib/aura-home';

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

export function WhatMattersNow({ items }: { items: MatterItem[] }) {
  return (
    <HomeSection id="matters" icon={CircleDot} title="What matters now">
      {items.length === 0 ? (
        <Card>
          <CardContent className="flex items-center gap-3 p-4 text-sm">
            <CheckCircle2
              className="h-5 w-5 shrink-0 text-primary"
              aria-hidden
            />
            <span className="text-muted-foreground">
              Nothing needs you right now. Aura is keeping an eye on your
              market, competitors and results, and will flag anything that does.
            </span>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((m) => (
            <Link
              key={m.key}
              href={m.href}
              className={cn(
                'group flex flex-col justify-between gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-primary/50',
                m.tone === 'urgent' ? 'border-warning/60' : 'border-border',
              )}
            >
              <div>
                <p className="flex items-start gap-2 text-sm font-medium text-foreground">
                  {m.tone === 'urgent' && (
                    <AlertCircle
                      className="mt-0.5 h-4 w-4 shrink-0 [color:hsl(38_92%_40%)]"
                      aria-label="Time-sensitive"
                    />
                  )}
                  {m.title}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{m.detail}</p>
              </div>
              <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
                {m.action}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
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
