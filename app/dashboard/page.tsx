import Link from 'next/link';
import type { Metadata } from 'next';
import {
  Linkedin,
  Radar,
  PenLine,
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
import { Badge } from '@/components/ui/badge';

export const metadata: Metadata = { title: 'Overview' };

export default async function OverviewPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  const firstName = user.name?.split(' ')[0] ?? null;

  const cards = [
    {
      icon: Linkedin,
      title: 'Connect LinkedIn',
      body: 'Link your LinkedIn to publish approved posts (official API, via the companion extension).',
      cta: 'Connect',
      sprint: 2,
    },
    {
      icon: Radar,
      title: 'Your first trend digest',
      body: 'Aura will surface what your market is talking about, every morning.',
      cta: 'Explore trends',
      sprint: 2,
    },
    {
      icon: PenLine,
      title: 'Draft on-brand content',
      body: 'Generate posts and carousels tuned to your brand voice — you approve every one.',
      cta: 'Open Content Studio',
      sprint: 3,
    },
  ];

  return (
    <div>
      <PageHeader
        title={`Welcome${firstName ? `, ${firstName}` : ''} 👋`}
        description={
          active
            ? `Here's what's next for ${active.name}.`
            : "Here's what's next."
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
                  Sprint 1 sets up your foundation. As each capability ships,
                  it appears here — always behind a human approval step.
                </p>
              </div>
            </div>
            <Button asChild variant="outline">
              <Link href="/dashboard/settings">
                Review company profile <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </div>
      </Card>

      {/* Empty-state feature cards */}
      <div className="grid gap-4 md:grid-cols-3">
        {cards.map((card) => (
          <Card key={card.title} className="flex flex-col">
            <CardHeader>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <card.icon className="h-5 w-5" />
                </div>
                <Badge variant="secondary">Sprint {card.sprint}</Badge>
              </div>
              <CardTitle className="text-base">{card.title}</CardTitle>
              <CardDescription>{card.body}</CardDescription>
            </CardHeader>
            <CardContent className="mt-auto">
              <Button variant="ghost" size="sm" disabled className="px-0">
                {card.cta} <ArrowRight className="h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Trust reminder */}
      <div className="mt-6 flex items-start gap-3 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <p>
          <span className="font-medium text-foreground">
            Nothing goes live without you.
          </span>{' '}
          Every AI suggestion, approval, and publish action is logged to your
          audit trail for full transparency.
        </p>
      </div>
    </div>
  );
}
