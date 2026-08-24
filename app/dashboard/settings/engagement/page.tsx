import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { listTargets } from '@/server/engagement/target.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import {
  TargetManager,
  type TargetRow,
} from '@/components/dashboard/engagement/target-manager';

export const metadata: Metadata = { title: 'Engagement targets' };
export const dynamic = 'force-dynamic';

export default async function EngagementSettingsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, targets] = await Promise.all([
    getMembership(user.id, active.id),
    listTargets(active.id),
  ]);
  const canManage = membership ? can(membership.role, 'company:update') : false;

  const rows: TargetRow[] = targets.map((t) => ({
    id: t.id,
    label: t.label,
    profileUrl: t.profileUrl,
    addedAt: t.createdAt.toISOString(),
  }));

  return (
    <div>
      <PageHeader
        title="Engagement targets"
        description="Choose the public profiles and pages you want to engage with."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/settings">
              <ArrowLeft className="h-4 w-4" /> Settings
            </Link>
          </Button>
        }
      />
      <TargetManager targets={rows} canManage={canManage} />
    </div>
  );
}
