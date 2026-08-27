import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ArrowLeft, Target } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getCampaign, CampaignNotFoundError } from '@/server/campaigns/campaign.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PauseButton } from '@/components/dashboard/campaigns/pause-button';
import {
  CampaignTimeline,
  type TaskRow,
} from '@/components/dashboard/campaigns/campaign-timeline';

export const metadata: Metadata = { title: 'Campaign' };

export default async function CampaignDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  let campaign;
  try {
    campaign = await getCampaign(active.id, params.id);
  } catch (e) {
    if (e instanceof CampaignNotFoundError) notFound();
    throw e;
  }

  const total = campaign.tasks.length;
  const done = campaign.tasks.filter((t) =>
    ['GENERATED', 'APPROVED', 'SKIPPED'].includes(t.status),
  ).length;
  const pendingReview = campaign.tasks.filter((t) => t.status === 'GENERATED').length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const plan = (campaign.plan ?? {}) as { overview?: string };

  /**
   * "PENDING" conflated two completely different states: work scheduled for a
   * future date (nothing to do — the campaign is running correctly) and work
   * that is due but has not run (genuinely stuck). Showing 25 PENDING beside
   * "Awaiting your review: 0" read as a contradiction for that reason.
   */
  const now = Date.now();
  const pendingTasks = campaign.tasks.filter((t) => t.status === 'PENDING');
  const scheduledAhead = pendingTasks.filter(
    (t) => t.scheduledDate.getTime() > now,
  );
  const overdue = pendingTasks.filter((t) => t.scheduledDate.getTime() <= now);

  /** The one thing to look at next — not a flat 25-item list. */
  const nextTask =
    campaign.tasks
      .filter((t) => t.status === 'GENERATED')
      .sort((a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime())[0] ??
    overdue.sort((a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime())[0] ??
    scheduledAhead.sort(
      (a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime(),
    )[0] ??
    null;

  /** Task counts by type, so 25 tasks is a legible mix rather than a number. */
  const byType = campaign.tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.taskType] = (acc[t.taskType] ?? 0) + 1;
    return acc;
  }, {});
  const TYPE_LABEL: Record<string, string> = {
    GENERATE_CONTENT: 'Content',
    DRAFT_OUTREACH: 'Outreach',
    RUN_DISCOVERY: 'Discovery',
    REVIEW_CHECKPOINT: 'Checkpoint',
  };

  const rows: TaskRow[] = campaign.tasks.map((t) => ({
    id: t.id,
    scheduledDate: t.scheduledDate.toISOString(),
    taskType: t.taskType,
    status: t.status,
    contentType: t.contentType,
    topic: t.topic,
    rationale: t.rationale,
    relatedContentDraftId: t.relatedContentDraftId,
    checkpointSummary: t.checkpointSummary,
  }));

  return (
    <div>
      <PageHeader
        title={campaign.name}
        description={campaign.goal ?? undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard/campaigns">
                <ArrowLeft className="h-4 w-4" /> Campaigns
              </Link>
            </Button>
            <PauseButton campaignId={campaign.id} status={campaign.status} />
          </div>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Status</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={campaign.status === 'ACTIVE' ? 'success' : campaign.status === 'PAUSED' ? 'warning' : 'muted'}>
              {campaign.status}
            </Badge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-1 text-sm font-medium">{done} / {total} tasks · {pct}%</div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Awaiting your review</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{pendingReview}</div>
            {/* Explains a zero here while tasks sit PENDING, instead of
                leaving the two numbers looking contradictory. */}
            <p className="mt-1 text-xs text-muted-foreground">
              {pendingReview > 0
                ? 'Generated and waiting on you.'
                : scheduledAhead.length > 0
                  ? `Nothing yet — ${scheduledAhead.length} task${
                      scheduledAhead.length === 1 ? '' : 's'
                    } scheduled for later will appear here once generated.`
                  : 'Nothing waiting on you.'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Scheduled vs stuck — the distinction "PENDING" was hiding. */}
      <div className="mb-6 flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline">
          {scheduledAhead.length} scheduled for later
        </Badge>
        {overdue.length > 0 && (
          <Badge variant="warning" title="Due, but not yet generated — the daily job runs each morning.">
            {overdue.length} due now
          </Badge>
        )}
        <Badge variant="muted">{done} completed</Badge>
        <span className="text-muted-foreground">
          ·{' '}
          {Object.entries(byType)
            .map(([type, n]) => `${n} ${TYPE_LABEL[type] ?? type}`)
            .join(' · ')}
        </span>
      </div>

      {nextTask && (
        <Card className="mb-6 border-primary/30 bg-primary/[0.03]">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Next up
            </p>
            <p className="mt-1 text-sm font-medium text-foreground">
              {TYPE_LABEL[nextTask.taskType] ?? nextTask.taskType}
              {nextTask.topic ? ` — ${nextTask.topic}` : ''}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {nextTask.status === 'GENERATED'
                ? 'Ready for your review.'
                : nextTask.scheduledDate.getTime() > Date.now()
                  ? `Scheduled for ${nextTask.scheduledDate.toLocaleDateString()} — nothing to do until then.`
                  : `Due ${nextTask.scheduledDate.toLocaleDateString()} — the daily job will pick it up.`}
            </p>
          </CardContent>
        </Card>
      )}

      {plan.overview && (
        <Card className="mb-6 border-primary/20">
          <CardContent className="flex items-start gap-3 p-4">
            <Target className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <p className="text-sm text-foreground">{plan.overview}</p>
          </CardContent>
        </Card>
      )}

      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Schedule</h2>
      <CampaignTimeline tasks={rows} />
    </div>
  );
}
