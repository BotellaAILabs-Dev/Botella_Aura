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
} from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { PageHeader } from '@/components/dashboard/page-header';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Overview' };

export default async function OverviewPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  const firstName = user.name?.split(' ')[0] ?? null;

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
          active ? `Here's what's next for ${active.name}.` : "Here's what's next."
        }
      />

      {/* Hero / value banner */}
      <Card className="mb-6 overflow-hidden border-primary/20">
        <div className="aura-gradient">
          <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  Your workspace is ready
                </h2>
                <p className="mt-0.5 max-w-xl text-sm text-muted-foreground">
                  Everything below is ready to use — always behind a human approval
                  step. Start by connecting LinkedIn or drafting your first content.
                </p>
              </div>
            </div>
            <Button asChild variant="outline">
              <Link href="/dashboard/settings">
                Company profile <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </div>
      </Card>

      {/* Feature quick-links */}
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
