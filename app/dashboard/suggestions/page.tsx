import Link from 'next/link';
import type { Metadata } from 'next';
import { Sparkles, Telescope } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { can } from '@/lib/rbac';
import { getMembership } from '@/server/services/company.service';
import { getSuggestions } from '@/server/recommendations/suggestions.service';
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

  const [membership, { suggestions, accepted }] = await Promise.all([
    getMembership(user.id, active.id),
    getSuggestions(active.id),
  ]);
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
      {suggestions.length === 0 && accepted.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="No suggestions right now"
          description="Aura suggests something when it spots an opportunity worth acting on — a trend, a competitor move, or a pattern in your results. You can also ask for one from any opportunity."
          action={
            <Button asChild variant="outline">
              <Link href="/dashboard/opportunities">See opportunities</Link>
            </Button>
          }
        />
      ) : suggestions.length === 0 ? (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            You’ve answered every suggestion. Aura will add more as it spots new
            opportunities.
          </p>
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
