import type { Metadata } from 'next';
import { Linkedin } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import {
  getCompanyById,
  getCompanyMembers,
  getMembership,
} from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/dashboard/page-header';
import { CompanyProfileForm } from '@/components/dashboard/company-profile-form';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/empty-state';
import { getInitials } from '@/lib/utils';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  // Layout guarantees an active company, but guard for types.
  if (!active) return null;

  const [company, membership, members] = await Promise.all([
    getCompanyById(active.id),
    getMembership(user.id, active.id),
    getCompanyMembers(active.id),
  ]);
  if (!company || !membership) return null;

  const canEdit = can(membership.role, 'company:update');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Manage your workspace profile and team."
      />

      <CompanyProfileForm
        companyId={company.id}
        canEdit={canEdit}
        initial={{
          name: company.name,
          website: company.website,
          industry: company.industry,
          brandVoiceNotes: company.brandVoiceNotes,
        }}
      />

      {/* Team members — view-only in Sprint 1 */}
      <Card>
        <CardHeader>
          <CardTitle>Team members</CardTitle>
          <CardDescription>
            People with access to {company.name}. Inviting teammates ships in a
            later sprint.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {members.map((m) => {
              const display = m.user.name || m.user.email;
              return (
                <li
                  key={m.id}
                  className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                >
                  <div className="flex items-center gap-3">
                    <Avatar>
                      {m.user.image && <AvatarImage src={m.user.image} alt="" />}
                      <AvatarFallback>{getInitials(display)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {display}
                        {m.userId === user.id && (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            (you)
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {m.user.email}
                      </p>
                    </div>
                  </div>
                  <Badge variant={m.role === 'OWNER' ? 'default' : 'secondary'}>
                    {m.role}
                  </Badge>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      {/* LinkedIn connection — placeholder for Sprint 2 */}
      <Card>
        <CardHeader>
          <CardTitle>LinkedIn connection</CardTitle>
          <CardDescription>
            Connect via the official LinkedIn API to publish approved content.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={Linkedin}
            title="Not connected yet"
            description="LinkedIn OAuth arrives in Sprint 2. Aura will only ever use the official LinkedIn API — never scraping or automation — and will publish only what you've explicitly approved."
          />
        </CardContent>
      </Card>
    </div>
  );
}
