import Link from 'next/link';
import type { Metadata } from 'next';
import { ChevronRight, ClipboardCheck } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { STATE_LABEL, type ReviewKind } from '@/lib/review-item';
import { listReviewQueue } from '@/server/review/review-item.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Review & approve' };
export const dynamic = 'force-dynamic';

const FILTERS: { key: 'all' | ReviewKind; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'content', label: 'Content' },
  { key: 'outreach', label: 'Outreach' },
];
const VERDICT = {
  pass: { label: 'Review passed', variant: 'success' },
  review_required: { label: 'Needs human review', variant: 'warning' },
  fail: { label: 'Review failed', variant: 'destructive' },
} as const;

/**
 * The review queue: every piece of generated Aura work waiting on a person,
 * from every module, opening into the same review screen.
 */
export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: { show?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;
  const show = (FILTERS.find((f) => f.key === searchParams.show)?.key ??
    'all') as 'all' | ReviewKind;
  const all = await listReviewQueue(active.id);
  const rows = show === 'all' ? all : all.filter((r) => r.kind === show);
  const awaiting = all.filter((r) => r.state === 'in_review').length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Review & approve"
        description="Everything Aura has made that is waiting on you — posts, emails, ads and outreach — reviewed the same way."
      />
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const count =
            f.key === 'all'
              ? all.length
              : all.filter((r) => r.kind === f.key).length;
          return (
            <Link
              key={f.key}
              href={
                f.key === 'all'
                  ? '/dashboard/review'
                  : `/dashboard/review?show=${f.key}`
              }
              className={cn(
                'rounded-full border px-3 py-1 text-sm transition',
                show === f.key
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted/50',
              )}
            >
              {f.label} <span className="text-xs">({count})</span>
            </Link>
          );
        })}
        {awaiting > 0 && (
          <span className="text-sm text-muted-foreground">
            {awaiting} awaiting approval
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="Nothing waiting for review"
          description="New drafts from Content Studio, campaigns, the content plan, Autopilot and outreach appear here."
        />
      ) : (
        <ul className="space-y-2" aria-label="Review queue">
          {rows.map((r) => (
            <li key={`${r.kind}-${r.id}`}>
              <Link href={r.href} className="group block">
                <Card className="transition-shadow group-hover:shadow-md">
                  <CardContent className="flex items-start gap-3 p-4">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="muted">{r.module}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {r.typeLabel}
                        </span>
                        <Badge
                          variant={
                            r.state === 'in_review' ? 'warning' : 'outline'
                          }
                        >
                          {STATE_LABEL[r.state]}
                        </Badge>
                        {r.verdict && r.verdict !== 'pass' && (
                          <Badge variant={VERDICT[r.verdict].variant}>
                            {VERDICT[r.verdict].label}
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-sm font-medium text-foreground">
                        {r.title}
                      </p>
                      {r.snippet && (
                        <p className="line-clamp-2 text-sm text-muted-foreground">
                          {r.snippet}
                        </p>
                      )}
                    </div>
                    <span className="mt-1 inline-flex shrink-0 items-center gap-0.5 text-sm font-medium text-primary">
                      Review <ChevronRight className="h-4 w-4" />
                    </span>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
