import Link from 'next/link';
import type { Metadata } from 'next';
import { Brain, TrendingUp, TrendingDown, Info } from 'lucide-react';

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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AnalyzeButton } from '@/components/dashboard/memory/analyze-button';
import { InsightCard } from '@/components/dashboard/memory/insight-card';
import { TrendChart } from '@/components/dashboard/memory/trend-chart';
import { MIN_SAMPLE_FOR_INSIGHTS } from '@/server/memory/metrics';

export const metadata: Metadata = { title: 'What works for you' };

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

  // How many published posts actually have numbers attached — the real gate.
  const publishedWithMetrics = perf.length;

  const insufficient = memories.find(isInsufficient);
  const realInsights = memories.filter((m) => !isInsufficient(m));
  const { best, worst } = bestWorst(perf);
  const trend = engagementTrend(perf);

  return (
    <div>
      <PageHeader
        title="What works for you"
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
          description={
            // "Not enough data" with no number reads as "come back never".
            // Say exactly what the gate is and how far off it is, and that
            // it is posts-with-numbers — not elapsed time — that moves it.
            `Aura needs results from at least ${MIN_SAMPLE_FOR_INSIGHTS} published posts before it will claim a pattern — you have ${publishedWithMetrics}. This is a count of posts with real numbers attached, not a waiting period: publish, then sync metrics via the extension, connect Google Analytics, or log the numbers by hand on the Results page.`
          }
          // Everyone gets a next step. A manager can run the analysis; anyone
          // else was previously left with an explanation and nowhere to click,
          // so they get the one action that always moves the gate — putting a
          // real number against a post.
          action={
            canManage ? (
              <AnalyzeButton firstRun />
            ) : (
              <Button asChild variant="outline">
                <Link href="/dashboard/analytics">Log results from a post</Link>
              </Button>
            )
          }
        />
      )}

      {/* Insight cards grouped by category */}
      {realInsights.length > 0 && (
        <div className="mb-8 grid gap-4 md:grid-cols-2">
          {realInsights.map((m) => {
            const summary = (m.supportingDataSummary ?? {}) as {
              basis?: string;
              editedByUser?: boolean;
            };
            return (
              <InsightCard
                key={m.id}
                memory={{
                  id: m.id,
                  insightType: m.insightType,
                  insight: m.insight,
                  confidence: m.confidence,
                  sampleSize: m.sampleSize,
                  basis: summary.basis,
                  editedByUser: summary.editedByUser,
                }}
              />
            );
          })}
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
