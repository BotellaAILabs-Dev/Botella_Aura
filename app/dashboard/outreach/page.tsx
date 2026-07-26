import Link from 'next/link';
import type { Metadata } from 'next';
import { Settings2, Send, ShieldCheck } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { listLeads } from '@/server/outreach/lead.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { DetectButton } from '@/components/dashboard/outreach/detect-button';
import { CreateLeadDialog } from '@/components/dashboard/outreach/create-lead-dialog';
import {
  OutreachBoard,
  type LeadRow,
} from '@/components/dashboard/outreach/outreach-board';
import type { OutreachStatusKey } from '@/lib/outreach-ui';

export const metadata: Metadata = { title: 'Outreach' };

export default async function OutreachPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, leads] = await Promise.all([
    getMembership(user.id, active.id),
    listLeads(active.id),
  ]);
  const canManage = membership ? can(membership.role, 'content:approve') : false;

  const rows: LeadRow[] = leads.map((l) => ({
    id: l.id,
    name: l.name,
    title: l.title,
    companyName: l.companyName,
    linkedInProfileUrl: l.linkedInProfileUrl,
    sourceUrl: l.sourceUrl,
    status: l.status,
    signals: l.signals.map((s) => ({
      id: s.id,
      signalType: s.signalType,
      description: s.description,
      sourceUrl: s.sourceUrl,
    })),
    messages: l.messages.map((m) => ({
      id: m.id,
      type: m.type,
      status: m.status as OutreachStatusKey,
      draftText: m.draftText,
    })),
  }));

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild variant="ghost" size="sm">
        <Link href="/dashboard/settings/outreach">
          <Settings2 className="h-4 w-4" /> Targeting
        </Link>
      </Button>
      {canManage && <CreateLeadDialog />}
      {canManage && <DetectButton />}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Outreach Intelligence"
        description="Leads surfaced from public signal, with AI-drafted messages you approve — then send yourself in the extension."
        actions={actions}
      />

      <div className="mb-5 flex items-start gap-2 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          Approved messages appear in your{' '}
          <span className="font-medium text-foreground">browser extension</span>{' '}
          queue. Nothing is ever sent automatically — you send each one yourself,
          on the lead&apos;s profile.
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Send}
          title="No leads yet"
          description="Set your targeting in settings, then detect signals from public sources (GitHub, news, hiring). Leads land here for you to draft and approve outreach."
          action={
            canManage ? (
              <div className="flex gap-2">
                <DetectButton firstRun />
                <CreateLeadDialog />
              </div>
            ) : undefined
          }
        />
      ) : (
        <OutreachBoard leads={rows} canManage={canManage} />
      )}
    </div>
  );
}
