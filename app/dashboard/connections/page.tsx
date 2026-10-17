import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { listConnectionRecords } from '@/server/connections/manager.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { ConnectionManager } from '@/components/dashboard/connections/connection-manager';

export const metadata: Metadata = { title: 'Connection Manager' };
export const dynamic = 'force-dynamic';

/**
 * The Connection Manager: every provider connection in the workspace — the
 * account that authorised it, the pages/profiles it reaches, the permissions
 * granted, its health, and what it can and cannot do.
 */
export default async function ConnectionsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;
  const [membership, connections] = await Promise.all([getMembership(user.id, active.id), listConnectionRecords(active.id)]);
  const role = membership?.role ?? 'VIEWER';

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/connectors" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Your tools
        </Link>
        <PageHeader
          title="Connection Manager"
          description="Every connected account: what it can do, which permissions it has, and whether it is healthy enough to publish through."
        />
      </div>
      <ConnectionManager
        initial={connections}
        canManage={can(role, 'company:update')}
        canRefresh={can(role, 'content:create')}
      />
    </div>
  );
}
