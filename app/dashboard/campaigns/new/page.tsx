import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { campaignCreationHandoff } from '@/lib/creation-handoff';
import { executionGate } from '@/lib/execution-gate';
import { getCreation } from '@/server/recommendations/creation.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CampaignForm } from '@/components/dashboard/campaigns/campaign-form';
import { CreationContextPanel } from '@/components/dashboard/recommendations/creation-context-panel';

export const metadata: Metadata = { title: 'New campaign' };

/**
 * `?rec=<id>`: planned for one of Aura's recommendations — the Campaign
 * creation handoff (lib/creation-handoff.ts) fills the form in, shows what is
 * carried and what is missing, and the campaign keeps that context. Until
 * execution arrives (lib/execution-gate.ts) it is saved as a plan.
 */
export default async function NewCampaignPage({
  searchParams,
}: {
  searchParams: { rec?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  const creation =
    active && searchParams.rec
      ? await getCreation(active.id, searchParams.rec, 'campaigns')
      : null;
  const usable = creation?.plan.canCreate ? creation : null;
  const handoff = usable
    ? campaignCreationHandoff(usable.handoff, { related: usable.related })
    : null;
  const gate = executionGate('campaign', Boolean(handoff));
  return (
    <div className="space-y-4">
      <PageHeader
        title="Plan a campaign"
        description={
          handoff
            ? 'Filled in from Aura’s suggestion — check it, then plan.'
            : 'One goal in, a full reviewable schedule out.'
        }
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/campaigns">
              <ArrowLeft className="h-4 w-4" /> Campaigns
            </Link>
          </Button>
        }
      />
      {creation && !usable && (
        <Card>
          <CardContent className="space-y-2 p-4 text-sm">
            <p>{creation.plan.message ?? 'There is nothing to plan from this suggestion.'}</p>
            {creation.plan.fix && (
              <Button asChild size="sm" variant="outline">
                <Link href={creation.plan.fix.href}>{creation.plan.fix.label}</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      )}
      {handoff && (
        <CreationContextPanel
          context={handoff.context}
          gate={gate.message}
        />
      )}
      {usable?.plan.acceptsOnCreate && (
        <p className="text-xs text-muted-foreground">{usable.plan.message}</p>
      )}
      <CampaignForm
        initial={handoff?.prefill}
        recommendationId={usable?.plan.recommendationId}
        executionHeld={gate.blocked}
      />
    </div>
  );
}
