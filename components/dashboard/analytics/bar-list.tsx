/**
 * Minimal horizontal bar list (Sprint 6, Module 2) — dependency-free, clean, and
 * board-presentable. Used for channel breakdown + the outreach funnel.
 */
export interface BarItem {
  label: string;
  value: number;
  /** Optional secondary caption (e.g. avg engagement). */
  caption?: string;
}

export function BarList({ items }: { items: BarItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No data for this period.</p>;
  }
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-3">
      {items.map((it) => (
        <div key={it.label}>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="font-medium">{it.label}</span>
            <span className="text-muted-foreground">
              {it.value}
              {it.caption ? ` · ${it.caption}` : ''}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.max(4, (it.value / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
