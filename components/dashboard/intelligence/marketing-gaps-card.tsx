import Link from 'next/link';
import { ArrowRight, CheckCircle2, Telescope } from 'lucide-react';

import { gapHref, type MarketingGap } from '@/lib/marketing-gaps';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The marketing gaps in the business's own posting, each with the post that
 * closes it (Content Studio, brief filled in). See lib/marketing-gaps.ts.
 */

const SEVERITY: Record<MarketingGap['severity'], { label: string; variant: 'destructive' | 'warning' | 'muted' }> = {
  high: { label: 'Fix first', variant: 'destructive' },
  medium: { label: 'Worth doing', variant: 'warning' },
  low: { label: 'Idea', variant: 'muted' },
};

export function MarketingGapsCard({
  gaps,
  canCreate,
  hasProducts,
}: {
  gaps: MarketingGap[];
  canCreate: boolean;
  hasProducts: boolean;
}) {
  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Telescope className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Marketing gaps</CardTitle>
        </div>
        <CardDescription>
          What your published posts are missing, from your own products, channels and results.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {gaps.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-primary" /> No gaps found in your recent posting.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {gaps.map((g) => (
              <li key={g.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={SEVERITY[g.severity].variant}>{SEVERITY[g.severity].label}</Badge>
                    <span className="text-sm font-medium">{g.title}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{g.evidence}</p>
                </div>
                {canCreate && (
                  <Button asChild size="sm" variant="outline" className="shrink-0">
                    <Link href={gapHref(g)}>
                      {g.action.label} <ArrowRight className="h-4 w-4" />
                    </Link>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!hasProducts && (
          <p className="text-xs text-muted-foreground">
            Add your products on{' '}
            <Link href="/dashboard/business#field-identity.products" className="text-primary underline-offset-2 hover:underline">
              About my business
            </Link>{' '}
            and Aura will also tell you which ones you have stopped posting about.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
