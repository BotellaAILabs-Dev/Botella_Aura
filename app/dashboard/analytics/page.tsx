import Link from 'next/link';
import type { Metadata } from 'next';
import { BarChart3, TrendingUp } from 'lucide-react';

import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { getAnalytics } from '@/server/analytics/analytics.service';
import { getLatestReport } from '@/server/analytics/report.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TrendChart } from '@/components/dashboard/memory/trend-chart';
import { BarList } from '@/components/dashboard/analytics/bar-list';
import { ReportCard } from '@/components/dashboard/analytics/report-card';
import { LogResultDialog } from '@/components/dashboard/analytics/log-result-dialog';
import { CONTENT_TYPE_LABELS } from '@/lib/content-ui';
import type { ContentTypeKey } from '@/lib/validations/content';

export const metadata: Metadata = { title: 'Analytics' };

const RANGES = [7, 30, 90];

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: { days?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const days = RANGES.includes(Number(searchParams.days)) ? Number(searchParams.days) : 30;
  const [membership, analytics, report, publishedDrafts] = await Promise.all([
    getMembership(user.id, active.id),
    getAnalytics(active.id, days),
    getLatestReport(active.id),
    // Only published work can have real numbers to log against it.
    db.contentDraft.findMany({
      where: { companyId: active.id, status: 'PUBLISHED' },
      orderBy: { publishedAt: 'desc' },
      take: 50,
      select: { id: true, title: true },
    }),
  ]);
  const canManage = membership ? can(membership.role, 'content:approve') : false;
  const t = analytics.topline;

  const rangeSwitch = (
    <div className="flex gap-1">
      {RANGES.map((d) => (
        <Button key={d} asChild variant={d === days ? 'default' : 'outline'} size="sm">
          <Link href={`/dashboard/analytics?days=${d}`}>{d}d</Link>
        </Button>
      ))}
    </div>
  );

  // Published titles are nullable in the schema; fall back rather than drop the row.
  const loggableDrafts = publishedDrafts.map((d) => ({
    id: d.id,
    title: d.title ?? 'Untitled post',
  }));

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {canManage && <LogResultDialog drafts={loggableDrafts} />}
      {rangeSwitch}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Your results at a glance — real captured data only."
        actions={actions}
      />

      {!analytics.hasData ? (
        <EmptyState
          icon={BarChart3}
          title="Not enough data for this period"
          description="Nothing has reported a number yet. Connect Google Analytics, sync metrics through the extension, or use “Log results” to type them in by hand — Results and “What works for you” treat all three the same, so you are never blocked waiting on an integration."
          action={
            canManage ? (
              <LogResultDialog drafts={loggableDrafts} />
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-6">
          {/* Top-line metrics */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Posts published" value={t.postsPublished} />
            <Stat label="Total engagement" value={t.totalEngagement} />
            <Stat label="Outreach sent" value={t.outreachSent} />
            <Stat label="Connections made" value={t.connectionsMade} />
            <Stat label="Replies received" value={t.repliesReceived} />
            <Stat label="Leads discovered" value={t.leadsDiscovered} />
            <Stat label="Campaigns started" value={t.campaignsRun} />
          </div>

          {/* Engagement trend */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4 text-primary" /> Engagement over time
              </CardTitle>
            </CardHeader>
            <CardContent>
              <TrendChart points={analytics.engagementTrend} />
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            {/* Outreach funnel */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Outreach funnel</CardTitle>
              </CardHeader>
              <CardContent>
                <BarList
                  items={[
                    { label: 'Sent', value: analytics.funnel.sent },
                    { label: 'Connected', value: analytics.funnel.connected },
                    { label: 'Replied', value: analytics.funnel.replied },
                  ]}
                />
              </CardContent>
            </Card>

            {/* Channel breakdown */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">By content type</CardTitle>
              </CardHeader>
              <CardContent>
                <BarList
                  items={analytics.channelBreakdown.map((c) => ({
                    label: CONTENT_TYPE_LABELS[c.type as ContentTypeKey] ?? c.type,
                    value: c.count,
                    caption: `avg ${c.avgEngagement}`,
                  }))}
                />
              </CardContent>
            </Card>
          </div>

          <ReportCard
            summary={report?.summary ?? null}
            generatedAt={report ? report.generatedAt.toISOString() : null}
            canManage={canManage}
          />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-2xl font-semibold">{value.toLocaleString()}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}
