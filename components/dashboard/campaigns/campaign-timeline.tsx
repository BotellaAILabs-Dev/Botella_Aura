import Link from 'next/link';
import {
  FileText,
  Send,
  Radar,
  CalendarCheck,
  ArrowRight,
  CircleDot,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { taskState, taskTypeLabel } from '@/lib/campaign-status';
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

/** Icons only — the labels come from lib/campaign-status.ts. */
const TYPE_ICON: Record<string, typeof FileText> = {
  GENERATE_CONTENT: FileText,
  RUN_OUTREACH_BATCH: Send,
  RUN_DISCOVERY: Radar,
  REVIEW_CHECKPOINT: CalendarCheck,
};

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
                const Icon = TYPE_ICON[t.taskType] ?? FileText;
                // "GENERATED" described what the system did and read as
                // finished, when it means the opposite: it is waiting on you.
                const status = taskState(t.status, t.scheduledDate);
                return (
                  <div key={t.id} className="flex items-start justify-between gap-3 text-sm">
                    <div className="flex items-start gap-2">
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <div>
                        <span className="font-medium">
                          {taskTypeLabel(t.taskType)}
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
                      <Badge variant={status.tone} title={status.hint}>
                        {status.label}
                      </Badge>
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
