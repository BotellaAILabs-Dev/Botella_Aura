import Link from 'next/link';
import type { Metadata } from 'next';
import { PenLine } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { listPlans } from '@/server/planner/plan.service';
import { getWorkspaceProfile } from '@/server/company/profile.service';
import type { MarketingPlanPayload } from '@/server/planner/plan.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DATE_LOCALE } from '@/lib/dates';
import { planBriefFrom } from '@/lib/recommendation-creation';
import { getCreation } from '@/server/recommendations/creation.service';
import {
  PlannerView,
  type PlanView,
  type PlannerInputsView,
} from '@/components/dashboard/planner/planner-view';

export const metadata: Metadata = { title: 'Content plan' };
export const dynamic = 'force-dynamic';

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export default async function PlannerPage({
  searchParams,
}: {
  searchParams: { month?: string; rec?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, plans, { marketing }, creation] = await Promise.all([
    getMembership(user.id, active.id),
    listPlans(active.id),
    getWorkspaceProfile(active.id),
    // `?rec=`: planning for an Aura recommendation (lib/recommendation-creation.ts).
    searchParams.rec
      ? getCreation(active.id, searchParams.rec, 'content-plan')
      : null,
  ]);
  const fromSuggestion = creation
    ? {
        id: creation.plan.recommendationId,
        title: creation.handoff.action.title,
        plan: creation.plan,
        prefill: creation.plan.canCreate ? planBriefFrom(creation.handoff) : null,
      }
    : null;
  const canGenerate = membership ? can(membership.role, 'content:create') : false;

  const selected =
    plans.find((p) => monthKey(p.month) === searchParams.month) ?? plans[0] ?? null;

  const payload = selected
    ? (selected.payload as unknown as MarketingPlanPayload)
    : null;

  const plan: PlanView | null = payload
    ? {
        month: payload.month ?? monthKey(selected!.month),
        generatedAt: payload.generatedAt ?? selected!.generatedAt.toISOString(),
        model: payload.model ?? selected!.model,
        summary: payload.summary ?? '',
        weeks: payload.weeks ?? [],
        items: payload.items ?? [],
        groundedOn: payload.groundedOn ?? [],
        ...(payload.outline ? { outline: payload.outline } : {}),
      }
    : null;

  const savedInputs = selected
    ? (selected.inputs as unknown as PlannerInputsView)
    : null;

  // Pre-fill a first plan from what the workspace already told us on the
  // audience settings page, rather than asking the same questions twice.
  // Channels only when they picked some — an empty list would wipe the
  // sensible LinkedIn default and leave the form failing validation.
  const plannerDefaults: Partial<PlannerInputsView> | null = marketing
    ? {
        ...(marketing.audience ? { audience: marketing.audience } : {}),
        ...(marketing.goals ? { businessGoals: marketing.goals } : {}),
        ...(marketing.channels?.length ? { channels: marketing.channels } : {}),
      }
    : null;

  return (
    <div>
      <PageHeader
        title="Content plan"
        description="State your goals, objectives, topics, and brand rules — Aura turns them into a dated monthly content calendar you can draft straight from."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/content">
              <PenLine className="h-4 w-4" /> Content Studio
            </Link>
          </Button>
        }
      />

      {plans.length > 1 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {plans.map((p) => {
            const key = monthKey(p.month);
            const isSelected = p.id === selected?.id;
            return (
              <Button
                key={p.id}
                asChild
                variant={isSelected ? 'default' : 'outline'}
                size="sm"
              >
                <Link href={`/dashboard/planner?month=${key}`}>
                  {p.month.toLocaleDateString(DATE_LOCALE, {
                    month: 'short',
                    year: 'numeric',
                    timeZone: 'UTC',
                  })}
                  {isSelected && (
                    <Badge variant="secondary" className="ml-1">
                      showing
                    </Badge>
                  )}
                </Link>
              </Button>
            );
          })}
        </div>
      )}

      <PlannerView
        plan={plan}
        savedInputs={savedInputs}
        defaults={plannerDefaults}
        canGenerate={canGenerate}
        fromSuggestion={fromSuggestion}
      />
    </div>
  );
}
