import { DATE_LOCALE } from '@/lib/dates';
/**
 * Minimal inline-SVG engagement trend chart (Sprint 5, Module 2). Deliberately
 * dependency-free — one clean line, not a BI dashboard. Server-rendered.
 */
export interface TrendPoint {
  date: string;
  engagement: number;
}

export function TrendChart({ points }: { points: TrendPoint[] }) {
  if (points.length < 2) {
    return (
      <p className="text-sm text-muted-foreground">
        Not enough data points yet for a trend — sync metrics on a few more posts.
      </p>
    );
  }

  const W = 640;
  const H = 180;
  const P = 24; // padding
  const max = Math.max(...points.map((p) => p.engagement), 1);
  const stepX = (W - P * 2) / (points.length - 1);
  const x = (i: number) => P + i * stepX;
  const y = (v: number) => H - P - (v / max) * (H - P * 2);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.engagement)}`).join(' ');
  const area = `${line} L ${x(points.length - 1)} ${H - P} L ${x(0)} ${H - P} Z`;

  const first = new Date(points[0]!.date).toLocaleDateString(DATE_LOCALE, { month: 'short', day: 'numeric' });
  const last = new Date(points[points.length - 1]!.date).toLocaleDateString(DATE_LOCALE, { month: 'short', day: 'numeric' });

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full min-w-[420px]"
        role="img"
        aria-label="Engagement over time"
      >
        <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="hsl(var(--border))" />
        <path d={area} fill="hsl(var(--primary) / 0.12)" />
        <path d={line} fill="none" stroke="hsl(var(--primary))" strokeWidth={2} />
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.engagement)} r={2.5} fill="hsl(var(--primary))" />
        ))}
        <text x={P} y={H - 6} fontSize={10} fill="hsl(var(--muted-foreground))">
          {first}
        </text>
        <text x={W - P} y={H - 6} fontSize={10} textAnchor="end" fill="hsl(var(--muted-foreground))">
          {last}
        </text>
        <text x={P} y={14} fontSize={10} fill="hsl(var(--muted-foreground))">
          peak {max}
        </text>
      </svg>
    </div>
  );
}
