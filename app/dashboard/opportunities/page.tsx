import Link from 'next/link';
import type { Metadata } from 'next';
import { Lightbulb } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { can } from '@/lib/rbac';
import { toOpportunityView } from '@/lib/opportunity-ui';
import { getMembership } from '@/server/services/company.service';
import { listOpportunitiesForView } from '@/server/opportunities/opportunity.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { OpportunitiesView } from '@/components/dashboard/opportunities/opportunities-view';

export const metadata: Metadata = { title: 'Opportunities' };
export const dynamic = 'force-dynamic';

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: { focus?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const now = new Date();
  const [membership, rows] = await Promise.all([
    getMembership(user.id, active.id),
    listOpportunitiesForView(active.id, { now }),
  ]);
  const canAct = membership ? can(membership.role, 'company:update') : false;

  return (
    <div>
      <PageHeader
        title="Opportunities"
        description="What Aura noticed you could act on — why it thinks so, the evidence behind it, and where each one stands."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/advisor">
              <Lightbulb className="h-4 w-4" /> Campaign ideas
            </Link>
          </Button>
        }
      />
      <OpportunitiesView
        opportunities={rows.map((r) => toOpportunityView(r, now))}
        canAct={canAct}
        focusId={searchParams.focus ?? null}
      />
    </div>
  );
}
