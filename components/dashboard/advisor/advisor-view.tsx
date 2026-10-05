'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Lightbulb,
  RefreshCw,
  Sparkles,
  Swords,
  TrendingUp,
  Brain,
  FileText,
  ExternalLink,
  Info,
} from 'lucide-react';

import { toast } from '@/components/ui/toaster';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LocalTime } from '@/components/ui/local-time';
import type {
  AdvisorPayload,
  CampaignOpportunity,
  EvidenceKind,
} from '@/server/advisor/types';
import { safeExternalUrl } from '@/lib/safe-url';

const EVIDENCE_ICON: Record<EvidenceKind, typeof Swords> = {
  competitor: Swords,
  trend: TrendingUp,
  memory: Brain,
  performance: TrendingUp,
  gap: FileText,
};

function ratingVariant(r: string): BadgeProps['variant'] {
  if (r === 'high') return 'success';
  if (r === 'medium') return 'warning';
  return 'muted';
}

export function AdvisorView({
  report,
  canGenerate,
}: {
  report: AdvisorPayload | null;
  canGenerate: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      const res = await fetch('/api/advisor', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        opportunities?: number;
      };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not generate opportunities.');
        return;
      }
      toast.success(
        body.opportunities
          ? `${body.opportunities} opportunity/opportunities ready.`
          : 'Generated — see what signal is still missing below.',
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const generateBtn = canGenerate ? (
    <Button onClick={generate} loading={busy}>
      <RefreshCw className="h-4 w-4" />
      {report ? 'Regenerate' : 'Find opportunities'}
    </Button>
  ) : null;

  if (!report) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No advice generated yet</CardTitle>
          <CardDescription>
            The advisor reads what your tracked competitors actually did and what
            your market is discussing, then proposes campaigns you could run in
            response. Every suggestion cites the observation it came from.
          </CardDescription>
        </CardHeader>
        <CardContent>{generateBtn}</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="border-primary/20">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <Lightbulb className="h-5 w-5 text-primary" />
              <div>
                <CardTitle className="text-base">What to run next</CardTitle>
                <CardDescription>
                  Generated{' '}
                  <LocalTime iso={report.generatedAt} /> ·{' '}
                  {report.model === 'none'
                    ? 'rule-based (no AI provider configured)'
                    : `AI: ${report.model}`}
                </CardDescription>
              </div>
            </div>
            {generateBtn}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{report.summary}</p>
          <CoverageLine report={report} />
        </CardContent>
      </Card>

      {report.opportunities.length > 0 && (
        <div className="space-y-4">
          {report.opportunities.map((o) => (
            <OpportunityCard key={o.id} opportunity={o} />
          ))}
        </div>
      )}

      {report.gaps.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Swords className="h-4 w-4 text-primary" /> Where competitors are
              active and you aren&apos;t
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm">
              {report.gaps.map((g) => (
                <li key={g.theme}>
                  <p className="font-medium text-foreground">{g.theme}</p>
                  <p className="text-muted-foreground">{g.observation}</p>
                  <p className="mt-0.5 text-muted-foreground">
                    <span className="font-medium text-foreground">Do this:</span>{' '}
                    {g.suggestion}
                  </p>
                  {g.competitors.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {g.competitors.map((c) => (
                        <Badge key={c} variant="outline">
                          {c}
                        </Badge>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Says exactly what the advice was built from — and what is missing. */
function CoverageLine({ report }: { report: AdvisorPayload }) {
  const c = report.coverage;
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
      <p className="flex items-start gap-1.5">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Built from {c.competitorSignals} competitor observation
        {c.competitorSignals === 1 ? '' : 's'} across {c.competitorsTracked}{' '}
        tracked competitor{c.competitorsTracked === 1 ? '' : 's'}, {c.trendItems}{' '}
        trend item{c.trendItems === 1 ? '' : 's'}, {c.memoryInsights} learned
        insight{c.memoryInsights === 1 ? '' : 's'}, and your last {c.recentDrafts}{' '}
        draft{c.recentDrafts === 1 ? '' : 's'}.
      </p>
      {c.skipped.length > 0 && (
        <ul className="ml-5 list-disc space-y-1">
          {c.skipped.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OpportunityCard({ opportunity }: { opportunity: CampaignOpportunity }) {
  const [showEvidence, setShowEvidence] = useState(false);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{opportunity.title}</CardTitle>
            {opportunity.inspiredBy && (
              <CardDescription>
                Prompted by {opportunity.inspiredBy}&apos;s activity
              </CardDescription>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant={ratingVariant(opportunity.impact)} title="Expected impact">
              {opportunity.impact} impact
            </Badge>
            <Badge variant="muted" title="Effort to produce">
              {opportunity.effort} effort
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">{opportunity.rationale}</p>

        <div className="rounded-md border border-border bg-muted/30 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Your angle
          </p>
          <p className="mt-0.5 text-foreground">{opportunity.angle}</p>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Content to create
          </p>
          <ul className="space-y-1.5">
            {opportunity.contentIdeas.map((idea) => (
              <li key={idea} className="flex items-start justify-between gap-3">
                <span className="text-muted-foreground">{idea}</span>
                {/* Straight into Content Studio with this idea as the brief. */}
                <Button asChild size="sm" variant="ghost" className="shrink-0">
                  <Link
                    href={`/dashboard/content/new?brief=${encodeURIComponent(
                      `${idea}\n\nAngle: ${opportunity.angle}`,
                    )}`}
                  >
                    <Sparkles className="h-4 w-4" /> Draft
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            <span className="font-medium text-foreground">When:</span>{' '}
            {opportunity.timing}
          </span>
          {opportunity.channels.map((ch) => (
            <Badge key={ch} variant="outline">
              {ch}
            </Badge>
          ))}
        </div>

        {opportunity.opportunityId && (
          <Link
            href={`/dashboard/opportunities?focus=${opportunity.opportunityId}`}
            className="inline-block text-xs font-medium text-primary hover:underline"
          >
            Track it in Opportunities →
          </Link>
        )}

        {/* Provenance — the reason to trust this suggestion. */}
        <div>
          <button
            type="button"
            onClick={() => setShowEvidence((v) => !v)}
            className="text-xs font-medium text-primary hover:underline"
          >
            {showEvidence ? 'Hide' : 'Show'} the {opportunity.evidence.length}{' '}
            observation{opportunity.evidence.length === 1 ? '' : 's'} behind this
          </button>
          {showEvidence && (
            <ul className="mt-2 space-y-1.5 border-l-2 border-border pl-3">
              {opportunity.evidence.map((e, i) => {
                const Icon = EVIDENCE_ICON[e.kind] ?? Info;
                return (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      <span className="font-medium text-foreground">{e.label}:</span>{' '}
                      {e.detail}
                      {safeExternalUrl(e.url) && (
                        <a
                          href={safeExternalUrl(e.url)!}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-1 inline-flex text-primary hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
