import Link from 'next/link';
import { CheckCircle2, Rocket, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { LocalTime } from '@/components/ui/local-time';
import { HANDOFF_STATUS_LABEL, type ExecutionHandoff } from '@/lib/execution-handoff';

/**
 * On an approved draft: whether it is ready for execution (lib/execution-
 * handoff.ts) — where it goes, through which account, when, and anything
 * that must be fixed first. A missing connection is stated here with the fix,
 * never discovered by a failed post.
 */
export function ExecutionReadiness({ handoff: h }: { handoff: ExecutionHandoff }) {
  const s = h.readiness.status;
  const tone = s === 'ready' ? 'success' : s === 'executed' ? 'default' : s === 'blocked' ? 'warning' : 'muted';
  return (
    <Card>
      <CardContent className="space-y-2 p-4 text-sm">
        <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
          <Rocket className="h-4 w-4 text-primary" aria-hidden />
          Execution
          <Badge variant={tone}>{HANDOFF_STATUS_LABEL[s]}</Badge>
        </p>
        <p className="text-xs text-muted-foreground">
          {h.channel.label}
          {h.account ? ` · ${h.account.label}` : ''}
          {h.provider.mode === 'manual' ? ' · posted by hand' : ` · via ${h.provider.label}`}
          {' · '}
          {h.scheduledFor ? (
            <>
              scheduled <LocalTime iso={h.scheduledFor} />
            </>
          ) : (
            'no time set'
          )}
          {` · approved version ${h.contentVersion.versionNumber ?? h.contentVersion.version}`}
        </p>
        {h.readiness.issues.length > 0 ? (
          <ul className="space-y-1">
            {h.readiness.issues.map((i) => (
              <li key={`${i.code}:${i.message}`} className="flex items-start gap-1.5 text-xs text-foreground">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
                <span>
                  {i.message}
                  {i.fix && (
                    <>
                      {' '}
                      <Link href={i.fix.href} className="text-primary hover:underline">
                        {i.fix.label}
                      </Link>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : s === 'ready' ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-primary" aria-hidden />
            Everything the execution engine needs is here and checked.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
