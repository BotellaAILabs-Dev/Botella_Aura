import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { getLinkedInStatus } from '@/server/services/linkedin.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { LinkedInConnectionCard } from '@/components/dashboard/linkedin-connection-card';

export const metadata: Metadata = { title: 'Connections' };

const ERROR_MESSAGES: Record<string, string> = {
  forbidden: 'You are not permitted to manage this connection.',
  not_configured: 'LinkedIn is not configured on this server yet.',
  state_mismatch: 'Security check failed. Please try connecting again.',
  bad_state: 'Something went wrong starting the connection. Please retry.',
  missing_code: 'LinkedIn did not return an authorization code.',
  exchange_failed: 'Could not complete the LinkedIn connection. Please retry.',
  access_denied: 'You declined the LinkedIn permission request.',
};

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: { connected?: string; error?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const membership = await getMembership(user.id, active.id);
  const status = await getLinkedInStatus(active.id);
  const canManage = membership ? can(membership.role, 'linkedin:connect') : false;

  const notice = searchParams.connected
    ? { type: 'success' as const, message: 'LinkedIn connected successfully.' }
    : searchParams.error
      ? {
          type: 'error' as const,
          message:
            ERROR_MESSAGES[searchParams.error] ??
            'Could not connect LinkedIn. Please try again.',
        }
      : null;

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
          title="Connections"
          description="Connect the accounts Aura uses to personalize and (later) publish."
        />
      </div>

      <LinkedInConnectionCard
        status={{
          connected: status.connected,
          configured: status.configured,
          displayName: status.displayName,
          avatarUrl: status.avatarUrl,
          needsReconnect: status.needsReconnect,
          connectedAt: status.connectedAt ? status.connectedAt.toISOString() : null,
          canManage,
        }}
        notice={notice}
      />
    </div>
  );
}
