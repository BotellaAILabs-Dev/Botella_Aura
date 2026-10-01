import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Linkedin,
  Radar,
  BookOpen,
  ChevronRight,
  Puzzle,
  Send,
  MessageCircle,
  CreditCard,
  Users,
  Palette,
  ListChecks,
  LayoutGrid,
  Bot,
  Building2,
} from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import {
  getCompanyById,
  getMembership,
} from '@/server/services/company.service';
import { getTeam } from '@/server/services/team.service';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/dashboard/page-header';
import { getWorkspaceProfile } from '@/server/company/profile.service';
import { TeamManager } from '@/components/dashboard/team-manager';
import { EmailDiagnosticsCard } from '@/components/dashboard/email-diagnostics-card';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  // Layout guarantees an active company, but guard for types.
  if (!active) return null;

  const [company, membership, team, profile] = await Promise.all([
    getCompanyById(active.id),
    getMembership(user.id, active.id),
    getTeam(active.id),
    getWorkspaceProfile(active.id),
  ]);
  if (!company || !membership) return null;

  const canEdit = can(membership.role, 'company:update');
  const canManageTeam = can(membership.role, 'members:invite');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Manage your workspace profile and team."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/setup">
              <ListChecks className="h-4 w-4" /> Setup progress
            </Link>
          </Button>
        }
      />

      {/* Business details live on About my business, the one place they are
          shown and edited — with where each came from and what is missing. */}
      <Link href="/dashboard/business" className="group block">
        <Card className="transition-shadow group-hover:shadow-md">
          <CardHeader>
            <div className="mb-1 flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" />
              <CardTitle className="text-base">About my business</CardTitle>
            </div>
            <CardDescription>
              {profile.business?.description
                ? `${company.name}: ${profile.business.description}`
                : 'Tell Aura what you do, who you sell to and how you sound.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center gap-1 text-sm font-medium text-primary">
            {canEdit ? 'Review and edit' : 'View'} <ChevronRight className="h-4 w-4" />
          </CardContent>
        </Card>
      </Link>

      {/* Team collaboration — invite members + role-based access */}
      <TeamManager
        currentUserId={user.id}
        currentUserRole={membership.role}
        canManage={canManageTeam}
        members={team.members.map((m) => ({
          userId: m.userId,
          role: m.role,
          name: m.user.name,
          email: m.user.email,
          image: m.user.image,
        }))}
        invitations={team.invitations.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          expiresAt: i.expiresAt.toISOString(),
          emailStatus: i.emailStatus,
          emailTransport: i.emailTransport,
          emailError: i.emailError,
          emailSentAt: i.emailSentAt ? i.emailSentAt.toISOString() : null,
        }))}
      />

      {/* Is outbound email actually working? (admins only) */}
      {canManageTeam && <EmailDiagnosticsCard />}

      {/* Sub-settings navigation (Sprint 2) */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/dashboard/settings/autopilot" className="group">
          <Card className="h-full transition-shadow group-hover:shadow-md">
            <CardHeader>
              <div className="mb-1 flex items-center gap-2">
                <Bot className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">What Aura does on its own</CardTitle>
              </div>
              <CardDescription>
                How much Aura writes each week, and whether it publishes without
                you.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-1 text-sm font-medium text-primary">
              Set the limits <ChevronRight className="h-4 w-4" />
            </CardContent>
          </Card>
        </Link>

        <Link href="/dashboard/settings/audience" className="group">
          <Card className="h-full transition-shadow group-hover:shadow-md">
            <CardHeader>
              <div className="mb-1 flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">Audience &amp; goals</CardTitle>
              </div>
              <CardDescription>
                Who you are writing for and what you want to happen. Aura reads
                this on every draft.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-1 text-sm font-medium text-primary">
              Describe your buyers <ChevronRight className="h-4 w-4" />
            </CardContent>
          </Card>
        </Link>

        <Link href="/dashboard/settings/formats" className="group">
          <Card className="h-full transition-shadow group-hover:shadow-md">
            <CardHeader>
              <div className="mb-1 flex items-center gap-2">
                <LayoutGrid className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">Content formats</CardTitle>
              </div>
              <CardDescription>
                Which kinds of content Aura offers. Turn off the formats your
                team never posts.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-1 text-sm font-medium text-primary">
              Choose your formats <ChevronRight className="h-4 w-4" />
            </CardContent>
          </Card>
        </Link>

        <Link href="/dashboard/settings/brand" className="group">
          <Card className="h-full transition-shadow group-hover:shadow-md">
            <CardHeader>
              <div className="mb-1 flex items-center gap-2">
                <Palette className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">Brand assets</CardTitle>
              </div>
              <CardDescription>
                Your logo and colours. Aura art-directs every graphic around
                them.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-1 text-sm font-medium text-primary">
              Add logo and colours <ChevronRight className="h-4 w-4" />
            </CardContent>
          </Card>
        </Link>

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
                <CardTitle className="text-base">Business materials</CardTitle>
              </div>
              <CardDescription>
                Decks, brand guidelines, product docs and competitor notes — what Aura learns from.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-1 text-sm font-medium text-primary">
              Add materials <ChevronRight className="h-4 w-4" />
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

        <Link href="/dashboard/settings/engagement" className="group">
          <Card className="h-full transition-shadow group-hover:shadow-md">
            <CardHeader>
              <div className="mb-1 flex items-center gap-2">
                <MessageCircle className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">Engagement targets</CardTitle>
              </div>
              <CardDescription>
                Public profiles to engage with via the extension.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-1 text-sm font-medium text-primary">
              Manage targets <ChevronRight className="h-4 w-4" />
            </CardContent>
          </Card>
        </Link>

        <Link href="/dashboard/settings/billing" className="group">
          <Card className="h-full transition-shadow group-hover:shadow-md">
            <CardHeader>
              <div className="mb-1 flex items-center gap-2">
                <CreditCard className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">Billing &amp; plan</CardTitle>
              </div>
              <CardDescription>
                Your subscription, trial status, and payment.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-1 text-sm font-medium text-primary">
              Manage billing <ChevronRight className="h-4 w-4" />
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
