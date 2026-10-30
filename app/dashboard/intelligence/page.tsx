import Link from 'next/link';
import type { Metadata } from 'next';
import { BarChart3, Lightbulb } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import {
  getLatestIntelligence,
  getScoreHistory,
} from '@/server/intelligence/intelligence.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { IntelligenceView } from '@/components/dashboard/intelligence/intelligence-view';
import { MarketingGapsCard } from '@/components/dashboard/intelligence/marketing-gaps-card';
import { getMarketingGaps } from '@/server/intelligence/marketing-gaps.service';
import { getBusinessContext } from '@/server/business-context/business-context.service';

export const metadata: Metadata = { title: 'Marketing Intelligence' };
export const dynamic = 'force-dynamic';

export default async function IntelligencePage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, snapshot, history, gaps, ctx] = await Promise.all([
    getMembership(user.id, active.id),
    getLatestIntelligence(active.id),
    getScoreHistory(active.id, 60),
    getMarketingGaps(active.id),
    getBusinessContext(active.id, { sections: [] }),
  ]);
  const canRun = membership ? can(membership.role, 'content:create') : false;

  return (
    <div>
      <PageHeader
        title="AI Marketing Intelligence"
        description="One view of overall marketing health, the specific issues behind it, and what to do next — across campaigns, leads, competitors, content, and brand."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard/analytics">
                <BarChart3 className="h-4 w-4" /> Analytics
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard/advisor">
                <Lightbulb className="h-4 w-4" /> Advisor
              </Link>
            </Button>
          </div>
        }
      />
      <MarketingGapsCard
        gaps={gaps}
        canCreate={canRun}
        hasProducts={Boolean(ctx?.identity.products.length)}
      />
      <IntelligenceView snapshot={snapshot} history={history} canRun={canRun} />
    </div>
  );
}
