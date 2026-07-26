import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, FileText } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { listReports } from '@/server/competitors/report.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GenerateReportButton } from '@/components/dashboard/competitors/generate-report-button';
import { ReportView } from '@/components/dashboard/competitors/report-view';
import type { CompetitorReportPayload } from '@/server/competitors/types';

export const metadata: Metadata = { title: 'Competitor reports' };

function weekLabel(start: Date, end: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(new Date(end.getTime() - 86_400_000))}`;
}

export default async function CompetitorReportsPage({
  searchParams,
}: {
  searchParams: { week?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const membership = await getMembership(user.id, active.id);
  const canManage = membership ? can(membership.role, 'company:update') : false;

  const reports = await listReports(active.id);

  const backLink = (
    <Button asChild variant="ghost" size="sm">
      <Link href="/dashboard/competitors">
        <ArrowLeft className="h-4 w-4" /> Competitors
      </Link>
    </Button>
  );

  if (reports.length === 0) {
    return (
      <div>
        <PageHeader
          title="Weekly competitor reports"
          description="A once-a-week AI briefing across all your tracked competitors."
          actions={backLink}
        />
        <EmptyState
          icon={FileText}
          title="No reports yet"
          description="Add competitors and generate your first weekly report. It aggregates the week's website changes, news, and GitHub activity into a briefing with a strategic takeaway per competitor."
          action={canManage ? <GenerateReportButton firstRun /> : undefined}
        />
      </div>
    );
  }

  const selected =
    reports.find((r) => r.weekStart.toISOString().slice(0, 10) === searchParams.week) ??
    reports[0]!;
  const payload = selected.payload as unknown as CompetitorReportPayload;

  return (
    <div>
      <PageHeader
        title="Weekly competitor reports"
        description={`Week of ${weekLabel(selected.weekStart, selected.weekEnd)} · generated ${new Date(
          selected.generatedAt,
        ).toLocaleString()}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {backLink}
            {canManage && <GenerateReportButton />}
          </div>
        }
      />

      {reports.length > 1 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {reports.map((r) => {
            const key = r.weekStart.toISOString().slice(0, 10);
            const isSelected = r.id === selected.id;
            return (
              <Button
                key={r.id}
                asChild
                variant={isSelected ? 'default' : 'outline'}
                size="sm"
              >
                <Link href={`/dashboard/competitors/reports?week=${key}`}>
                  {weekLabel(r.weekStart, r.weekEnd)}
                  {isSelected && (
                    <Badge variant="secondary" className="ml-1">
                      current
                    </Badge>
                  )}
                </Link>
              </Button>
            );
          })}
        </div>
      )}

      <ReportView payload={payload} />
    </div>
  );
}
