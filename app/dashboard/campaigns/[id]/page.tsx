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
          </CardContent>
        </Card>
      </div>

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
