import type { Metadata } from 'next';
import {
  Brain,
  TrendingUp,
  TrendingDown,
  LayoutTemplate,
  Clock,
  Hash,
  MessageSquare,
  Info,
} from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { listMemories, isInsufficient } from '@/server/memory/memory.service';
import {
  getContentPerformance,
  bestWorst,
  engagementTrend,
} from '@/server/memory/performance.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AnalyzeButton } from '@/components/dashboard/memory/analyze-button';
import { TrendChart } from '@/components/dashboard/memory/trend-chart';
import type { MarketingMemory } from '@prisma/client';

export const metadata: Metadata = { title: 'Marketing Memory' };

const CATEGORY_ICON: Record<string, typeof Brain> = {
  CONTENT_FORMAT: LayoutTemplate,
  CONTENT_LENGTH: MessageSquare,
  TIMING: Clock,
  TOPIC: Hash,
  HASHTAG: Hash,
  OUTREACH_APPROACH: MessageSquare,
  OTHER: Info,
};

function confidenceVariant(c: string): BadgeProps['variant'] {
  if (c === 'HIGH') return 'success';
  if (c === 'MEDIUM') return 'warning';
  return 'muted';
}

export default async function MemoryPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, memories, perf] = await Promise.all([
    getMembership(user.id, active.id),
    listMemories(active.id),
    getContentPerformance(active.id),
  ]);
  const canManage = membership ? can(membership.role, 'content:approve') : false;

  const insufficient = memories.find(isInsufficient);
  const realInsights = memories.filter((m) => !isInsufficient(m));
  const { best, worst } = bestWorst(perf);
  const trend = engagementTrend(perf);

  return (
    <div>
      <PageHeader
        title="Marketing Memory"
        description="What we've learned about your audience — data-backed patterns that make every future draft smarter."
        actions={canManage ? <AnalyzeButton /> : undefined}
      />

      {/* Honest low-sample state */}
      {insufficient && (
        <div className="mb-6 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm">
          <Info className="mt-0.5 h-5 w-5 shrink-0 [color:hsl(var(--warning))]" />
          <p>{insufficient.insight}</p>
        </div>
      )}

      {memories.length === 0 && (
        <EmptyState
          icon={Brain}
          title="No learnings yet"
          description="Once you publish content and sync its metrics (via the extension), Aura analyzes what works and remembers it — feeding smarter drafts every week."
          action={canManage ? <AnalyzeButton firstRun /> : undefined}
        />
      )}

      {/* Insight cards grouped by category */}
      {realInsights.length > 0 && (
        <div className="mb-8 grid gap-4 md:grid-cols-2">
          {realInsights.map((m) => (
            <InsightCard key={m.id} memory={m} />
          ))}
        </div>
      )}

      {/* Engagement trend */}
      {perf.length > 0 && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4 text-primary" /> Engagement over time
            </CardTitle>
          </CardHeader>
          <CardContent>
            <TrendChart points={trend} />
          </CardContent>
        </Card>
      )}

      {/* Best / worst */}
      {perf.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          <RankCard title="Top performing" icon={TrendingUp} items={best} tone="up" />
          <RankCard title="Lowest performing" icon={TrendingDown} items={worst} tone="down" />
        </div>
      )}
    </div>
  );
}

function InsightCard({ memory }: { memory: MarketingMemory }) {
  const Icon = CATEGORY_ICON[memory.insightType] ?? Brain;
  const basis = (memory.supportingDataSummary ?? {}) as { basis?: string };
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
            <Icon className="h-4 w-4" /> {memory.insightType.replace(/_/g, ' ')}
          </CardTitle>
          <Badge variant={confidenceVariant(memory.confidence)}>
            {memory.confidence} confidence
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">{memory.insight}</p>
        <p className="text-xs text-muted-foreground">
          Based on {memory.sampleSize} posts{basis.basis ? ` · ${basis.basis}` : ''}
        </p>
      </CardContent>
    </Card>
  );
}

function RankCard({
  title,
  icon: Icon,
  items,
  tone,
}: {
  title: string;
  icon: typeof TrendingUp;
  items: { draftId: string; title: string; engagement: number; type: string }[];
  tone: 'up' | 'down';
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className={tone === 'up' ? 'h-4 w-4 text-success' : 'h-4 w-4 text-muted-foreground'} />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="space-y-2">
          {items.map((it) => (
            <li key={it.draftId} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate text-muted-foreground">{it.title}</span>
              <Badge variant="muted">{it.engagement}</Badge>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
