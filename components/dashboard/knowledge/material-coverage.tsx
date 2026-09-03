import { Check, Circle } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { CoverageReport } from '@/server/knowledge/coverage';

/**
 * What Aura has learned about the business, and what it is still missing.
 *
 * The knowledge base used to report a chunk count — a number that tells a
 * marketer nothing about whether Aura knows enough to write well. What they
 * actually need to know is which KINDS of material are missing, because that
 * is the only thing they can act on, and because each gap has a specific
 * consequence for the writing.
 *
 * A server component: counts come from the database on every render, so this
 * cannot show stale coverage, and it ships no JavaScript.
 */
export function MaterialCoverage({ coverage }: { coverage: CoverageReport }) {
  const { items, missing, covered, total, uncategorisedChunks } = coverage;
  const topGap = missing[0];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle className="text-base">What Aura knows about your business</CardTitle>
          <p className="text-sm text-muted-foreground">
            {covered} of {total} kinds of material
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="grid gap-2 sm:grid-cols-2">
          {items.map(({ category, chunks, present }) => (
            <li
              key={category.id}
              className={cn(
                'flex items-start gap-2.5 rounded-md border p-2.5',
                present ? 'border-border' : 'border-dashed border-border/70',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
                  present ? 'bg-success/15 text-success' : 'text-muted-foreground/50',
                )}
                aria-hidden
              >
                {present ? <Check className="h-3 w-3" /> : <Circle className="h-2.5 w-2.5" />}
              </span>
              <div className="min-w-0">
                <p
                  className={cn(
                    'text-sm font-medium',
                    present ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {category.label}
                </p>
                {/* Present: what it is doing. Missing: what you would gain. */}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {present
                    ? `${chunks} section${chunks === 1 ? '' : 's'} in use`
                    : category.helps}
                </p>
              </div>
            </li>
          ))}
        </ul>

        {topGap && (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              Biggest gap: {topGap.label}.
            </span>{' '}
            {topGap.helps} Try {topGap.examples.toLowerCase()}.
          </p>
        )}

        {uncategorisedChunks > 0 && (
          // Honest about material that predates categories: it is still used,
          // it just cannot be attributed to a kind above.
          <p className="text-xs text-muted-foreground">
            Aura is also using {uncategorisedChunks} section
            {uncategorisedChunks === 1 ? '' : 's'} from your website and earlier
            uploads, which are not sorted into these kinds.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
