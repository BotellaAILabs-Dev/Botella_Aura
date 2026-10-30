import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { can } from '@/lib/rbac';
import { getMembership } from '@/server/services/company.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { WebsiteManager } from '@/components/dashboard/websites/website-manager';
import { PublishingHistory } from '@/components/dashboard/websites/publishing-history';

export const metadata: Metadata = { title: 'Website publishing' };

/**
 * Settings → Website publishing (docs/WEBSITE-PUBLISHING.md):
 * Connect website → approve a blog → choose the website → preview → publish
 * or schedule → track it here.
 */
export default async function WebsitesPage({ searchParams }: { searchParams: { status?: string; site?: string; reason?: string } }) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;
  const membership = await getMembership(user.id, active.id);
  const canPublish = membership ? can(membership.role, 'content:publish') : false;

  // The Shopify OAuth callback lands here with its outcome.
  const notice =
    searchParams.status === 'connected'
      ? { ok: true, text: `${searchParams.site ?? 'Your store'} is connected. Approved blogs can now be published to it.` }
      : searchParams.status === 'error'
        ? { ok: false, text: searchParams.reason ?? 'The connection didn’t complete. Try again.' }
        : null;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/settings" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Settings
        </Link>
        <PageHeader
          title="Website publishing"
          description="Connect your WordPress, Shopify or Ghost site and publish approved blogs to it — now, as a draft, or on a schedule."
        />
      </div>
      {notice && (
        <p
          role={notice.ok ? 'status' : 'alert'}
          className={`rounded-md border p-3 text-sm ${notice.ok ? 'border-success/30 bg-success/10 text-foreground' : 'border-destructive/30 bg-destructive/10 text-foreground'}`}
        >
          {notice.text}
        </p>
      )}
      <WebsiteManager />
      <PublishingHistory canAct={canPublish} />
    </div>
  );
}
