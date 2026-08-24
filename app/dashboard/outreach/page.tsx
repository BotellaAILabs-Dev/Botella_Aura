import Link from 'next/link';
import type { Metadata } from 'next';
import { Settings2, Send, ShieldCheck, Target } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { listLeads, listLeadCategories } from '@/server/outreach/lead.service';
import { listOutreachHistory } from '@/server/outreach/outreach.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { DetectButton } from '@/components/dashboard/outreach/detect-button';
import { CreateLeadDialog } from '@/components/dashboard/outreach/create-lead-dialog';
import {
  OutreachBoard,
  type LeadRow,
} from '@/components/dashboard/outreach/outreach-board';
import { OutreachHistory } from '@/components/dashboard/outreach/outreach-history';
import type { OutreachStatusKey } from '@/lib/outreach-ui';

export const metadata: Metadata = { title: 'Outreach' };
// Leads arrive from discovery runs and signal detection; always render fresh.
export const dynamic = 'force-dynamic';

export default async function OutreachPage({
  searchParams,
}: {
  searchParams: { category?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, leads, categories, history] = await Promise.all([
    getMembership(user.id, active.id),
    // Same source of truth as the Leads page — a lead visible there is
    // guaranteed to be visible here.
    listLeads(active.id),
    listLeadCategories(active.id),
    listOutreachHistory(active.id),
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
    source: l.source,
    category: l.category,
    fitScore: l.fitScore,
    fitRationale: l.fitRationale,
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
      connectionAccepted: m.connectionAccepted,
      replyReceived: m.replyReceived,
    })),
  }));

  const discoveredCount = rows.filter((r) => r.source === 'DISCOVERY_ENGINE').length;

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild variant="ghost" size="sm">
        <Link href="/dashboard/leads">
          <Target className="h-4 w-4" /> All leads
        </Link>
      </Button>
      <Button asChild variant="ghost" size="sm">
        <Link href="/dashboard/settings/outreach">
          <Settings2 className="h-4 w-4" /> Targeting
        </Link>
      </Button>
      {canManage && (
        <CreateLeadDialog
          categories={categories
            .map((c) => c.category)
            .filter((c): c is string => Boolean(c))}
        />
      )}
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
          description="Set your targeting in settings, then detect signals from public sources (GitHub, news, hiring) — or run a discovery profile from Leads. Everything lands here for you to draft and approve outreach."
          action={
            canManage ? (
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline">
                  <Link href="/dashboard/leads/discover">Discover leads</Link>
                </Button>
                <DetectButton firstRun />
                <CreateLeadDialog />
              </div>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-6">
          {/* Where these leads came from — proves the Leads → Outreach hand-off. */}
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{rows.length}</span> lead
            {rows.length === 1 ? '' : 's'} on this board
            {discoveredCount > 0 && (
              <>
                {' '}
                — <span className="font-medium text-foreground">{discoveredCount}</span>{' '}
                from lead discovery
              </>
            )}
            . Filter by the requirement each one was found for.
          </p>

          <OutreachBoard
            leads={rows}
            categories={categories}
            initialCategory={searchParams.category ?? null}
            canManage={canManage}
          />

          <OutreachHistory
            summary={history.summary}
            rows={history.messages.map((m) => ({
              id: m.id,
              leadName: m.lead.name ?? '',
              companyName: m.lead.companyName,
              linkedInProfileUrl: m.lead.linkedInProfileUrl,
              type: m.type,
              status: m.status as OutreachStatusKey,
              sentAt: m.sentAt ? m.sentAt.toISOString() : null,
              connectionAccepted: m.connectionAccepted,
              replyReceived: m.replyReceived,
            }))}
          />
        </div>
      )}
    </div>
  );
}
