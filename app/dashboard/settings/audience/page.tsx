import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { getWorkspaceProfile } from '@/server/company/profile.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { AudienceGoalsForm } from '@/components/dashboard/settings/audience-goals-form';

export const metadata: Metadata = { title: 'Audience & goals' };

export default async function AudienceSettingsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [{ marketing }, membership] = await Promise.all([
    getWorkspaceProfile(active.id),
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
          title="Audience & goals"
          description="Who you are trying to reach, and what you want to happen. This is the single biggest thing you can tell Aura."
        />
      </div>

      <AudienceGoalsForm
        initial={{
          audience: marketing?.audience ?? '',
          goals: marketing?.goals ?? '',
          channels: marketing?.channels ?? [],
        }}
        canManage={canManage}
      />
    </div>
  );
}
