import Link from 'next/link';
import type { Metadata } from 'next';
import { CalendarDays, PenLine, Sparkles } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import {
  getLatestBriefing,
  toBriefingView,
} from '@/server/briefing/briefing.service';
import { getAuraHome } from '@/server/home/home.service';
import { getOnboardingState } from '@/server/onboarding/checklist.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BriefingView } from '@/components/dashboard/briefing/briefing-view';
import { GettingStarted } from '@/components/dashboard/briefing/getting-started';
import { SetupChecklist } from '@/components/dashboard/onboarding/setup-checklist';
import { AuraSuggests } from '@/components/dashboard/suggestions/aura-suggests';
import {
  ActiveOpportunities,
  HomeSection,
  RecentActivity,
  ResultsSummary,
  WhatMattersNow,
} from '@/components/dashboard/home/home-sections';

export const metadata: Metadata = { title: 'Home' };
export const dynamic = 'force-dynamic';

/**
 * Aura Home — recommendation-led, not a dashboard of metrics.
 *
 * It answers three questions, in this order:
 *
 *   What matters right now?    What matters now — the few things that need a
 *                              person, each with the action that deals with it
 *   What does Aura suggest?    Aura Suggests — the top suggestions, with what,
 *                              why, the evidence and the next step
 *   What happened recently?    Recent activity — what Aura and the team did
 *
 * with the open opportunities and a results summary (compared with last
 * week, not bare numbers) between them, and the weekly briefing ("This week":
 * what Aura wrote, the calendar, competitor moves) below. Everything above
 * the briefing is live (server/home/home.service.ts).
 *
 * Every tool stays one click away in the sidebar and under "Everything else".
 */
export default async function HomePage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  const firstName = user.name?.split(' ')[0] ?? null;

  if (!active) {
    return (
      <div>
        <PageHeader
          title={`Welcome${firstName ? `, ${firstName}` : ''}`}
          description="Create a workspace to get started."
        />
      </div>
    );
  }

  const [row, membership, setup, home] = await Promise.all([
    getLatestBriefing(active.id),
    getMembership(user.id, active.id),
    getOnboardingState(active.id),
    getAuraHome(active.id),
  ]);
  const canRun = membership ? can(membership.role, 'content:create') : false;
  const canDecide = membership ? can(membership.role, 'company:update') : false;
  const briefing = row ? toBriefingView(row) : null;

  return (
    <div>
      <PageHeader
        title={`Good to see you${firstName ? `, ${firstName}` : ''}`}
        description={`Here’s what matters for ${active.name} right now.`}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/content">
              <PenLine className="h-4 w-4" /> Content Studio
            </Link>
          </Button>
        }
      />

      <div className="space-y-8">
        {/* Setup is the next action until it is done: in full before the
            first briefing, as a strip after. It goes away when finished. */}
        {!setup.finished && (
          <SetupChecklist
            state={setup}
            variant={briefing ? 'compact' : undefined}
          />
        )}

        <WhatMattersNow data={home.whatMatters} waiting={home.waiting} />

        <HomeSection
          id="suggests"
          icon={Sparkles}
          title="Aura Suggests"
          hint="What Aura thinks you should do next, and why."
          link={{
            label:
              home.suggestionCount > home.suggestions.length
                ? `See all (${home.suggestionCount})`
                : 'See all',
            href: '/dashboard/suggestions',
          }}
        >
          {home.suggestions.length > 0 ? (
            <AuraSuggests
              suggestions={home.suggestions}
              canAct={canDecide}
              canRecord={canRun}
              surface="home"
              compact
            />
          ) : (
            <Card>
              <CardContent className="p-4 text-sm text-muted-foreground">
                No new suggestions right now
                {home.accepted.length > 0
                  ? ` — you’ve answered them all, and ${home.accepted.length === 1 ? 'one is' : `${home.accepted.length} are`} waiting for a next step.`
                  : '.'}{' '}
                Aura suggests something when it spots an opportunity worth
                acting on.{' '}
                <Link
                  href="/dashboard/opportunities"
                  className="text-primary hover:underline"
                >
                  See opportunities
                </Link>
              </CardContent>
            </Card>
          )}
        </HomeSection>

        <div className="grid gap-8 lg:grid-cols-2">
          <ActiveOpportunities
            items={home.opportunities}
            total={home.opportunityCount}
          />
          {home.results && <ResultsSummary tiles={home.results} />}
        </div>

        <HomeSection
          id="week"
          icon={CalendarDays}
          title="This week"
          hint="Aura’s weekly briefing: what it wrote, your calendar, competitor moves."
        >
          {briefing ? (
            <BriefingView
              briefingId={briefing.id}
              payload={briefing.payload}
              activity={briefing.activity}
              weekStart={briefing.weekStart}
              isCurrentWeek={briefing.isCurrentWeek}
              status={briefing.status}
              error={briefing.error}
              generatedAt={briefing.generatedAt}
              canRun={canRun}
            />
          ) : (
            <GettingStarted canRun={canRun} />
          )}
        </HomeSection>

        <RecentActivity items={home.activity} />

        {/* Every tool is still reachable directly. */}
        <Card>
          <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4 text-sm">
            <span className="text-muted-foreground">Everything else:</span>
            {[
              { label: 'Content Studio', href: '/dashboard/content' },
              { label: 'Content plan', href: '/dashboard/planner' },
              { label: 'Market trends', href: '/dashboard/trends' },
              { label: 'Competitors', href: '/dashboard/competitors' },
              { label: 'Marketing health', href: '/dashboard/intelligence' },
              { label: 'Campaign ideas', href: '/dashboard/advisor' },
              { label: 'Leads', href: '/dashboard/leads' },
              { label: 'Results', href: '/dashboard/analytics' },
            ].map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-primary hover:underline"
              >
                {l.label}
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
