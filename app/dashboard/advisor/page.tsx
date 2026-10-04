import Link from 'next/link';
import type { Metadata } from 'next';
import { Swords, Radar, Telescope } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { getLatestAdvisorReport } from '@/server/advisor/advisor.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { AdvisorView } from '@/components/dashboard/advisor/advisor-view';

export const metadata: Metadata = { title: 'Campaign ideas' };
export const dynamic = 'force-dynamic';

export default async function AdvisorPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, report] = await Promise.all([
    getMembership(user.id, active.id),
    getLatestAdvisorReport(active.id),
  ]);
  const canGenerate = membership ? can(membership.role, 'content:create') : false;

  return (
    <div>
      <PageHeader
        title="Campaign ideas"
        description="Campaign opportunities drawn from what your competitors actually did and what your market is discussing — each one traceable to the observation behind it."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard/opportunities">
                <Telescope className="h-4 w-4" /> All opportunities
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard/competitors">
                <Swords className="h-4 w-4" /> Competitors
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard/trends">
                <Radar className="h-4 w-4" /> Trends
              </Link>
            </Button>
          </div>
        }
      />
      <AdvisorView report={report} canGenerate={canGenerate} />
    </div>
  );
}
