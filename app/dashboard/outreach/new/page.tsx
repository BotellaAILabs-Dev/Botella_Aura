import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { can } from '@/lib/rbac';
import { outreachCreationHandoff } from '@/lib/creation-handoff';
import { executionGate } from '@/lib/execution-gate';
import { getMembership } from '@/server/services/company.service';
import { listLeads } from '@/server/outreach/lead.service';
import { getCreation } from '@/server/recommendations/creation.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CreationContextPanel } from '@/components/dashboard/recommendations/creation-context-panel';
import {
  OutreachFromSuggestion,
  type PickableLead,
} from '@/components/dashboard/outreach/outreach-from-suggestion';

export const metadata: Metadata = { title: 'Outreach from a suggestion' };
export const dynamic = 'force-dynamic';

/**
 * `?rec=<id>` — the Outreach creation handoff (lib/creation-handoff.ts):
 * what the suggestion carries (audience, goal, CTA, channel, requirements),
 * and the leads to draft for. Drafts go through the normal approval flow;
 * sending waits for execution (lib/execution-gate.ts).
 */
export default async function OutreachFromSuggestionPage({
  searchParams,
}: {
  searchParams: { rec?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;
  // Outreach is created from a suggestion; without one, the board is where it lives.
  if (!searchParams.rec) redirect('/dashboard/outreach');

  const [membership, creation] = await Promise.all([
    getMembership(user.id, active.id),
    getCreation(active.id, searchParams.rec, 'outreach'),
  ]);
  const back = (
    <Button asChild variant="ghost" size="sm">
      <Link href="/dashboard/outreach">
        <ArrowLeft className="h-4 w-4" /> Outreach
      </Link>
    </Button>
  );

  if (!creation || !creation.plan.canCreate) {
    return (
      <div className="space-y-4">
        <PageHeader title="Outreach from a suggestion" actions={back} />
        <Card>
          <CardContent className="space-y-2 p-4 text-sm">
            <p>{creation?.plan.message ?? 'That suggestion was not found.'}</p>
            {creation?.plan.fix && (
              <Button asChild size="sm" variant="outline">
                <Link href={creation.plan.fix.href}>{creation.plan.fix.label}</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const handoff = outreachCreationHandoff(creation.handoff);
  const gate = executionGate('outreach', true);
  const mayDraft = Boolean(membership && can(membership.role, 'content:approve'));
  const leads = await listLeads(active.id);
  const pickable: PickableLead[] = leads.slice(0, 50).map((l) => ({
    id: l.id,
    name: l.name,
    companyName: l.companyName,
    title: l.title,
    fitScore: l.fitScore,
    signal: l.signals[0]?.description ?? null,
    contacted: l.messages.length > 0,
  }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Outreach from a suggestion"
        description="Drafted from Aura’s suggestion — check what it carries, then choose who to write to."
        actions={back}
      />
      <CreationContextPanel context={handoff.context} gate={gate.message} />
      {mayDraft ? (
        <OutreachFromSuggestion
          recommendationId={creation.plan.recommendationId}
          leads={pickable}
          acceptsOnCreate={creation.plan.acceptsOnCreate}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Only owners and admins can draft outreach.</p>
      )}
    </div>
  );
}
