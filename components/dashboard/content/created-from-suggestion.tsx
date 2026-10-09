import Link from 'next/link';
import { ExternalLink, Sparkles } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import type { CreationProvenance } from '@/lib/recommendation-creation';

/**
 * On a draft made from an Aura recommendation: which suggestion, why, on what
 * evidence, and the opportunity behind it (lib/recommendation-creation.ts).
 * Read from what the draft kept when it was written — so it stays true even
 * if the suggestion changes later.
 *
 * Drafts written before this kept only the id and title; they show just the
 * link.
 */
export function CreatedFromSuggestion({
  recommendation: p,
}: {
  recommendation: Partial<CreationProvenance> & { id?: string; title?: string };
}) {
  return (
    <Card className="border-primary/30">
      <CardContent className="space-y-2 p-4 text-sm">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden />
          Created from Aura’s suggestion
        </p>
        <Link
          href="/dashboard/suggestions/history"
          className="block font-medium text-primary hover:underline"
        >
          {p.title ?? 'Aura’s suggestion'}
        </Link>
        {p.why && <p className="text-xs text-muted-foreground">{p.why}</p>}
        {p.goal && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80">Serves:</span>{' '}
            {p.goal}
          </p>
        )}
        {p.audience && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80">For:</span>{' '}
            {p.audience}
          </p>
        )}
        {p.expectedOutcome && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80">
              Expected outcome:
            </span>{' '}
            {p.expectedOutcome}
          </p>
        )}
        {p.evidence && p.evidence.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground/80">Based on</p>
            <ul className="space-y-0.5">
              {p.evidence.map((e) => (
                <li key={e.label} className="text-xs text-muted-foreground">
                  {e.url ? (
                    <a
                      href={e.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                    >
                      {e.label} <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  ) : (
                    e.label
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {p.opportunityId && (
          <Link
            href={`/dashboard/opportunities?focus=${p.opportunityId}`}
            className="inline-block text-xs text-primary hover:underline"
          >
            See the opportunity behind it
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
