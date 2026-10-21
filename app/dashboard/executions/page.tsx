import Link from 'next/link';
import type { Metadata } from 'next';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { formatInZone } from '@/lib/timezone';
import { listExecutions } from '@/server/execution/execution-actions.service';
import { workspaceTimeZone } from '@/server/scheduling/schedule-input';
import { PageHeader } from '@/components/dashboard/page-header';
import { ExecutionList, type ExecutionRow } from '@/components/dashboard/execution/execution-list';
import type { ExecutionStatus } from '@prisma/client';

export const metadata: Metadata = { title: 'Publishing' };
export const dynamic = 'force-dynamic';

const FILTERS: { key: string; label: string; status: ExecutionStatus[] }[] = [
  { key: 'attention', label: 'Needs you', status: ['ACTION_REQUIRED', 'FAILED'] },
  { key: 'scheduled', label: 'Scheduled', status: ['SCHEDULED', 'QUEUED'] },
  { key: 'ready', label: 'Ready', status: ['READY_FOR_EXECUTION', 'APPROVED'] },
  { key: 'publishing', label: 'Publishing', status: ['EXECUTING'] },
  { key: 'published', label: 'Published', status: ['COMPLETED'] },
  { key: 'cancelled', label: 'Cancelled', status: ['CANCELLED'] },
  { key: 'all', label: 'All', status: [] },
];

/** Every execution in the workspace, by state (Execution State Machine). */
export default async function ExecutionsPage({ searchParams }: { searchParams: { show?: string } }) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;
  const filter = FILTERS.find((f) => f.key === searchParams.show) ?? FILTERS[FILTERS.length - 1]!;
  const [membership, timeZone, rows, attention] = await Promise.all([
    getMembership(user.id, active.id),
    workspaceTimeZone(active.id),
    listExecutions({ companyId: active.id, status: filter.status, limit: 200 }),
    listExecutions({ companyId: active.id, status: ['ACTION_REQUIRED', 'FAILED'], limit: 200 }),
  ]);
  const canAct = membership ? can(membership.role, 'content:publish') : false;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Publishing"
        description={`Everything approved to publish, and where it is. Times are in ${timeZone} (now ${formatInZone(new Date(), timeZone)}).`}
      />
      <nav className="flex flex-wrap gap-2" aria-label="Filter">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/dashboard/executions?show=${f.key}`}
            className={`rounded-full border px-3 py-1 text-sm ${f.key === filter.key ? 'border-primary bg-primary/10 font-medium' : 'border-border hover:bg-muted/50'}`}
            aria-current={f.key === filter.key ? 'page' : undefined}
          >
            {f.label}
            {f.key === 'attention' && attention.length ? ` (${attention.length})` : ''}
          </Link>
        ))}
      </nav>
      <ExecutionList executions={rows as unknown as ExecutionRow[]} timeZone={timeZone} canAct={canAct} />
    </div>
  );
}
