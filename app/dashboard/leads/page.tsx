import Link from 'next/link';
import type { Metadata } from 'next';
import { Radar, Users, ArrowRight } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { listLeads, listLeadCategories } from '@/server/outreach/lead.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import {
  LeadsTable,
  type LeadTableRow,
} from '@/components/dashboard/leads/leads-table';

export const metadata: Metadata = { title: 'Leads' };
// Leads change on every discovery run; never serve a stale list.
export const dynamic = 'force-dynamic';

export default async function LeadsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, leads, categories] = await Promise.all([
    getMembership(user.id, active.id),
    listLeads(active.id),
    listLeadCategories(active.id),
  ]);
  const canManage = membership ? can(membership.role, 'content:approve') : false;

  const rows: LeadTableRow[] = leads.map((l) => ({
    id: l.id,
    name: l.name,
    title: l.title,
    companyName: l.companyName,
    source: l.source,
    status: l.status,
    category: l.category,
    profileName: l.discoveryProfile?.name ?? null,
    fitScore: l.fitScore,
    fitRationale: l.fitRationale,
    fitMatched: l.fitMatched,
    fitMissed: l.fitMissed,
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
        description="Every lead — from signal detection and proactive discovery — grouped by the requirement it came from."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard/outreach">
                Outreach <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            {discoverBtn}
          </div>
        }
      />
      {rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No leads yet"
          description="Build a discovery profile to proactively find prospects from public sources, or let signal detection surface them."
          action={canManage ? discoverBtn : undefined}
        />
      ) : (
        <>
          {/* Make the pipeline explicit: this page feeds Outreach. */}
          <p className="mb-4 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              Lead requirement → Fetch leads → Leads → Outreach.
            </span>{' '}
            Every lead here is already available on the{' '}
            <Link href="/dashboard/outreach" className="text-primary hover:underline">
              Outreach board
            </Link>
            . Select leads and press{' '}
            <span className="font-medium text-foreground">Send to Outreach</span> to
            qualify them and jump straight to their requirement there.
          </p>
          <LeadsTable leads={rows} categories={categories} canManage={canManage} />
        </>
      )}
    </div>
  );
}
