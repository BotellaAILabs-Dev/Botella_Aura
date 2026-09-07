import Link from 'next/link';
import {
  FileText,
  Send,
  Radar,
  CalendarCheck,
  ArrowRight,
  CircleDot,
} from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { DATE_LOCALE } from '@/lib/dates';

export interface TaskRow {
  id: string;
  scheduledDate: string;
  taskType: string;
  status: string;
  contentType: string | null;
  topic: string | null;
  rationale: string | null;
  relatedContentDraftId: string | null;
  checkpointSummary: string | null;
}

const TYPE_META: Record<string, { icon: typeof FileText; label: string }> = {
  GENERATE_CONTENT: { icon: FileText, label: 'Content' },
  RUN_OUTREACH_BATCH: { icon: Send, label: 'Outreach batch' },
  RUN_DISCOVERY: { icon: Radar, label: 'Lead discovery' },
  REVIEW_CHECKPOINT: { icon: CalendarCheck, label: 'Weekly review' },
};

function statusVariant(s: string): BadgeProps['variant'] {
  if (s === 'APPROVED') return 'success';
  if (s === 'GENERATED') return 'warning';
  if (s === 'FAILED') return 'destructive';
  if (s === 'SKIPPED') return 'muted';
  return 'outline'; // PENDING
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString(DATE_LOCALE, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function CampaignTimeline({ tasks }: { tasks: TaskRow[] }) {
  // Group by scheduled day.
  const byDay = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    const key = t.scheduledDate.slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(t);
  }
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const todayKey = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-3">
      {days.map(([day, dayTasks]) => {
        const isToday = day === todayKey;
        return (
          <div
            key={day}
            className={`rounded-lg border p-4 ${isToday ? 'border-primary/40 bg-primary/5' : 'border-border'}`}
          >
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <CircleDot className={`h-4 w-4 ${isToday ? 'text-primary' : 'text-muted-foreground'}`} />
              {fmtDay(dayTasks[0]!.scheduledDate)}
              {isToday && <Badge variant="default">Today</Badge>}
            </div>
            <div className="space-y-2 pl-6">
              {dayTasks.map((t) => {
                const meta = TYPE_META[t.taskType] ?? { icon: FileText, label: t.taskType };
                const Icon = meta.icon;
                return (
                  <div key={t.id} className="flex items-start justify-between gap-3 text-sm">
                    <div className="flex items-start gap-2">
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <div>
                        <span className="font-medium">
                          {meta.label}
                          {t.contentType ? ` · ${t.contentType.replace('_', ' ').toLowerCase()}` : ''}
                        </span>
                        {t.topic && <span className="block text-muted-foreground">{t.topic}</span>}
                        {t.checkpointSummary && (
                          <p className="mt-1 rounded-md bg-muted/50 p-2 text-xs text-foreground">
                            {t.checkpointSummary}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant={statusVariant(t.status)}>{t.status}</Badge>
                      {t.relatedContentDraftId && (
                        <Link
                          href={`/dashboard/content/${t.relatedContentDraftId}`}
                          className="inline-flex items-center text-primary hover:underline"
                        >
                          Review <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
