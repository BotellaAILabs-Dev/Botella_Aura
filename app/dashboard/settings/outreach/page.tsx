import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import {
  ensureOutreachConfig,
  toCriteria,
} from '@/server/outreach/config.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { OutreachConfigForm } from '@/components/dashboard/outreach/outreach-config-form';

export const metadata: Metadata = { title: 'Outreach targeting' };

export default async function OutreachSettingsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, config] = await Promise.all([
    getMembership(user.id, active.id),
    ensureOutreachConfig(active.id),
  ]);
  const canEdit = membership ? can(membership.role, 'company:update') : false;
  const criteria = toCriteria(config);

  return (
    <div>
      <PageHeader
        title="Outreach targeting"
        description="Define who you want to reach and which public sources to scan."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/settings">
              <ArrowLeft className="h-4 w-4" /> Settings
            </Link>
          </Button>
        }
      />
      <OutreachConfigForm
        canEdit={canEdit}
        initial={{
          industries: criteria.industries,
          roleTitles: criteria.roleTitles,
          companyStages: criteria.companyStages,
          enabledSources: criteria.enabledSources,
        }}
      />
    </div>
  );
}
