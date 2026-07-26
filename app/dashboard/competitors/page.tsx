import Link from 'next/link';
import type { Metadata } from 'next';
import { FileText } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { listCompetitors } from '@/server/competitors/competitor.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import {
  CompetitorManager,
  type CompetitorRow,
} from '@/components/dashboard/competitors/competitor-manager';
import type { ChangesSummary } from '@/server/competitors/types';

export const metadata: Metadata = { title: 'Competitors' };

export default async function CompetitorsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, competitors] = await Promise.all([
    getMembership(user.id, active.id),
    listCompetitors(active.id),
  ]);
  const canManage = membership ? can(membership.role, 'company:update') : false;

  const rows: CompetitorRow[] = competitors.map((c) => {
    const snap = c.snapshots[0];
    return {
      id: c.id,
      name: c.name,
      url: c.url,
      pricingUrl: c.pricingUrl,
      linkedInUrl: c.linkedInUrl,
      githubOrg: c.githubOrg,
      notes: c.notes,
      trackingEnabled: c.trackingEnabled,
      latest: snap
        ? {
            capturedAt: snap.capturedAt.toISOString(),
            summary: snap.changesSummary as unknown as ChangesSummary,
          }
        : null,
    };
  });

  return (
    <div>
      <PageHeader
        title="Competitor Intelligence"
        description="Track competitors from public signal only — website changes, news, and GitHub activity."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/competitors/reports">
              <FileText className="h-4 w-4" /> Weekly reports
            </Link>
          </Button>
        }
      />
      <CompetitorManager competitors={rows} canManage={canManage} />
    </div>
  );
}
