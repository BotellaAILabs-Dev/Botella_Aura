import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { CampaignForm } from '@/components/dashboard/campaigns/campaign-form';

export const metadata: Metadata = { title: 'New campaign' };

export default async function NewCampaignPage() {
  await requireUser();
  return (
    <div>
      <PageHeader
        title="Plan a campaign"
        description="One goal in, a full reviewable schedule out."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/campaigns">
              <ArrowLeft className="h-4 w-4" /> Campaigns
            </Link>
          </Button>
        }
      />
      <CampaignForm />
    </div>
  );
}
