'use client';

import { useRouter } from 'next/navigation';
import { History } from 'lucide-react';

interface HistoryEntry {
  date: string; // ISO date
  label: string;
  count: number;
}

/**
 * Digest history selector — lets the user view digests from the past 7 days.
 * Changing the selection navigates to /dashboard/trends?date=YYYY-MM-DD.
 */
export function DigestHistory({
  entries,
  selected,
}: {
  entries: HistoryEntry[];
  selected: string;
}) {
  const router = useRouter();
  if (entries.length <= 1) return null;

  return (
    <label className="flex items-center gap-2 text-sm">
      <History className="h-4 w-4 text-muted-foreground" />
      <span className="sr-only">View digest from</span>
      <select
        value={selected}
        onChange={(e) => {
          const d = e.target.value;
          router.push(`/dashboard/trends?date=${d}`);
        }}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {entries.map((e) => (
          <option key={e.date} value={e.date}>
            {e.label} · {e.count} trends
          </option>
        ))}
      </select>
    </label>
  );
}
