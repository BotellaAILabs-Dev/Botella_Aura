'use client';

import { useEffect, useState } from 'react';
import { DATE_LOCALE } from '@/lib/dates';

/**
 * A timestamp rendered in the viewer's own time zone, without breaking
 * hydration.
 *
 * The problem this solves: `new Date(iso).toLocaleString()` asks the runtime
 * for both its locale and its time zone, and a server-rendered app has two
 * runtimes that disagree about both. Node rendered "7/9/2026, 12:04:44 pm"
 * while a New York browser rendered "9/7/2026, 2:34:44 AM" for the same
 * instant, so React threw away the server HTML for that whole Suspense
 * boundary and re-rendered it on the client:
 *
 *   Warning: Text content did not match.
 *     Server: "7/9/2026, 12:04:44 pm"  Client: "9/7/2026, 2:34:44 AM"
 *
 * There is no server-side fix, because the server genuinely cannot know the
 * viewer's zone. So: the server and the first client render both produce the
 * same pinned UTC string — which is what makes hydration match — and only
 * after mount do we re-format in the viewer's actual zone. The text can shift
 * once, on the client, which is correct and is not a mismatch because React
 * has finished hydrating by then.
 */
type Kind = 'datetime' | 'date';

function format(iso: string | number | Date, kind: Kind, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions =
    kind === 'date'
      ? { year: 'numeric', month: 'numeric', day: 'numeric' }
      : {
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        };
  return d.toLocaleString(DATE_LOCALE, timeZone ? { ...opts, timeZone } : opts);
}

export function LocalTime({
  iso,
  kind = 'datetime',
  className,
}: {
  iso: string | number | Date;
  kind?: Kind;
  className?: string;
}) {
  // Deliberately starts null so the first client render matches the server's
  // UTC-pinned output. The effect runs only after hydration is complete.
  const [local, setLocal] = useState<string | null>(null);

  useEffect(() => {
    setLocal(format(iso, kind));
  }, [iso, kind]);

  return <span className={className}>{local ?? format(iso, kind, 'UTC')}</span>;
}
