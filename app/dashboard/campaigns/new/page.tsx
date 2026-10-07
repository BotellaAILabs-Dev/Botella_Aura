import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getRecommendationHandoff } from '@/server/recommendations/context.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { CampaignForm } from '@/components/dashboard/campaigns/campaign-form';

export const metadata: Metadata = { title: 'New campaign' };

/**
 * `?rec=<id>`: planned for one of Aura's recommendations — the form opens
 * filled in from it (lib/aura-modules.ts) and the campaign is linked to it.
 */
export default async function NewCampaignPage({
  searchParams,
}: {
  searchParams: { rec?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  const fromRec =
    active && searchParams.rec
      ? await getRecommendationHandoff(active.id, searchParams.rec, 'campaigns')
      : null;
  return (
    <div>
      <PageHeader
        title="Plan a campaign"
        description={
          fromRec
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
      <CampaignForm
        initial={fromRec?.handoff}
        recommendationId={fromRec?.id}
      />
    </div>
  );
}
