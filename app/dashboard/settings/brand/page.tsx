import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { getWorkspaceProfile } from '@/server/company/profile.service';
import { logoAssetUrl } from '@/server/company/logo.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { BrandAssetsForm } from '@/components/dashboard/settings/brand-assets-form';

export const metadata: Metadata = { title: 'Brand assets' };
// The logo is uploaded from this page; never render a cached version of it.
export const dynamic = 'force-dynamic';

export default async function BrandSettingsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [{ brand }, membership] = await Promise.all([
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
          title="Brand assets"
          description="Your logo and colours. Aura uses them to art-direct every graphic it makes, so creatives look like they came from you."
        />
      </div>

      <BrandAssetsForm
        initial={{
          logoUrl: brand?.logoAssetId ? logoAssetUrl(brand.logoAssetId) : null,
          primaryColor: brand?.primaryColor ?? '',
          secondaryColor: brand?.secondaryColor ?? '',
          accentColor: brand?.accentColor ?? '',
        }}
        canManage={canManage}
      />
    </div>
  );
}
