import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, Brain, History, Telescope } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { cn } from '@/lib/utils';
import {
  HISTORY_OUTCOMES,
  LEARNING_MIN_SAMPLE,
  OUTCOME_LABEL,
  type HistoryEntry,
  type HistoryOutcome,
} from '@/lib/recommendation-history';
import { listRecommendationHistory } from '@/server/recommendations/history.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { LocalTime } from '@/components/ui/local-time';

export const metadata: Metadata = { title: 'Suggestion history' };
export const dynamic = 'force-dynamic';

const OUTCOME_VARIANT: Record<
  HistoryOutcome,
  'success' | 'default' | 'muted' | 'warning' | 'destructive' | 'outline'
> = {
  accepted: 'default',
  edited: 'default',
  in_progress: 'default',
  completed: 'success',
  skipped: 'muted',
  rejected: 'destructive',
  withdrawn: 'outline',
  expired: 'outline',
};

/**
 * Previous Aura suggestions and what the business did with each — accepted,
 * edited, skipped, turned down, completed — with when, who, what changed,
 * what was made from it, and the opportunity it came from
 * (lib/recommendation-history.ts).
 */
export default async function SuggestionHistoryPage({
  searchParams,
}: {
  searchParams: { outcome?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const outcome = (HISTORY_OUTCOMES as string[]).includes(
    searchParams.outcome ?? '',
  )
    ? (searchParams.outcome as HistoryOutcome)
    : undefined;
  const { entries, counts, learning } = await listRecommendationHistory(
    active.id,
    { outcome },
  );

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Suggestion history"
        description="Everything Aura suggested before, and what you did with it."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/suggestions">
              <ArrowLeft className="h-4 w-4" /> Aura Suggests
            </Link>
          </Button>
        }
      />

      {counts.all === 0 ? (
        <EmptyState
          icon={History}
          title="No history yet"
          description="When you accept, edit, skip or turn down one of Aura’s suggestions, it appears here — with when, what you changed, and the opportunity it came from."
          action={
            <Button asChild variant="outline">
              <Link href="/dashboard/suggestions">See Aura’s suggestions</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-5">
          <nav
            aria-label="Filter by what happened"
            className="flex flex-wrap gap-2"
          >
            {(['all', ...HISTORY_OUTCOMES] as const)
              .filter((k) => k === 'all' || counts[k] > 0)
              .map((k) => {
                const selected = (outcome ?? 'all') === k;
                return (
                  <Link
                    key={k}
                    href={
                      k === 'all'
                        ? '/dashboard/suggestions/history'
                        : `/dashboard/suggestions/history?outcome=${k}`
                    }
                    aria-current={selected ? 'page' : undefined}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs transition-colors',
                      selected
                        ? 'border-primary bg-primary/10 font-medium text-primary'
                        : 'border-border text-muted-foreground hover:border-primary/50',
                    )}
                  >
                    {k === 'all' ? 'All' : OUTCOME_LABEL[k]} ({counts[k]})
                  </Link>
                );
              })}
          </nav>

          <LearningBox learning={learning} answered={counts.all} />

          <ul className="space-y-3">
            {entries.map((e) => (
              <li key={e.id}>
                <HistoryCard e={e} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function When({ label, iso }: { label: string; iso: string | null }) {
  if (!iso) return null;
  return (
    <span>
      {label} <LocalTime iso={iso} kind="date" />
    </span>
  );
}

function HistoryCard({ e }: { e: HistoryEntry }) {
  return (
    <Card>
      <CardContent className="space-y-2 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant={OUTCOME_VARIANT[e.outcome]}>{e.outcomeLabel}</Badge>
          {e.decidedBy && (
            <span className="text-muted-foreground">by {e.decidedBy}</span>
          )}
          {e.channel && <Badge variant="outline">{e.channel}</Badge>}
        </div>
        <p className="font-medium text-foreground">{e.title}</p>
        <p className="text-muted-foreground">{e.action}</p>

        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <When label="Suggested" iso={e.suggestedAt} />
          <When
            label={
              e.outcome === 'expired'
                ? 'Expired'
                : e.outcome === 'skipped'
                  ? 'Skipped'
                  : e.outcome === 'rejected'
                    ? 'Turned down'
                    : 'Decided'
            }
            iso={e.decidedAt}
          />
          <When label="Edited" iso={e.editedAt} />
          <When label="Started" iso={e.startedAt} />
          <When label="Completed" iso={e.completedAt} />
        </p>

        {e.note && (
          <p className="text-xs text-foreground/80">
            <span className="font-medium">Note:</span> {e.note}
          </p>
        )}
        {e.changedFields.length > 0 && (
          <p className="text-xs text-foreground/80">
            <span className="font-medium">You changed:</span>{' '}
            {e.changedFields.join(', ')}
          </p>
        )}
        {e.made.length > 0 && (
          <p className="text-xs text-foreground/80">
            <span className="font-medium">Made from it:</span>{' '}
            {e.made.map((m, i) => (
              <span key={i}>
                {i > 0 && ' · '}
                {m.href ? (
                  <Link href={m.href} className="text-primary hover:underline">
                    {m.label}
                  </Link>
                ) : (
                  m.label
                )}{' '}
                ({m.module})
              </span>
            ))}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs">
          <Link
            href={e.opportunity.href}
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <Telescope className="h-3.5 w-3.5" aria-hidden />
            From: {e.opportunity.title}{' '}
            <span className="text-muted-foreground">
              ({e.opportunity.typeLabel})
            </span>
          </Link>
          {e.repeat && (
            <span className="text-muted-foreground">{e.repeat}</span>
          )}
        </div>

        {e.timeline.length > 1 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              Full history ({e.timeline.length} steps)
            </summary>
            <ol className="mt-2 space-y-1 border-l border-border pl-3">
              {e.timeline.map((t, i) => (
                <li key={i} className="text-muted-foreground">
                  <span className="font-medium text-foreground/80">
                    {t.action}
                  </span>{' '}
                  by {t.by} · <LocalTime iso={t.at} />
                </li>
              ))}
            </ol>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function LearningBox({
  learning,
  answered,
}: {
  learning: { insight: string; confidence: string; sampleSize: number }[];
  answered: number;
}) {
  return (
    <Card className="border-dashed">
      <CardContent className="space-y-1.5 p-4 text-sm">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <Brain className="h-4 w-4 text-primary" aria-hidden /> What Aura is
          learning from your answers
        </p>
        {learning.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No clear pattern yet — Aura needs at least {LEARNING_MIN_SAMPLE}{' '}
            answers of the same kind before it draws a conclusion (you’ve
            answered {answered} so far). Until then it only avoids repeating
            what you skipped or turned down.
          </p>
        ) : (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {learning.map((l) => (
              <li key={l.insight}>
                {l.insight}{' '}
                <span className="text-foreground/60">
                  ({l.confidence.toLowerCase()} confidence)
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
