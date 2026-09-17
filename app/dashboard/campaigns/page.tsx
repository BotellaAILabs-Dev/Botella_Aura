import Link from 'next/link';
import type { Metadata } from 'next';
import { Megaphone, Plus, ArrowRight } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { listCampaigns } from '@/server/campaigns/campaign.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { countTasks, deriveCampaignState } from '@/lib/campaign-status';
import { Card, CardContent } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Campaigns' };

export default async function CampaignsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, campaigns] = await Promise.all([
    getMembership(user.id, active.id),
    listCampaigns(active.id),
  ]);
  const canManage = membership ? can(membership.role, 'content:approve') : false;

  const newBtn = (
    <Button asChild size="sm">
      <Link href="/dashboard/campaigns/new">
        <Plus className="h-4 w-4" /> New campaign
      </Link>
    </Button>
  );

  return (
    <div>
      <PageHeader
        title="Campaigns"
        description="Orchestrate content, outreach, and discovery into one reviewable plan."
        actions={canManage ? newBtn : undefined}
      />
      {campaigns.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No campaigns yet"
          description="Describe a goal and Aura plans a 30-day schedule across your modules — every generated item still lands in your approval queue first."
          action={canManage ? newBtn : undefined}
        />
      ) : (
        <div className="grid gap-3">
          {campaigns.map((c) => {
            const counts = countTasks(c.tasks);
            const state = deriveCampaignState(c.status, counts);
            const pct = counts.total
              ? Math.round((counts.done / counts.total) * 100)
              : 0;

            return (
              <Link key={c.id} href={`/dashboard/campaigns/${c.id}`}>
                <Card
                  className={
                    state.needsAttention
                      ? 'border-warning/40 transition-shadow hover:shadow-md'
                      : 'transition-shadow hover:shadow-md'
                  }
                >
                  <CardContent className="flex items-center justify-between gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{c.name}</span>
                        <Badge variant={state.tone}>{state.label}</Badge>
                      </div>
                      {c.goal && (
                        <p className="mt-0.5 truncate text-sm text-muted-foreground">{c.goal}</p>
                      )}

                      {/* Progress, as a bar rather than a raw task count —
                          "12 of 30 done" is the question people actually have. */}
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {counts.done}/{counts.total} done
                        </span>
                      </div>

                      {/* The required action, or the fact that there is none.
                          This is the line that replaces a bare status word. */}
                      <p
                        className={`mt-1 text-xs ${
                          state.needsAttention
                            ? 'font-medium text-foreground'
                            : 'text-muted-foreground'
                        }`}
                      >
                        {state.action ?? state.summary}
                      </p>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
