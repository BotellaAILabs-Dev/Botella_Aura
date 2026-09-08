import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { db } from '@/lib/db';
import {
  getWorkspaceProfile,
  readContentFormats,
} from '@/server/company/profile.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { ContentFormatsForm } from '@/components/dashboard/settings/content-formats-form';

export const metadata: Metadata = { title: 'Content formats' };
export const dynamic = 'force-dynamic';

export default async function ContentFormatsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [{ marketing }, membership, company] = await Promise.all([
    getWorkspaceProfile(active.id),
    getMembership(user.id, active.id),
    db.company.findUnique({
      where: { id: active.id },
      select: { preferences: true },
    }),
  ]);
  const canManage = membership ? can(membership.role, 'company:update') : false;

  // The stored list, NOT the resolved one: an empty choice must render as
  // "nothing narrowed yet" rather than as five ticked boxes, which would look
  // like a decision someone made.
  const stored = company ? readContentFormats(company) : null;

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
          title="Content formats"
          description="Which kinds of content Aura offers you. A B2C brand and a B2B one rarely want the same set."
        />
      </div>

      <ContentFormatsForm
        initial={stored?.enabled ?? []}
        marketMode={marketing?.marketMode}
        canManage={canManage}
      />
    </div>
  );
}
