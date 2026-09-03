import Link from 'next/link';
import { Check, ArrowRight, Circle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { OnboardingState } from '@/server/onboarding/checklist.service';

/**
 * The setup sequence, as one screen.
 *
 * Three rules decide how this looks:
 *
 *   1. ONE next action. The current step is the only one with a button. Seven
 *      buttons is the same problem as no buttons — the user has to work out
 *      which matters, which is the job this component exists to do for them.
 *   2. Done steps stay visible but recede. Hiding them loses the sense of
 *      progress; giving them equal weight buries the one thing left to do.
 *   3. Every step says what it BUYS you, not what it is. "Aura writes TO a
 *      person and aims at a number" is a reason to spend two minutes;
 *      "configure audience settings" is a chore.
 *
 * A server component: the state comes from the database on every render, so it
 * cannot show stale progress, and it ships no JavaScript.
 */
export function SetupChecklist({
  state,
  variant = 'full',
}: {
  state: OnboardingState;
  /**
   * 'full' — the setup page, every step expanded.
   * 'compact' — the dashboard home, where the briefing is the main event and
   * this is a strip above it.
   */
  variant?: 'full' | 'compact';
}) {
  const { steps, completed, total, nextStep } = state;
  const pct = Math.round((completed / total) * 100);

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-foreground">
              {completed === 0
                ? 'Set Aura up — it takes about ten minutes'
                : 'Finish setting Aura up'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {completed} of {total} done
            </p>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={completed}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-label="Setup progress"
          >
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          {nextStep && (
            <p className="text-sm text-muted-foreground">
              Each step makes what Aura writes better. Only the first is
              required — you can stop any time and come back.
            </p>
          )}
        </div>

        <ol className="space-y-1">
          {steps.map((step, index) => {
            // Compact mode keeps the list short: everything done so far,
            // collapsed, plus the step they are on. The rest is a count.
            if (variant === 'compact' && !step.done && !step.current) return null;

            return (
              <li
                key={step.id}
                className={cn(
                  'flex items-start gap-3 rounded-md p-3 transition-colors',
                  step.current && 'bg-primary/5 ring-1 ring-primary/20',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                    step.done
                      ? 'bg-primary text-primary-foreground'
                      : step.current
                        ? 'border-2 border-primary text-primary'
                        : 'bg-muted text-muted-foreground',
                  )}
                  aria-hidden
                >
                  {step.done ? <Check className="h-3.5 w-3.5" /> : index + 1}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p
                      className={cn(
                        'text-sm font-medium',
                        step.done
                          ? 'text-muted-foreground line-through decoration-muted-foreground/40'
                          : 'text-foreground',
                      )}
                    >
                      {step.title}
                    </p>
                    {step.done && step.detail && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {step.detail}
                      </span>
                    )}
                    {!step.done && !step.current && !step.required && (
                      <span className="text-[11px] text-muted-foreground">
                        Optional
                      </span>
                    )}
                  </div>

                  {/* The reason only appears where a decision is being made:
                      on the step they are about to do. Repeating it on seven
                      rows is noise they have to read past. */}
                  {step.current && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {step.why}
                    </p>
                  )}
                </div>

                {step.current && (
                  <Button asChild size="sm" className="shrink-0">
                    <Link href={step.href}>
                      {step.cta} <ArrowRight className="h-4 w-4" />
                    </Link>
                  </Button>
                )}
              </li>
            );
          })}
        </ol>

        {variant === 'compact' && nextStep && (
          <div className="flex items-center gap-2 border-t border-border pt-3 text-sm text-muted-foreground">
            <Circle className="h-3 w-3" aria-hidden />
            <Link href="/dashboard/setup" className="text-primary hover:underline">
              See all {total} setup steps
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
