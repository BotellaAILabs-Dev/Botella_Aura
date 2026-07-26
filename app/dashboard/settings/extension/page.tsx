import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { listExtensionTokens } from '@/server/extension/token.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import {
  ExtensionManager,
  type ExtensionTokenRow,
} from '@/components/dashboard/extension/extension-manager';

export const metadata: Metadata = { title: 'Browser extension' };

export default async function ExtensionSettingsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, tokens] = await Promise.all([
    getMembership(user.id, active.id),
    listExtensionTokens(user.id, active.id),
  ]);
  const canManage = membership ? can(membership.role, 'linkedin:connect') : false;

  const rows: ExtensionTokenRow[] = tokens.map((t) => ({
    id: t.id,
    label: t.label,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
    expiresAt: t.expiresAt ? t.expiresAt.toISOString() : null,
  }));

  return (
    <div>
      <PageHeader
        title="Browser extension"
        description="Pair the companion extension — your one-click action layer for LinkedIn."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/settings">
              <ArrowLeft className="h-4 w-4" /> Settings
            </Link>
          </Button>
        }
      />
      <ExtensionManager tokens={rows} canManage={canManage} />
    </div>
  );
}
