import Link from 'next/link';
import type { Metadata } from 'next';
import {
  Linkedin,
  Radar,
  PenLine,
  Megaphone,
  Target,
  BarChart3,
  ArrowRight,
  ShieldCheck,
  Sparkles,
  CheckCircle2,
  Inbox,
} from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getDashboardSnapshot } from '@/server/services/dashboard.service';
import { PageHeader } from '@/components/dashboard/page-header';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function OverviewPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  const firstName = user.name?.split(' ')[0] ?? null;

  const snapshot = active ? await getDashboardSnapshot(active.id) : null;
  const openActions = snapshot?.actions.filter((a) => a.count > 0) ?? [];

  const cards = [
    {
      icon: Linkedin,
      title: 'Connect LinkedIn',
      body: 'Link your account so Aura can personalize content — and publish what you approve.',
      cta: 'Connect',
      href: '/dashboard/settings/connections',
    },
    {
      icon: Radar,
      title: 'AI Trend Insights',
      body: 'See what your market is talking about, with a suggested angle for each topic.',
      cta: 'Explore trends',
      href: '/dashboard/trends',
    },
    {
      icon: PenLine,
      title: 'Content Studio',
      body: 'Generate on-brand posts and carousels in your voice — you approve every one.',
      cta: 'Draft content',
      href: '/dashboard/content',
    },
    {
      icon: Megaphone,
      title: 'Campaigns',
      body: 'Turn one goal into a reviewable 30-day plan across content, outreach, and discovery.',
      cta: 'Plan a campaign',
      href: '/dashboard/campaigns',
    },
    {
      icon: Target,
      title: 'Lead Discovery',
      body: 'Find qualified prospects from public sources and draft personalized outreach.',
      cta: 'Discover leads',
      href: '/dashboard/leads',
    },
    {
      icon: BarChart3,
      title: 'Analytics',
      body: 'Track your results — engagement, outreach funnel, and a shareable weekly report.',
      cta: 'View analytics',
      href: '/dashboard/analytics',
    },
  ];

  return (
    <div>
      <PageHeader
        title={`Welcome${firstName ? `, ${firstName}` : ''} 👋`}
        description={
          active
            ? snapshot && snapshot.totalPending > 0
              ? `You have ${snapshot.totalPending} ${snapshot.totalPending === 1 ? 'item' : 'items'} that need you at ${active.name}.`
              : `Here's what's next for ${active.name}.`
            : "Here's what's next."
        }
      />

      {/* Action needed — the "what needs you now" panel, always first. */}
      {snapshot && (
        <Card className="mb-6 overflow-hidden border-primary/20">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Inbox className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-base">Action needed</CardTitle>
                <CardDescription>
                  Everything Aura drafted, waiting on your review. Nothing sends
                  without you.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {openActions.length > 0 ? (
              <ul className="divide-y divide-border rounded-md border border-border">
                {openActions.map((a) => (
                  <li key={a.key}>
                    <Link
                      href={a.href}
                      className="group flex items-center justify-between gap-3 px-3 py-3 transition-colors hover:bg-accent/50"
                    >
                      <div className="flex items-center gap-3">
                        <Badge variant="default" className="min-w-7 justify-center">
                          {a.count}
                        </Badge>
                        <div>
                          <p className="text-sm font-medium text-foreground">
                            {a.label}
                          </p>
                          <p className="text-xs text-muted-foreground">{a.detail}</p>
                        </div>
                      </div>
                      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex items-start gap-3 rounded-md border border-dashed border-border bg-muted/30 p-4">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div className="text-sm">
                  <p className="font-medium text-foreground">
                    You&apos;re all caught up.
                  </p>
                  <p className="mt-0.5 text-muted-foreground">
                    No drafts, outreach, or leads are waiting on you right now. Start
                    something new below — explore trends, draft content, or discover
                    leads.
                  </p>
                </div>
              </div>
            )}

            {snapshot.trend && (
              <Link
                href="/dashboard/trends"
                className="group mt-3 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-sm transition-colors hover:bg-accent/50"
              >
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Radar className="h-4 w-4 text-primary" />
                  <span>
                    <span className="font-medium text-foreground">Latest trend:</span>{' '}
                    {snapshot.trend.title}
                    {snapshot.trend.count > 1 && (
                      <span className="text-muted-foreground">
                        {' '}
                        · {snapshot.trend.count - 1} more
                      </span>
                    )}
                  </span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            )}
          </CardContent>
        </Card>
      )}

      {/* Feature quick-links */}
      <p className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Sparkles className="h-4 w-4 text-primary" /> Jump into a workflow
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        {cards.map((card) => (
          <Link key={card.title} href={card.href} className="group">
            <Card className="flex h-full flex-col transition-shadow group-hover:shadow-md">
              <CardHeader>
                <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <card.icon className="h-5 w-5" />
                </div>
                <CardTitle className="text-base">{card.title}</CardTitle>
                <CardDescription>{card.body}</CardDescription>
              </CardHeader>
              <CardContent className="mt-auto">
                <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
                  {card.cta} <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </span>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {/* Trust reminder */}
      <div className="mt-6 flex items-start gap-3 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <p>
          <span className="font-medium text-foreground">
            Nothing goes live without you.
          </span>{' '}
          Every AI suggestion, approval, and publish action is logged to your audit
          trail for full transparency.
        </p>
      </div>
    </div>
  );
}
