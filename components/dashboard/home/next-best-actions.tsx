import Link from 'next/link';
import { ArrowRight, CheckCircle2, Compass } from 'lucide-react';

import type { ActionSource, NextAction } from '@/lib/next-best-action';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Next best action: the one thing to do now, then what comes after —
 * each as problem → why it matters → what to do (lib/next-best-action.ts).
 */

const SOURCE: Record<ActionSource, string> = {
  setup: 'Business details',
  approval: 'Waiting on you',
  suggestion: 'Aura Suggests',
  gap: 'Marketing gap',
};

const URGENCY: Record<NextAction['urgency'], { label: string; variant: 'destructive' | 'warning' | 'muted' }> = {
  now: { label: 'Do now', variant: 'destructive' },
  soon: { label: 'This week', variant: 'warning' },
  when_you_can: { label: 'When you can', variant: 'muted' },
};

function Origin({ a }: { a: NextAction }) {
  const all = [a.source, ...a.alsoFrom].map((s) => SOURCE[s]);
  return <span className="text-xs text-muted-foreground">{[...new Set(all)].join(' · ')}</span>;
}

export function NextBestActions({ actions, canAct }: { actions: NextAction[]; canAct: boolean }) {
  if (actions.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-primary" /> Nothing needs your attention right now.
        </CardContent>
      </Card>
    );
  }
  const [first, ...rest] = actions;
  return (
    <section aria-labelledby="nba-title" className="space-y-3">
      <div className="flex items-center gap-2">
        <Compass className="h-5 w-5 text-primary" />
        <h2 id="nba-title" className="text-base font-semibold">
          Your next best action
        </h2>
      </div>

      <Card className="border-primary/40">
        <CardContent className="space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={URGENCY[first!.urgency].variant}>{URGENCY[first!.urgency].label}</Badge>
            <Origin a={first!} />
          </div>
          <dl className="grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="font-medium text-muted-foreground">The problem</dt>
            <dd className="font-medium">{first!.problem}</dd>
            <dt className="font-medium text-muted-foreground">Why it matters</dt>
            <dd>{first!.whyItMatters}</dd>
            <dt className="font-medium text-muted-foreground">What to do</dt>
            <dd>{first!.recommendation}</dd>
            {first!.evidence && (
              <>
                <dt className="font-medium text-muted-foreground">Based on</dt>
                <dd className="text-muted-foreground">{first!.evidence}</dd>
              </>
            )}
          </dl>
          {canAct && (
            <Button asChild size="sm">
              <Link href={first!.action.href}>
                {first!.action.label} <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          )}
        </CardContent>
      </Card>

      {rest.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <p className="px-4 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Then</p>
            <ol className="divide-y divide-border">
              {rest.map((a) => (
                <li key={a.key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={URGENCY[a.urgency].variant}>{URGENCY[a.urgency].label}</Badge>
                      <span className="text-sm font-medium">{a.problem}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {a.whyItMatters} <Origin a={a} />
                    </p>
                  </div>
                  {canAct && (
                    <Button asChild size="sm" variant="outline" className="shrink-0">
                      <Link href={a.action.href}>
                        {a.action.label} <ArrowRight className="h-4 w-4" />
                      </Link>
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
