import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ArrowLeft, ExternalLink, Radar, Sparkles } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { getLeadDetail } from '@/server/leads/detail.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { LeadDraftButton } from '@/components/dashboard/leads/lead-draft-button';
import { SIGNAL_LABELS, OUTREACH_STATUS_LABELS, outreachStatusVariant, type OutreachStatusKey } from '@/lib/outreach-ui';

export const metadata: Metadata = { title: 'Lead' };

export default async function LeadDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, lead] = await Promise.all([
    getMembership(user.id, active.id),
    getLeadDetail(active.id, params.id),
  ]);
  if (!lead) notFound();
  const canManage = membership ? can(membership.role, 'content:approve') : false;

  return (
    <div>
      <PageHeader
        title={lead.name ? `${lead.name} · ${lead.companyName}` : lead.companyName}
        description={lead.title ?? undefined}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/leads">
              <ArrowLeft className="h-4 w-4" /> All leads
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* Fit */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-primary" /> AI fit
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {lead.fitScore != null ? (
                <>
                  <Badge
                    variant={
                      lead.fitScore >= 75 ? 'success' : lead.fitScore >= 50 ? 'warning' : 'muted'
                    }
                  >
                    Fit score {lead.fitScore}/100
                  </Badge>
                  <p className="text-sm text-muted-foreground">{lead.fitRationale}</p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Not scored (added via {lead.source.toLowerCase()}).
                </p>
              )}
            </CardContent>
          </Card>

          {/* Signals */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Signals</CardTitle>
            </CardHeader>
            <CardContent>
              {lead.signals.length === 0 ? (
                <p className="text-sm text-muted-foreground">No signals detected.</p>
              ) : (
                <ul className="space-y-2">
                  {lead.signals.map((s) => (
                    <li key={s.id} className="flex items-start gap-2 text-sm">
                      <Badge variant="outline">{SIGNAL_LABELS[s.signalType] ?? s.signalType}</Badge>
                      <span className="text-muted-foreground">
                        {s.description}{' '}
                        {s.sourceUrl && (
                          <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-primary">
                            <ExternalLink className="inline h-3 w-3" />
                          </a>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Outreach history */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Outreach</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {lead.messages.length === 0 ? (
                <>
                  <p className="text-sm text-muted-foreground">No outreach yet.</p>
                  {canManage && <LeadDraftButton leadId={lead.id} />}
                </>
              ) : (
                lead.messages.map((m) => (
                  <div key={m.id} className="rounded-md border border-border p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-sm font-medium">{m.type}</span>
                      <Badge variant={outreachStatusVariant(m.status as OutreachStatusKey)}>
                        {OUTREACH_STATUS_LABELS[m.status as OutreachStatusKey]}
                      </Badge>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                      {m.draftText}
                    </p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        {/* Meta sidebar */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Source">
                <Badge variant={lead.source === 'DISCOVERY_ENGINE' ? 'default' : 'outline'}>
                  {lead.source}
                </Badge>
              </Row>
              <Row label="Status">
                <Badge variant="secondary">{lead.status}</Badge>
              </Row>
              {lead.discoveryProfile && (
                <Row label="Found by">
                  <span className="inline-flex items-center gap-1">
                    <Radar className="h-3 w-3" /> {lead.discoveryProfile.name}
                  </span>
                </Row>
              )}
              {lead.linkedInProfileUrl && (
                <Row label="LinkedIn">
                  <a href={lead.linkedInProfileUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    Profile
                  </a>
                </Row>
              )}
              {lead.sourceUrl && (
                <Row label="Source URL">
                  <a href={lead.sourceUrl} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline">
                    Link
                  </a>
                </Row>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
