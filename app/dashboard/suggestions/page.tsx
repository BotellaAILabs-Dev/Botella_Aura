import Link from 'next/link';
import type { Metadata } from 'next';
import { Sparkles, Telescope } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { can } from '@/lib/rbac';
import { getMembership } from '@/server/services/company.service';
import { getSuggestions } from '@/server/recommendations/suggestions.service';
import { openOpportunitiesWithoutSuggestion } from '@/server/recommendations/autosuggest.service';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import { SuggestActions } from '@/components/dashboard/suggestions/suggest-actions';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { AuraSuggests } from '@/components/dashboard/suggestions/aura-suggests';

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

  const [membership, { suggestions, accepted }, waiting, ctx] =
    await Promise.all([
      getMembership(user.id, active.id),
      getSuggestions(active.id),
      openOpportunitiesWithoutSuggestion(active.id),
      getBusinessContext(active.id, { sections: [] }),
    ]);
  const pending = waiting.length;
  // Every suggestion must be something the business can do; without a
  // channel, the engine will not guess one (lib/recommendation-rules.ts).
  const noChannels = (ctx?.channels.preferred.length ?? 0) === 0;
  const canAct = membership ? can(membership.role, 'company:update') : false;
  const canRecord = membership ? can(membership.role, 'content:create') : false;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Aura Suggests"
        description={`What Aura thinks ${active.name} should consider doing next — and why.`}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/opportunities">
              <Telescope className="h-4 w-4" /> Opportunities
            </Link>
          </Button>
        }
      />
      {suggestions.length === 0 && accepted.length === 0 && noChannels ? (
        <EmptyState
          icon={Sparkles}
          title="Tell Aura where you publish"
          description={`Every suggestion has to be something you can actually do. ${
            pending > 0
              ? `Aura found ${pending} opportunit${pending === 1 ? 'y' : 'ies'}, but`
              : 'Right now'
          } you haven’t said where you publish — LinkedIn, Instagram, a blog, a newsletter — so Aura won’t guess and suggests nothing.`}
          action={
            <Button asChild>
              <Link href="/dashboard/business">Add where you publish</Link>
            </Button>
          }
        />
      ) : suggestions.length === 0 && accepted.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="No suggestions yet"
          description={
            pending > 0
              ? `Aura has ${pending} open opportunit${pending === 1 ? 'y' : 'ies'} it hasn’t made suggestions for yet. It checks each one against its rules — evidence, duplicates, your channels — before suggesting anything.`
              : 'Aura suggests something when it spots an opportunity worth acting on — a trend, a competitor move, or a pattern in your results. It checks your market, competitors and results for new ones when you ask.'
          }
          action={
            <div className="flex flex-col items-center gap-2">
              <SuggestActions pending={pending} canAct={canAct} />
              <Link
                href="/dashboard/opportunities"
                className="text-xs text-primary hover:underline"
              >
                See opportunities
              </Link>
            </div>
          }
        />
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
        <AuraSuggests
          suggestions={suggestions}
          accepted={accepted}
          canAct={canAct}
          canRecord={canRecord}
          surface="suggestions"
        />
      )}
    </div>
  );
}
