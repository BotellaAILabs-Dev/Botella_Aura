import Link from 'next/link';
import { ArrowRight, Info } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { CreationPlan } from '@/lib/recommendation-creation';

/**
 * Shown in place of the writing form when a recommendation has nothing to
 * write (lib/recommendation-creation.ts): an action suggestion — connect a
 * channel, add an audience — or one that is skipped, turned down or done.
 * It says why, and offers where the suggestion IS carried out, instead of a
 * blank form that would quietly write something generic.
 */
export function CreationNotice({
  plan,
  title,
}: {
  plan: CreationPlan;
  /** The suggestion's title. */
  title: string;
}) {
  return (
    <Card className="border-primary/30">
      <CardContent className="space-y-3 p-4 text-sm">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 space-y-1">
            <p className="font-medium text-foreground">
              {plan.state === 'not_creatable'
                ? 'Nothing to write for this suggestion'
                : 'This suggestion is closed'}
            </p>
            <p className="text-muted-foreground">
              <span className="text-foreground">“{title}”</span> —{' '}
              {plan.message}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {plan.fix && (
            <Button asChild size="sm">
              <Link href={plan.fix.href}>
                {plan.fix.label} <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          )}
          <Button asChild size="sm" variant="outline">
            <Link href="/dashboard/content/new">
              Write something else instead
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
