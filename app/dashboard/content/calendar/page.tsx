import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';

import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { draftSnippet } from '@/lib/content-ui';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ContentTypeKey } from '@/lib/validations/content';
import { DATE_LOCALE } from '@/lib/dates';

export const metadata: Metadata = { title: 'Content calendar' };

const STATUS_DOT: Record<string, string> = {
  DRAFT: 'bg-muted-foreground',
  PENDING_APPROVAL: 'bg-warning',
  APPROVED: 'bg-primary',
  PUBLISHED: 'bg-success',
  REJECTED: 'bg-destructive',
};

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: { month?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  // Parse ?month=YYYY-MM (default current month).
  const now = new Date();
  const [y, m] = (searchParams.month ?? `${now.getFullYear()}-${pad(now.getMonth() + 1)}`)
    .split('-')
    .map(Number);
  const year = y ?? now.getFullYear();
  const month = (m ?? now.getMonth() + 1) - 1; // 0-indexed

  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 1);

  const drafts = await db.contentDraft.findMany({
    where: {
      companyId: active.id,
      OR: [
        { scheduledFor: { gte: start, lt: end } },
        { publishedAt: { gte: start, lt: end } },
        { createdAt: { gte: start, lt: end } },
      ],
    },
    select: {
      id: true,
      type: true,
      status: true,
      body: true,
      scheduledFor: true,
      publishedAt: true,
      createdAt: true,
    },
  });

  // Bucket each draft onto its most meaningful date within the month.
  const byDay = new Map<number, Array<{ id: string; type: ContentTypeKey; status: string; snippet: string }>>();
  for (const d of drafts) {
    const date = d.scheduledFor ?? d.publishedAt ?? d.createdAt;
    if (date < start || date >= end) continue;
    const day = date.getDate();
    const arr = byDay.get(day) ?? [];
    arr.push({
      id: d.id,
      type: d.type as ContentTypeKey,
      status: d.status,
      snippet: draftSnippet(d.type as ContentTypeKey, d.body),
    });
    byDay.set(day, arr);
  }

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leading = start.getDay(); // 0=Sun
  const cells: Array<number | null> = [
    ...Array(leading).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const prev = month === 0 ? `${year - 1}-12` : `${year}-${pad(month)}`;
  const next = month === 11 ? `${year + 1}-01` : `${year}-${pad(month + 2)}`;
  const monthLabel = start.toLocaleString(DATE_LOCALE, { month: 'long', year: 'numeric' });
  const todayKey = now.getFullYear() === year && now.getMonth() === month ? now.getDate() : -1;

  return (
    <div>
      <Link
        href="/dashboard/content"
        className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Content Studio
      </Link>
      <PageHeader
        title="Content calendar"
        description="Your drafts, scheduled, and published content by date."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="icon">
              <Link href={`/dashboard/content/calendar?month=${prev}`} aria-label="Previous month">
                <ChevronLeft className="h-4 w-4" />
              </Link>
            </Button>
            <span className="min-w-40 text-center text-sm font-medium">{monthLabel}</span>
            <Button asChild variant="outline" size="icon">
              <Link href={`/dashboard/content/calendar?month=${next}`} aria-label="Next month">
                <ChevronRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border text-sm">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div key={d} className="bg-muted/50 px-2 py-1.5 text-center text-xs font-medium text-muted-foreground">
            {d}
          </div>
        ))}
        {cells.map((day, i) => (
          <div
            key={i}
            className={cn(
              'min-h-24 bg-card p-1.5 align-top',
              day === null && 'bg-muted/20',
            )}
          >
            {day !== null && (
              <>
                <div className="mb-1 flex items-center justify-between">
                  <span
                    className={cn(
                      'text-xs',
                      day === todayKey
                        ? 'flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground'
                        : 'text-muted-foreground',
                    )}
                  >
                    {day}
                  </span>
                </div>
                <div className="space-y-1">
                  {(byDay.get(day) ?? []).slice(0, 3).map((item) => (
                    <Link
                      key={item.id}
                      href={`/dashboard/content/${item.id}`}
                      className="flex items-center gap-1 rounded bg-muted/60 px-1.5 py-1 text-[11px] hover:bg-muted"
                    >
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[item.status])} />
                      <span className="truncate">{item.snippet || 'Draft'}</span>
                    </Link>
                  ))}
                  {(byDay.get(day)?.length ?? 0) > 3 && (
                    <span className="px-1 text-[10px] text-muted-foreground">
                      +{(byDay.get(day)?.length ?? 0) - 3} more
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
