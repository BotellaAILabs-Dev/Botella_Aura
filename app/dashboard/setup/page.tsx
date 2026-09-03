import Link from 'next/link';
import type { Metadata } from 'next';
import { CheckCircle2 } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getOnboardingState } from '@/server/onboarding/checklist.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SetupChecklist } from '@/components/dashboard/onboarding/setup-checklist';

export const metadata: Metadata = { title: 'Set up Aura' };
// Progress is derived from live data — a cached page would show stale steps.
export const dynamic = 'force-dynamic';

/**
 * The full setup sequence.
 *
 * Reachable at any time, not just on day one: someone who skipped the optional
 * steps to get going should be able to come back and see exactly what is left
 * and what each one would buy them.
 */
export default async function SetupPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const state = await getOnboardingState(active.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Set up Aura"
        description={`What Aura knows about ${active.name}, and what would make its work better.`}
      />

      {state.finished ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
              <div>
                <p className="text-sm font-medium text-foreground">
                  Setup is complete
                </p>
                <p className="text-sm text-muted-foreground">
                  Aura has everything it needs. It reports back every Monday —
                  and you can change any of this whenever you like.
                </p>
              </div>
            </div>
            <Button asChild variant="outline" className="shrink-0">
              <Link href="/dashboard">Go to your week</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <SetupChecklist state={state} />
    </div>
  );
}
