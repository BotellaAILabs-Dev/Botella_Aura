import { Sparkles, Hash, CalendarDays, Swords, ExternalLink } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type {
  SeasonalEvent,
  CompetitorMention,
} from '@/server/trends/types';
import { safeExternalUrl } from '@/lib/safe-url';

/**
 * The AI-generated digest synthesis shown above the trend cards: a summary with
 * prioritized recommendations, trending hashtags, upcoming seasonal moments, and
 * any tracked-competitor mentions. Everything is optional — older digests that
 * predate these fields simply render nothing.
 */
export function TrendSummary({
  summary,
  recommendations = [],
  hashtags = [],
  seasonal = [],
  competitorMentions = [],
}: {
  summary?: string;
  recommendations?: string[];
  hashtags?: string[];
  seasonal?: SeasonalEvent[];
  competitorMentions?: CompetitorMention[];
}) {
  const hasSynthesis = Boolean(summary) || recommendations.length > 0;
  if (!hasSynthesis && !seasonal.length && !competitorMentions.length) return null;

  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-2">
      {/* Summary + recommendations */}
      {hasSynthesis && (
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" /> This week&apos;s read
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {summary && (
              <p className="text-sm text-muted-foreground">{summary}</p>
            )}
            {recommendations.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Recommended this week
                </p>
                <ul className="space-y-1.5">
                  {recommendations.map((r, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                        {i + 1}
                      </span>
                      <span className="text-foreground">{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {hashtags.length > 0 && (
              <div className="border-t border-border pt-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <Hash className="h-3.5 w-3.5" /> Trending hashtags
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {hashtags.map((h) => (
                    <Badge key={h} variant="secondary">
                      #{h}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Seasonal / event-based moments */}
      {seasonal.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarDays className="h-4 w-4 text-primary" /> Upcoming moments
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5">
              {seasonal.map((ev) => (
                <li key={ev.name} className="text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground">{ev.name}</span>
                    <Badge variant="muted">
                      {ev.daysUntil === 0
                        ? 'today'
                        : `in ${ev.daysUntil}d`}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{ev.angle}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Competitor mentions */}
      {competitorMentions.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Swords className="h-4 w-4 text-primary" /> Competitor mentions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5">
              {competitorMentions.slice(0, 6).map((m, i) => (
                <li key={`${m.itemId}-${i}`} className="text-sm">
                  <Badge variant="outline" className="mb-1">
                    {m.competitor}
                  </Badge>
                  <a
                    href={safeExternalUrl(m.url) ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-start gap-1 text-foreground hover:text-primary hover:underline"
                  >
                    <span className="line-clamp-2">{m.title}</span>
                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
                  </a>
                  <span className="text-xs text-muted-foreground">
                    {m.sourceLabel}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
