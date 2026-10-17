import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { getSetup } from '@/server/connections/manager.service';
import { CONNECTORS } from '@/lib/connectors';
import { PageHeader } from '@/components/dashboard/page-header';
import { ConnectionSetup } from '@/components/dashboard/connections/connection-setup';

export const metadata: Metadata = { title: 'Set up connection' };
export const dynamic = 'force-dynamic';

/**
 * The standard connection flow: Connect → Authenticate → Authorize →
 * Select account/page → Confirm. The provider's sign-in covers the first
 * three; this page is steps 4 and 5.
 */
export default async function ConnectionSetupPage({
  params,
  searchParams,
}: {
  params: { connectorId: string };
  searchParams: { status?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;
  const [membership, setup] = await Promise.all([getMembership(user.id, active.id), getSetup(active.id, params.connectorId)]);
  const name = params.connectorId === 'meta' ? 'Facebook & Instagram' : (CONNECTORS.find((c) => c.id === params.connectorId)?.name ?? params.connectorId);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/connections" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Connection Manager
        </Link>
        <PageHeader title={`Set up ${name}`} description="Choose the account Aura acts through, check its permissions, and confirm." />
      </div>
      <ConnectionSetup
        connectorId={params.connectorId}
        name={name}
        initial={setup}
        justAuthorized={searchParams.status === 'authorized'}
        canManage={membership ? can(membership.role, 'company:update') : false}
      />
    </div>
  );
}
