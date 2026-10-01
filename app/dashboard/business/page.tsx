import type { Metadata } from 'next';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { can } from '@/lib/rbac';
import { getMembership } from '@/server/services/company.service';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import { logoAssetUrl } from '@/server/company/logo.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { BusinessContextView } from '@/components/dashboard/business/business-context-view';

export const metadata: Metadata = { title: 'About my business' };
// Shows the live Business Context, and edits refresh it in place.
export const dynamic = 'force-dynamic';

/**
 * About My Business: the user-facing view of the Business Context.
 *
 * Reads the same resolved context every AI workflow reads, so what a user sees
 * here is exactly what Aura works from — including where each fact came from,
 * whether it is current, and what is missing.
 */
export default async function AboutMyBusinessPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [context, membership] = await Promise.all([
    getBusinessContext(active.id),
    getMembership(user.id, active.id),
  ]);
  if (!context || !membership) return null;

  const visual = context.identity.visual;
  const logoSrc = visual?.logoAssetId
    ? logoAssetUrl(visual.logoAssetId)
    : (visual?.logoUrl ?? null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="About my business"
        description="What Aura knows about your business, where each detail came from, and what is missing. Aura uses this in every post, plan and recommendation."
      />
      <BusinessContextView
        context={context}
        canEdit={can(membership.role, 'company:update')}
        logoSrc={logoSrc}
      />
    </div>
  );
}
