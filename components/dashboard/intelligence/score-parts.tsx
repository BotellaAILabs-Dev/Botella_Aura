import { Info, Minus } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { ScoreBlock } from '@/server/intelligence/types';

/**
 * Shared score primitives.
 *
 * The central rule: a score with no data renders as an explicit "not measured
 * yet" state, never as a zero. A zero must always mean "measured, and bad".
 */
export function scoreTone(score: number): {
  text: string;
  ring: string;
  label: string;
} {
  if (score >= 80)
    return { text: 'text-success', ring: 'stroke-success', label: 'Strong' };
  if (score >= 60)
    return { text: 'text-primary', ring: 'stroke-primary', label: 'Healthy' };
  if (score >= 40)
    return { text: 'text-warning', ring: 'stroke-warning', label: 'Needs work' };
  return { text: 'text-destructive', ring: 'stroke-destructive', label: 'At risk' };
}

/** Big circular gauge for the headline score. */
export function ScoreDial({
  score,
  size = 132,
}: {
  score: number | null;
  size?: number;
}) {
  const radius = (size - 14) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score));
  const dash = (pct / 100) * circumference;
  const tone = score === null ? null : scoreTone(score);

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={
        score === null ? 'Score not available yet' : `Overall score ${score} out of 100`
      }
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={10}
          className="stroke-border"
        />
        {score !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference - dash}`}
            className={cn('transition-all', tone?.ring)}
            style={{ color: 'currentColor' }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {score === null ? (
          <>
            <Minus className="h-6 w-6 text-muted-foreground" />
            <span className="mt-1 text-[11px] text-muted-foreground">
              not measured
            </span>
          </>
        ) : (
          <>
            <span className={cn('text-3xl font-semibold', tone?.text)}>{score}</span>
            <span className="text-[11px] text-muted-foreground">/ 100</span>
          </>
        )}
      </div>
    </div>
  );
}

/** Horizontal meter for a single sub-score. */
export function ScoreMeter({
  label,
  block,
}: {
  label: string;
  block: ScoreBlock;
}) {
  const tone = block.score !== null ? scoreTone(block.score) : null;

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-foreground">{label}</p>
          {block.hasData && block.score !== null ? (
            <span className={cn('text-lg font-semibold', tone?.text)}>
              {block.score}
              <span className="text-xs text-muted-foreground">/100</span>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Not measured</span>
          )}
        </div>

        {block.hasData && block.score !== null ? (
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="meter"
            aria-valuenow={block.score}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={cn(
                'h-full rounded-full',
                block.score >= 80
                  ? 'bg-success'
                  : block.score >= 60
                    ? 'bg-primary'
                    : block.score >= 40
                      ? 'bg-warning'
                      : 'bg-destructive',
              )}
              style={{ width: `${block.score}%` }}
            />
          </div>
        ) : (
          <div className="h-1.5 w-full rounded-full border border-dashed border-border" />
        )}

        <p className="text-xs text-muted-foreground">{block.basis}</p>

        {block.recommendation && (
          <p className="flex items-start gap-1.5 rounded-md bg-muted/40 p-2 text-xs text-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {block.recommendation}
          </p>
        )}

        {block.detail && Object.keys(block.detail).length > 0 && (
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            {Object.entries(block.detail).map(([k, v]) => (
              <div key={k} className="flex gap-1">
                <dt>{humanize(k)}:</dt>
                <dd className="font-medium text-foreground">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function humanize(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}
