import Link from 'next/link';
import { Route } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { LocalTime } from '@/components/ui/local-time';
import { cn } from '@/lib/utils';
import {
  TRACE_LINK_LABEL,
  type ContentTrace,
  type TraceLink,
} from '@/lib/trace';

/**
 * Why this asset exists (lib/trace.ts): the chain from the business context
 * to the approved version, top to bottom, with each link's id.
 */

function Step({
  link,
  children,
  missing,
}: {
  link: TraceLink;
  children: React.ReactNode;
  missing?: boolean;
}) {
  return (
    <li className="relative pl-5" data-trace-link={link}>
      <span
        className={cn(
          'absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full border-2',
          missing
            ? 'border-muted-foreground/40 bg-background'
            : 'border-primary bg-primary/20',
        )}
        aria-hidden
      />
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {TRACE_LINK_LABEL[link]}
      </p>
      <div className="mt-0.5 min-w-0 break-words text-sm text-foreground">
        {children}
      </div>
    </li>
  );
}

const Id = ({ v }: { v: string | null | undefined }) =>
  v ? (
    <span className="block font-mono text-[10px] text-muted-foreground">
      {v}
    </span>
  ) : null;

export function TracePanel({ trace: t }: { trace: ContentTrace }) {
  return (
    <Card data-testid="trace-panel">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Route className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold text-foreground">
            Why this exists
          </h2>
        </div>
        {t.why && (
          <p className="rounded-md bg-muted/50 p-2 text-sm text-foreground">
            {t.why}
          </p>
        )}
        <ol
          className="relative space-y-3 border-l border-border pl-1"
          aria-label="Trace"
        >
          <Step link="business_context">
            {t.businessContext.name ?? 'This business'}
            {t.businessContext.description && (
              <span className="block text-xs text-muted-foreground">
                {t.businessContext.description}
              </span>
            )}
            {t.businessContext.fields.length > 0 && (
              <span className="block text-xs text-muted-foreground">
                Relied on: {t.businessContext.fields.join(', ')}
              </span>
            )}
            <Id
              v={
                t.businessContext.revision
                  ? `revision ${t.businessContext.revision}`
                  : null
              }
            />
          </Step>
          {t.origin === 'recommendation' ? (
            <>
              <Step link="signal" missing={!t.signals.length}>
                {t.signals.length ? (
                  <ul className="space-y-1">
                    {t.signals.slice(0, 5).map((s) => (
                      <li key={s.id} className="text-xs">
                        {s.url ? (
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline"
                          >
                            {s.title}
                          </a>
                        ) : (
                          s.title
                        )}{' '}
                        <span className="text-muted-foreground">
                          · {s.source.toLowerCase()}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    No recorded signal (evidence came from the business
                    context).
                  </span>
                )}
              </Step>
              <Step link="opportunity" missing={!t.opportunity}>
                {t.opportunity ? (
                  <Link
                    href={t.opportunity.href}
                    className="text-primary hover:underline"
                  >
                    {t.opportunity.title}
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    No longer available
                  </span>
                )}
                <Id v={t.ids.opportunityId} />
              </Step>
              <Step link="recommendation" missing={!t.recommendation}>
                {t.recommendation ? (
                  <>
                    <Link
                      href="/dashboard/suggestions/history"
                      className="text-primary hover:underline"
                    >
                      {t.recommendation.title}
                    </Link>
                    {t.recommendation.decidedBy && (
                      <span className="block text-xs text-muted-foreground">
                        Accepted by {t.recommendation.decidedBy}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    No longer available
                  </span>
                )}
                <Id v={t.ids.recommendationId} />
              </Step>
            </>
          ) : null}
          <Step link="brief" missing={!t.brief}>
            {t.brief ? (
              <>
                {t.brief.keyMessage ?? t.brief.request ?? 'Brief'}
                {(t.brief.goal || t.brief.audience || t.brief.channel) && (
                  <span className="block text-xs text-muted-foreground">
                    {[t.brief.goal, t.brief.audience, t.brief.channel]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
              </>
            ) : (
              <span className="text-xs text-muted-foreground">
                No brief recorded
              </span>
            )}
            <Id v={t.ids.briefId} />
          </Step>
          <Step link="generated">
            Version {t.generated.version}
            {t.generated.at && (
              <span className="text-xs text-muted-foreground">
                {' '}
                · <LocalTime iso={t.generated.at} />
              </span>
            )}
            <Id v={t.ids.assetId} />
          </Step>
          <Step link="reviewed" missing={!t.reviewed}>
            {t.reviewed ? (
              <>
                Version {t.reviewed.version ?? '?'} ·{' '}
                {t.reviewed.status?.replace('_', ' ')}
                <Id v={t.reviewed.id} />
              </>
            ) : (
              <span className="text-xs text-muted-foreground">
                Not reviewed yet
              </span>
            )}
          </Step>
          <Step link="approved" missing={!t.approved}>
            {t.approved ? (
              <>
                Version {t.approved.version ?? '?'} · by{' '}
                {t.approved.by ?? 'Unknown'}
                {t.approved.at && (
                  <span className="text-xs text-muted-foreground">
                    {' '}
                    · <LocalTime iso={t.approved.at} />
                  </span>
                )}
                <Id v={t.approved.id} />
              </>
            ) : (
              <span className="text-xs text-muted-foreground">
                Not approved yet
              </span>
            )}
          </Step>
        </ol>
        {t.published && (
          <p className="text-xs text-muted-foreground">
            Published{t.published.url ? ': ' : ''}
            {t.published.url && (
              <a
                href={t.published.url}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                {t.published.url}
              </a>
            )}
          </p>
        )}
        <p className="font-mono text-[10px] text-muted-foreground">
          trace {t.ids.traceId}
        </p>
      </CardContent>
    </Card>
  );
}
