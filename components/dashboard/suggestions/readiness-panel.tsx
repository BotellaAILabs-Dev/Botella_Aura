import Link from 'next/link';
import { AlertCircle, ArrowRight, Info, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { Readiness, ReadinessItem } from '@/lib/data-readiness';
import { SuggestActions } from '@/components/dashboard/suggestions/suggest-actions';

/**
 * The fallback when Aura cannot (or cannot fully) recommend: what it is
 * missing, in order, each with one next step — instead of a generic
 * suggestion to fill the space (lib/data-readiness.ts).
 *
 *   full     the whole empty state of Aura Suggests
 *   compact  one line on Home, or above suggestions that are limited
 */
export function ReadinessPanel({
  readiness,
  canAct,
  variant = 'full',
}: {
  readiness: Readiness;
  canAct: boolean;
  variant?: 'full' | 'compact';
}) {
  if (readiness.state === 'ready') return null;

  if (variant === 'compact') {
    const item = readiness.primary ?? readiness.items[0]!;
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        {readiness.canRecommend ? (
          <Info className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        ) : (
          <AlertCircle
            className="h-4 w-4 shrink-0 [color:hsl(38_92%_40%)]"
            aria-hidden
          />
        )}
        <span>
          <span className="font-medium text-foreground">{item.title}.</span>{' '}
          {item.message}
        </span>
        <NextStepLink item={item} canAct={canAct} small />
      </p>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-primary/10 p-2 text-primary">
            <Sparkles className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {readiness.canRecommend
                ? 'Aura can suggest — and could do better with a little more'
                : 'What Aura needs before it can suggest anything'}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Aura only suggests what your own information supports. Rather than
              fill this page with generic ideas, here is what’s missing.
            </p>
          </div>
        </div>
        <ol className="space-y-3">
          {readiness.items.map((item, i) => (
            <li
              key={`${item.scenario}-${i}`}
              className={cn(
                'flex flex-wrap items-start justify-between gap-3 rounded-md border p-3',
                item.severity === 'blocking'
                  ? 'border-warning/50'
                  : 'border-border',
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {item.title}
                  {item.severity === 'blocking' && (
                    <span className="ml-2 text-xs font-normal [color:hsl(38_92%_35%)] dark:[color:hsl(var(--warning))]">
                      needed first
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {item.message}
                </p>
              </div>
              <NextStepLink item={item} canAct={canAct} />
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function NextStepLink({
  item,
  canAct,
  small = false,
}: {
  item: ReadinessItem;
  canAct: boolean;
  small?: boolean;
}) {
  if (!item.next) return null;
  if (item.next.action === 'detect_opportunities') {
    return canAct ? <SuggestActions pending={0} canAct={canAct} /> : null;
  }
  if (!item.next.href) return null;
  return small ? (
    <Link
      href={item.next.href}
      className="inline-flex items-center gap-1 text-primary hover:underline"
    >
      {item.next.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
    </Link>
  ) : (
    <Button
      asChild
      size="sm"
      variant={item.severity === 'blocking' ? 'default' : 'outline'}
    >
      <Link href={item.next.href}>{item.next.label}</Link>
    </Button>
  );
}
