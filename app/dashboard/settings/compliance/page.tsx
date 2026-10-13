import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { getPolicyContext } from '@/server/content/compliance.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { ComplianceForm } from '@/components/dashboard/settings/compliance-form';

export const metadata: Metadata = { title: 'Compliance' };
export const dynamic = 'force-dynamic';

export default async function CompliancePage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [ctx, membership] = await Promise.all([
    getPolicyContext(active.id),
    getMembership(user.id, active.id),
  ]);
  const canManage = membership ? can(membership.role, 'company:update') : false;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard/settings"
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Settings
        </Link>
        <PageHeader
          title="Compliance"
          description="The rules every draft is written to and checked against before it can be approved. A failed check blocks it; a review trigger sends it to a person."
        />
      </div>
      <ComplianceForm
        initial={ctx.policy}
        alcohol={ctx.alcohol}
        customised={ctx.customised}
        canManage={canManage}
      />
    </div>
  );
}
