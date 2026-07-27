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
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Campaigns' };

function statusVariant(s: string): BadgeProps['variant'] {
  if (s === 'ACTIVE') return 'success';
  if (s === 'PAUSED') return 'warning';
  if (s === 'COMPLETED') return 'default';
  return 'muted';
}

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
          {campaigns.map((c) => (
            <Link key={c.id} href={`/dashboard/campaigns/${c.id}`}>
              <Card className="transition-shadow hover:shadow-md">
                <CardContent className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                    </div>
                    {c.goal && (
                      <p className="mt-0.5 truncate text-sm text-muted-foreground">{c.goal}</p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {c.durationDays}-day plan · {c._count.tasks} scheduled tasks
                      {c.startDate ? ` · started ${new Date(c.startDate).toLocaleDateString()}` : ''}
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
