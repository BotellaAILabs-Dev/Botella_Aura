import Link from 'next/link';
import type { Metadata } from 'next';
import { History, Sparkles, Telescope } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { can } from '@/lib/rbac';
import { getMembership } from '@/server/services/company.service';
import { getSuggestions } from '@/server/recommendations/suggestions.service';
import { openOpportunitiesWithoutSuggestion } from '@/server/recommendations/autosuggest.service';
import { getReadiness } from '@/server/recommendations/readiness.service';
import { ReadinessPanel } from '@/components/dashboard/suggestions/readiness-panel';
import { SuggestActions } from '@/components/dashboard/suggestions/suggest-actions';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { AuraSuggests } from '@/components/dashboard/suggestions/aura-suggests';

import { NextBestActions } from '@/components/dashboard/home/next-best-actions';
import { getNextActions } from '@/server/home/next-best-action.service';

export const metadata: Metadata = { title: 'Aura Suggests' };
export const dynamic = 'force-dynamic';

/**
 * Aura Suggests — what Aura believes the business should consider doing
 * next, best first: what, why, the expected outcome, the evidence behind it,
 * and one clear next step (lib/aura-suggests.ts).
 */
export default async function SuggestionsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const membership = await getMembership(user.id, active.id);
  const [{ suggestions, accepted, heldBack }, waiting, readiness, nextActions] =
    await Promise.all([
      getSuggestions(active.id),
      openOpportunitiesWithoutSuggestion(active.id),
      getReadiness(active.id),
      membership ? getNextActions(active.id, membership.role, { limit: 3 }) : Promise.resolve([]),
    ]);
  const pending = waiting.length;
  // Shown once: a suggestion already in "next best action" is not repeated below.
  const above = new Set(
    nextActions.filter((a) => a.source === 'suggestion').map((a) => a.key.slice('suggestion:'.length)),
  );
  const listed = suggestions.filter((s) => !above.has(s.id));
  const canAct = membership ? can(membership.role, 'company:update') : false;
  const canRecord = membership ? can(membership.role, 'content:create') : false;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Aura Suggests"
        description={`What Aura thinks ${active.name} should consider doing next — and why.`}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard/suggestions/history">
                <History className="h-4 w-4" /> History
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard/opportunities">
                <Telescope className="h-4 w-4" /> Opportunities
              </Link>
            </Button>
          </>
        }
      />
      {nextActions.length > 0 && (
        <div className="mb-6">
          <NextBestActions actions={nextActions} canAct={canRecord} />
        </div>
      )}
      {suggestions.length === 0 &&
      accepted.length === 0 &&
      readiness.canRecommend &&
      pending > 0 ? (
        <div className="space-y-4">
          <EmptyState
            icon={Sparkles}
            title="No suggestions yet"
            description={`Aura has ${pending} open opportunit${pending === 1 ? 'y' : 'ies'} it hasn’t made suggestions for yet. It checks each one against its rules — evidence, duplicates, your channels — before suggesting anything.`}
            action={<SuggestActions pending={pending} canAct={canAct} />}
          />
          <ReadinessPanel
            readiness={readiness}
            canAct={canAct}
            variant="compact"
          />
        </div>
      ) : suggestions.length === 0 && accepted.length === 0 ? (
        // The fallback: what Aura needs, in order — never a generic
        // suggestion to fill the page (lib/data-readiness.ts).
        <ReadinessPanel readiness={readiness} canAct={canAct} />
      ) : suggestions.length === 0 ? (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              You’ve answered every suggestion. Aura will add more as it spots
              new opportunities.
            </p>
            <SuggestActions pending={pending} canAct={canAct} />
          </div>
          <AuraSuggests
            suggestions={[]}
            accepted={accepted}
            canAct={canAct}
            canRecord={canRecord}
            surface="suggestions"
          />
        </>
      ) : (
        <div className="space-y-4">
          {readiness.state !== 'ready' && (
            <ReadinessPanel
              readiness={readiness}
              canAct={canAct}
              variant="compact"
            />
          )}
          <AuraSuggests
            suggestions={listed}
            accepted={accepted}
            canAct={canAct}
            canRecord={canRecord}
            surface="suggestions"
          />
        </div>
      )}
      {canAct && heldBack.length > 0 && (
        <details className="mt-6 rounded-md border border-dashed border-border p-4 text-sm">
          <summary className="cursor-pointer font-medium text-foreground">
            Held back by Aura’s quality checks ({heldBack.length})
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">
            These failed a check — unsupported, contradicted, or claiming
            something no evidence shows — so Aura is not presenting them.
          </p>
          <ul className="mt-2 space-y-2">
            {heldBack.map((h) => (
              <li key={h.id} className="text-xs">
                <span className="font-medium text-foreground">{h.title}</span>
                <span className="text-muted-foreground"> — {h.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
