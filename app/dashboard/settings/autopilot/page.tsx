import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership, getCompanyById } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import {
  readAutopilotSettings,
  MAX_AUTO_PUBLISH_PER_WEEK,
} from '@/server/briefing/autopilot.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { AutopilotForm } from '@/components/dashboard/settings/autopilot-form';

export const metadata: Metadata = { title: 'What Aura does on its own' };
export const dynamic = 'force-dynamic';

export default async function AutopilotSettingsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [company, membership, connections] = await Promise.all([
    getCompanyById(active.id),
    getMembership(user.id, active.id),
    db.linkedInConnection.count({ where: { companyId: active.id } }),
  ]);
  if (!company) return null;

  // Changing what Aura publishes on its own is delegating approval authority,
  // so it takes the same permission as approving a post by hand.
  const canManage = membership ? can(membership.role, 'content:approve') : false;

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
          title="What Aura does on its own"
          description="Aura works in the background every week. This is where you decide how far that goes — from writing drafts you review, to publishing without you."
        />
      </div>

      <AutopilotForm
        initial={readAutopilotSettings(company)}
        canManage={canManage}
        hasConnectedChannel={connections > 0}
        maxAutoPerWeek={MAX_AUTO_PUBLISH_PER_WEEK}
      />
    </div>
  );
}
