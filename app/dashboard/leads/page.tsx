import Link from 'next/link';
import type { Metadata } from 'next';
import { Radar, Users } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { listLeads } from '@/server/outreach/lead.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import {
  LeadsTable,
  type LeadTableRow,
} from '@/components/dashboard/leads/leads-table';

export const metadata: Metadata = { title: 'Leads' };

export default async function LeadsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, leads] = await Promise.all([
    getMembership(user.id, active.id),
    listLeads(active.id),
  ]);
  const canManage = membership ? can(membership.role, 'content:approve') : false;

  const rows: LeadTableRow[] = leads.map((l) => ({
    id: l.id,
    name: l.name,
    title: l.title,
    companyName: l.companyName,
    source: l.source,
    status: l.status,
    fitScore: l.fitScore,
    signalCount: l.signals.length,
    messageCount: l.messages.length,
  }));

  const discoverBtn = (
    <Button asChild size="sm">
      <Link href="/dashboard/leads/discover">
        <Radar className="h-4 w-4" /> Discover leads
      </Link>
    </Button>
  );

  return (
    <div>
      <PageHeader
        title="Leads"
        description="Every lead — from Sprint 4 signals and proactive discovery — in one place."
        actions={discoverBtn}
      />
      {rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No leads yet"
          description="Build a discovery profile to proactively find prospects from public sources, or let signal detection surface them."
          action={canManage ? discoverBtn : undefined}
        />
      ) : (
        <LeadsTable leads={rows} canManage={canManage} />
      )}
    </div>
  );
}
