import Link from 'next/link';
import type { Metadata } from 'next';
import { Radar, Settings2, Info } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getRecentDigests } from '@/server/trends/digest.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { RefreshDigestButton } from '@/components/dashboard/trends/refresh-button';
import { DigestHistory } from '@/components/dashboard/trends/digest-history';
import { TrendCard } from '@/components/dashboard/trends/trend-card';
import { TrendSummary } from '@/components/dashboard/trends/trend-summary';
import type { DigestPayload } from '@/server/trends/types';

export const metadata: Metadata = { title: 'AI Trend Insights' };

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function dayLabel(d: Date): string {
  const today = isoDay(new Date());
  const yest = isoDay(new Date(Date.now() - 86_400_000));
  const key = isoDay(d);
  if (key === today) return 'Today';
  if (key === yest) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: { date?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const digests = await getRecentDigests(active.id, 7);

  const configAction = (
    <Button asChild variant="ghost" size="sm">
      <Link href="/dashboard/settings/trends">
        <Settings2 className="h-4 w-4" /> Configure sources
      </Link>
    </Button>
  );

  // First run — no digest exists yet.
  if (digests.length === 0) {
    return (
      <div>
        <PageHeader
          title="AI Trend Insights"
          description={`What ${active.name}'s market is talking about.`}
          actions={configAction}
        />
        <EmptyState
          icon={Radar}
          title="No digest yet"
          description="Aura scans Reddit, Hacker News, and the news for topics that matter to you, then drafts a suggested angle for each. Generate your first digest to get started — it usually takes about a minute."
          action={<RefreshDigestButton firstRun />}
        />
      </div>
    );
  }

  // Pick the selected digest (by ?date=) or the most recent.
  const selected =
    digests.find((d) => isoDay(d.date) === searchParams.date) ?? digests[0]!;
  const payload = selected.payload as unknown as DigestPayload;
  const items = payload.items ?? [];

  const history = digests.map((d) => ({
    date: isoDay(d.date),
    label: dayLabel(d.date),
    count: ((d.payload as unknown as DigestPayload).items ?? []).length,
  }));

  return (
    <div>
      <PageHeader
        title="AI Trend Insights"
        description={`Generated ${new Date(payload.generatedAt).toLocaleString()} · ${
          payload.model === 'fallback' ? 'basic summaries' : `AI: ${payload.model}`
        }`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <DigestHistory entries={history} selected={isoDay(selected.date)} />
            {configAction}
            <RefreshDigestButton />
          </div>
        }
      />

      {/* Source transparency: which sources ran, which were skipped. */}
      {payload.skippedSources.length > 0 && (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Some sources aren&apos;t connected yet:{' '}
            <span className="font-medium text-foreground">
              {payload.skippedSources.join(', ')}
            </span>
            . Add their API keys (see README) or adjust them in{' '}
            <Link href="/dashboard/settings/trends" className="text-primary hover:underline">
              trend settings
            </Link>
            .
          </p>
        </div>
      )}

      {/* AI synthesis: summary + recommendations + hashtags + seasonal + competitors */}
      <TrendSummary
        summary={payload.summary}
        recommendations={payload.recommendations}
        hashtags={payload.hashtags}
        seasonal={payload.seasonal}
        competitorMentions={payload.competitorMentions}
      />

      {items.length === 0 ? (
        <EmptyState
          icon={Radar}
          title="No trends matched today"
          description="We ran your sources but nothing crossed the relevance bar today. That's normal on quiet days — it doesn't mean anything is broken. Try adding more keywords or subreddits, then refresh."
          action={
            <Button asChild variant="outline">
              <Link href="/dashboard/settings/trends">Adjust keywords</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((item) => (
            <TrendCard key={item.id} item={item} />
          ))}
        </div>
      )}

      {/* Refresh-frequency explainer (P2). */}
      <p className="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Info className="h-3.5 w-3.5 shrink-0" />
        Insights refresh automatically once a day. Use{' '}
        <span className="font-medium text-foreground">Refresh</span> any time to
        regenerate today&apos;s digest on demand — it replaces today&apos;s, never
        duplicates it.
      </p>
    </div>
  );
}
