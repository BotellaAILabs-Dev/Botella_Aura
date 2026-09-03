import Link from 'next/link';
import type { Metadata } from 'next';
import { Sparkles } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import {
  getLatestBriefing,
  toBriefingView,
} from '@/server/briefing/briefing.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BriefingView } from '@/components/dashboard/briefing/briefing-view';
import { GettingStarted } from '@/components/dashboard/briefing/getting-started';
import { SetupChecklist } from '@/components/dashboard/onboarding/setup-checklist';
import { getOnboardingState } from '@/server/onboarding/checklist.service';

export const metadata: Metadata = { title: 'Dashboard' };

/**
 * The home page IS the briefing.
 *
 * It used to be a grid of feature cards linking to twelve separate AI tools —
 * which made Aura read as a toolbox you operate rather than something that
 * works for you. Now it opens with what Aura did this week, what needs a human,
 * the calendar, competitor movement and recommendations; the tools are still
 * there in the sidebar, as drill-downs from the work rather than as the
 * starting point.
 *
 * The fallback matters as much as the main path. A workspace with no briefing
 * yet (brand new, or the Monday job has not run) gets a genuine first-run
 * screen that explains what will happen and offers to run it now — never an
 * empty page, and never a fabricated briefing.
 */
export default async function OverviewPage() {
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

  const [row, membership, setup] = await Promise.all([
    getLatestBriefing(active.id),
    getMembership(user.id, active.id),
    getOnboardingState(active.id),
  ]);
  const canRun = membership ? can(membership.role, 'content:create') : false;

  if (!row) {
    return (
      <div className="space-y-5">
        <PageHeader
          title={`Good to see you${firstName ? `, ${firstName}` : ''}`}
          description={`Aura works on ${active.name} in the background and reports back here.`}
        />
        {/* Before the first briefing, setup IS the next action — so it leads,
            expanded, above the explanation of what Aura will do with it. */}
        {!setup.finished && <SetupChecklist state={setup} />}
        <GettingStarted canRun={canRun} />
      </div>
    );
  }

  const briefing = toBriefingView(row);

  return (
    <div>
      <PageHeader
        title={`Good to see you${firstName ? `, ${firstName}` : ''}`}
        description={`Here is what Aura has been doing for ${active.name}.`}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/content">
              <Sparkles className="h-4 w-4" /> Content Studio
            </Link>
          </Button>
        }
      />

      {/* Once Aura is reporting in, the briefing is the main event and setup
          becomes a strip above it — still one clear next action, but no longer
          the whole screen. It disappears for good when every step is done. */}
      {!setup.finished && (
        <div className="mb-5">
          <SetupChecklist state={setup} variant="compact" />
        </div>
      )}

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

      {/* Everything Aura produced is still reachable directly. */}
      <Card className="mt-6">
        <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4 text-sm">
          <span className="text-muted-foreground">Go deeper:</span>
          {[
            { label: 'Content Studio', href: '/dashboard/content' },
            { label: 'Market trends', href: '/dashboard/trends' },
            { label: 'Competitors', href: '/dashboard/competitors' },
            { label: 'Opportunities', href: '/dashboard/advisor' },
            { label: 'Content plan', href: '/dashboard/planner' },
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
  );
}
