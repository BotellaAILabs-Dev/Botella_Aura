import Link from 'next/link';
import { ArrowUpRight, Sparkles, PenLine } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { DigestItem, TrendSourceId } from '@/server/trends/types';

type SourceStyle = { label: string; variant: BadgeProps['variant'] };

const SOURCE_STYLES: Record<TrendSourceId, SourceStyle> = {
  reddit: { label: 'Reddit', variant: 'warning' },
  hackernews: { label: 'Hacker News', variant: 'default' },
  news: { label: 'News', variant: 'secondary' },
  twitter: { label: 'X', variant: 'muted' },
};

/**
 * Fallback for a source this build does not recognise.
 *
 * `item.source` is TYPED as TrendSourceId but arrives from a stored JSON
 * payload, so the type is an assertion rather than a guarantee. Digests written
 * by an older build, seeded fixtures, or a source added later all produce
 * values outside the union — and indexing the map with one returned undefined,
 * so reading `.variant` crashed the whole page.
 *
 * A trend card is not worth a 500. An unknown source renders with a neutral
 * badge and whatever label the payload carries.
 */
const UNKNOWN_SOURCE: SourceStyle = { label: 'Source', variant: 'muted' };

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hrs = Math.floor(diff / 3_600_000);
  if (hrs < 1) return 'just now';
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function TrendCard({ item }: { item: DigestItem }) {
  const style = SOURCE_STYLES[item.source] ?? UNKNOWN_SOURCE;
  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardContent className="p-5">
        <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={style.variant}>{item.sourceLabel || style.label}</Badge>
          <span>·</span>
          <span>{timeAgo(item.publishedAt)}</span>
          <span className="ml-auto font-medium text-foreground">
            score {item.score}
          </span>
        </div>

        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex items-start gap-1 text-base font-semibold text-foreground hover:text-primary"
        >
          {item.title}
          <ArrowUpRight className="mt-1 h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        </a>

        <div className="mt-3 flex items-start gap-2 rounded-md bg-muted/50 p-3">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="space-y-1.5 text-sm">
            <p className="text-foreground">{item.aiSummary}</p>
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Suggested angle:</span>{' '}
              {item.suggestedAngle}
            </p>
          </div>
        </div>

        <div className="mt-4">
          {/* Sprint 3 hand-off point — Content Studio picks up ?trendId. */}
          <Button asChild variant="ghost" size="sm" className="px-2">
            <Link href={`/dashboard/content/new?trendId=${encodeURIComponent(item.id)}`}>
              <PenLine className="h-4 w-4" /> Generate content from this
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
