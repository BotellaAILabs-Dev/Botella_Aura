import type { Metadata } from 'next';
import Link from 'next/link';
import { Linkedin, Radar, BookOpen, ChevronRight, Puzzle, Send } from 'lucide-react';

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

      {/* Sub-settings navigation (Sprint 2) */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/dashboard/settings/connections" className="group">
          <Card className="h-full transition-shadow group-hover:shadow-md">
            <CardHeader>
              <div className="mb-1 flex items-center gap-2">
                <Linkedin className="h-5 w-5 text-[#0A66C2]" />
                <CardTitle className="text-base">Connections</CardTitle>
              </div>
              <CardDescription>
                Connect LinkedIn (official API) to personalize your content.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-1 text-sm font-medium text-primary">
              Manage connections <ChevronRight className="h-4 w-4" />
            </CardContent>
          </Card>
        </Link>

        <Link href="/dashboard/settings/trends" className="group">
          <Card className="h-full transition-shadow group-hover:shadow-md">
            <CardHeader>
              <div className="mb-1 flex items-center gap-2">
                <Radar className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">Trend sources</CardTitle>
              </div>
              <CardDescription>
                Keywords, subreddits, and competitors your digest monitors.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-1 text-sm font-medium text-primary">
              Configure sources <ChevronRight className="h-4 w-4" />
            </CardContent>
          </Card>
        </Link>

        <Link href="/dashboard/settings/knowledge-base" className="group">
          <Card className="h-full transition-shadow group-hover:shadow-md">
            <CardHeader>
              <div className="mb-1 flex items-center gap-2">
                <BookOpen className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">Knowledge base &amp; brand voice</CardTitle>
              </div>
              <CardDescription>
                Ingest your content so AI writes in your voice.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-1 text-sm font-medium text-primary">
              Manage knowledge base <ChevronRight className="h-4 w-4" />
            </CardContent>
          </Card>
        </Link>

        <Link href="/dashboard/settings/extension" className="group">
          <Card className="h-full transition-shadow group-hover:shadow-md">
            <CardHeader>
              <div className="mb-1 flex items-center gap-2">
                <Puzzle className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">Browser extension</CardTitle>
              </div>
              <CardDescription>
                Pair the extension to send approved items with one human click.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-1 text-sm font-medium text-primary">
              Pair extension <ChevronRight className="h-4 w-4" />
            </CardContent>
          </Card>
        </Link>

        <Link href="/dashboard/settings/outreach" className="group">
          <Card className="h-full transition-shadow group-hover:shadow-md">
            <CardHeader>
              <div className="mb-1 flex items-center gap-2">
                <Send className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">Outreach targeting</CardTitle>
              </div>
              <CardDescription>
                Who to reach and which public signal sources to scan.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-1 text-sm font-medium text-primary">
              Configure targeting <ChevronRight className="h-4 w-4" />
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
