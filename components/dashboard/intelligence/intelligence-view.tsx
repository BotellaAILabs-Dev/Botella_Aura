'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  BarChart3,
  Brain,
  Check,
  Gauge,
  Lightbulb,
  PenLine,
  RefreshCw,
  Sparkles,
  Target,
  TriangleAlert,
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
import { cn } from '@/lib/utils';
import { useGenerationJob } from '@/components/dashboard/jobs/use-generation-job';
import { JobProgressBar } from '@/components/dashboard/jobs/job-progress';
import { LocalTime } from '@/components/ui/local-time';
import {
  ScoreDial,
  ScoreMeter,
  scoreTone,
} from '@/components/dashboard/intelligence/score-parts';
import type {
  ContentPiece,
  ImprovementSuggestion,
  IntelligencePayload,
} from '@/server/intelligence/types';

const PRIORITY_VARIANT: Record<
  ImprovementSuggestion['priority'],
  BadgeProps['variant']
> = { high: 'destructive', medium: 'warning', low: 'muted' };

export function IntelligenceView({
  snapshot,
  history,
  canRun,
}: {
  snapshot: IntelligencePayload | null;
  history: { date: string; score: number }[];
  canRun: boolean;
}) {
  const router = useRouter();
  const { job, start, attach, running } = useGenerationJob('INTELLIGENCE', {
    onDone(finished) {
      if (finished.status !== 'SUCCEEDED') return;
      toast.success('Analysis complete.');
      router.refresh();
    },
  });

  useEffect(() => {
    void attach();
  }, [attach]);

  /**
   * With no snapshot, start one immediately rather than waiting to be asked.
   *
   * The foundations scorer can grade a workspace from onboarding data alone, so
   * there is always something to compute — leaving the page blank behind a
   * button the user has to discover was the activation blocker.
   *
   * Guarded to once per tab. Without it, every visit re-kicked a run and
   * started another 1.5s poll, so navigating in and out of this page stacked
   * up concurrent pollers — cheap individually, punishing in aggregate.
   */
  useEffect(() => {
    if (snapshot || !canRun) return;
    const key = 'aura.intelligence.autostarted';
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, '1');
    } catch {
      // Storage unavailable (private mode) — fall through and start once.
    }
    void start();
    // Intentionally runs once: `start` would otherwise re-fire on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = running;

  const runBtn = canRun ? (
    <Button onClick={() => void start()} loading={busy}>
      <RefreshCw className="h-4 w-4" />
      {snapshot ? 'Recalculate' : 'Run analysis'}
    </Button>
  ) : null;

  if (!snapshot) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Gauge className="h-5 w-5 text-primary" />
            <div>
              <CardTitle className="text-base">
                {busy ? 'Scoring your workspace…' : 'No analysis yet'}
              </CardTitle>
              <CardDescription>
                This dashboard scores your setup, campaigns, leads, competitor
                coverage, content quality, and brand consistency from your real
                workspace data. Nothing is estimated — anything that cannot be
                measured is reported as unavailable rather than as a zero.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {runBtn}
          <JobProgressBar
            job={job}
            runningLabel="Running your first analysis"
            onRetry={() => void start()}
          />
        </CardContent>
      </Card>
    );
  }

  const { performance, content, brand } = snapshot;
  // Older snapshots predate scoreKind; treat a missing value as a real score.
  const setupOnly = snapshot.scoreKind === 'setup';
  const previous = history.length > 1 ? history[history.length - 2]!.score : null;
  const delta =
    snapshot.overallScore !== null && previous !== null
      ? snapshot.overallScore - previous
      : null;

  return (
    <div className="space-y-8">
      {/* ---------- Overall marketing score ---------- */}
      <Card className="border-primary/20">
        <CardContent className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center">
          <ScoreDial score={snapshot.overallScore} />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-foreground">
                {setupOnly ? 'Setup progress' : 'Overall marketing score'}
              </h2>
              {/* A workspace still in setup is graded on setup, not on
                  marketing it has not done yet — showing 15/100 in red to
                  someone who just finished onboarding would be accurate
                  arithmetic and a discouraging lie about what it means. */}
              {setupOnly ? (
                <Badge variant="secondary">Getting started</Badge>
              ) : (
                snapshot.overallScore !== null && (
                  <Badge
                    variant={
                      snapshot.overallScore >= 60
                        ? 'success'
                        : snapshot.overallScore >= 40
                          ? 'warning'
                          : 'destructive'
                    }
                  >
                    {scoreTone(snapshot.overallScore).label}
                  </Badge>
                )
              )}
              {!setupOnly && delta !== null && delta !== 0 && (
                <Badge variant={delta > 0 ? 'success' : 'muted'}>
                  {delta > 0 ? '+' : ''}
                  {delta} since last run
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{snapshot.overallBasis}</p>
            <p className="text-xs text-muted-foreground">
              Calculated <LocalTime iso={snapshot.generatedAt} /> ·{' '}
              {snapshot.model === 'none'
                ? 'scores are deterministic; suggestions are rule-based (no AI provider configured)'
                : `scores are deterministic; suggestions written by ${snapshot.model}`}
            </p>
          </div>
          <div className="shrink-0">{runBtn}</div>
        </CardContent>
      </Card>

      {/* ---------- Setup checklist (first-run next step) ---------- */}
      <SetupChecklist coverage={snapshot.coverage} />

      {/* ---------- What to fix ----------
          The top item is pulled out and given real visual weight. Nine
          equally-sized cards could not answer the question the section asks. */}
      {snapshot.suggestions.length > 0 && (
        <section>
          <SectionHeading
            icon={Lightbulb}
            title="What to fix first"
            subtitle="Ranked by how many points each fix is worth on your overall score — weight of the area times how far it sits below target."
          />

          <TopPriority suggestion={snapshot.suggestions[0]!} />

          {snapshot.suggestions.length > 1 && (
            <>
              <h3 className="mb-2 mt-4 text-sm font-semibold text-foreground">
                Then
              </h3>
              <ul className="space-y-2">
                {snapshot.suggestions.slice(1).map((s, i) => (
                  <li key={i}>
                    <Card>
                      <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={PRIORITY_VARIANT[s.priority]}>
                              {s.priority}
                            </Badge>
                            <Badge variant="outline">{s.area}</Badge>
                            <p className="font-medium text-foreground">{s.title}</p>
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {s.rationale}
                          </p>
                          <p className="mt-1 text-sm text-foreground">
                            <span className="font-medium">Do this:</span> {s.action}
                          </p>
                          {s.expectedImpact && (
                            <p className="mt-1 text-xs font-medium text-primary">
                              {s.expectedImpact}
                            </p>
                          )}
                        </div>
                        {s.href && (
                          <Button asChild size="sm" variant="ghost" className="shrink-0">
                            <Link href={s.href}>
                              Go <ArrowRight className="h-4 w-4" />
                            </Link>
                          </Button>
                        )}
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {/* ---------- Marketing performance ---------- */}
      <section>
        <SectionHeading
          icon={BarChart3}
          title="Marketing performance"
          subtitle="How the machine is running: campaigns, lead generation, competitor coverage, output, and outreach."
        />
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <ScoreMeter label="Setup foundations" block={performance.foundations} />
          <ScoreMeter label="Campaign performance" block={performance.campaign} />
          <ScoreMeter
            label="Lead generation health"
            block={performance.leadGeneration}
          />
          <ScoreMeter
            label="Competitor visibility"
            block={performance.competitorVisibility}
          />
          <ScoreMeter label="Content output" block={performance.contentOutput} />
          <ScoreMeter label="Outreach conversion" block={performance.outreach} />
        </div>
      </section>

      {/* ---------- Content intelligence ---------- */}
      <section>
        <SectionHeading
          icon={PenLine}
          title="Content intelligence"
          subtitle="Measured from the writing itself, so a weak hook is visible before you publish — not after."
        />
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <ScoreMeter label="AI content quality" block={content.quality} />
          <ScoreMeter label="Hook strength" block={content.hookStrength} />
          <ScoreMeter label="Readability" block={content.readability} />
          <ScoreMeter label="CTA effectiveness" block={content.ctaEffectiveness} />
          <ScoreMeter
            label="Engagement prediction"
            block={content.engagementPrediction}
          />
          <ScoreMeter label="Measured performance" block={content.performance} />
        </div>

        <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {content.predictionAccuracy.note}
        </p>

        {content.pieces.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-semibold text-foreground">
              Weakest pieces first
            </h3>
            <div className="space-y-2">
              {content.pieces.slice(0, 6).map((p) => (
                <PieceRow key={p.draftId} piece={p} />
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ---------- Brand intelligence ---------- */}
      <section>
        <SectionHeading
          icon={Brain}
          title="Brand intelligence"
          subtitle="Does the content actually sound like the brand voice profile says it should?"
        />
        <div className="grid gap-3 lg:grid-cols-3">
          <ScoreMeter label="Brand consistency" block={brand.consistency} />

          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Tone of voice validation</CardTitle>
              <CardDescription className="text-xs">
                {brand.toneValidation.note}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {brand.toneValidation.findings.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No tone descriptors to validate yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  {brand.toneValidation.findings.map((f) => (
                    <li key={f.descriptor} className="text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">
                          {f.descriptor}
                        </span>
                        <Badge
                          variant={
                            f.verdict === 'consistent'
                              ? 'success'
                              : f.verdict === 'drifting'
                                ? 'warning'
                                : 'muted'
                          }
                        >
                          {f.verdict}
                        </Badge>
                        {f.verdict !== 'absent' && (
                          <span className="text-xs text-muted-foreground">
                            {Math.round(f.adherence * 100)}% of pieces
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{f.note}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="mt-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Vocabulary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <WordGroup
                label="On brand"
                words={brand.vocabulary.onBrand}
                variant="success"
                empty="No brand terms detected in your content yet."
              />
              <WordGroup
                label="Defined but unused"
                words={brand.vocabulary.underused}
                variant="warning"
                empty="Every brand term is in use."
              />
              <WordGroup
                label="Drifting toward"
                words={brand.vocabulary.driftingInto}
                variant="outline"
                empty="No unexpected vocabulary dominating."
              />
              <WordGroup
                label="Rule violations"
                words={brand.vocabulary.violations}
                variant="destructive"
                empty="No topics-to-avoid violations."
              />
            </div>

            <ul className="space-y-1.5">
              {brand.vocabulary.recommendations.map((r) => (
                <li
                  key={r}
                  className="flex items-start gap-1.5 text-xs text-muted-foreground"
                >
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  {r}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </section>

      {/* ---------- Coverage / gaps ---------- */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">What this analysis could see</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            {snapshot.coverage.draftsAnalysed} draft
            {snapshot.coverage.draftsAnalysed === 1 ? '' : 's'} analysed (
            {snapshot.coverage.publishedAnalysed} published) ·{' '}
            {snapshot.coverage.performanceSnapshots} performance snapshot
            {snapshot.coverage.performanceSnapshots === 1 ? '' : 's'} ·{' '}
            {snapshot.coverage.leads} lead
            {snapshot.coverage.leads === 1 ? '' : 's'} ·{' '}
            {snapshot.coverage.competitors} competitor
            {snapshot.coverage.competitors === 1 ? '' : 's'} ·{' '}
            {snapshot.coverage.campaigns} campaign
            {snapshot.coverage.campaigns === 1 ? '' : 's'} ·{' '}
            {snapshot.coverage.hasBrandProfile
              ? 'brand voice profile present'
              : 'no brand voice profile'}
            .
          </p>
          {snapshot.coverage.gaps.length > 0 && (
            <ul className="space-y-1">
              {snapshot.coverage.gaps.map((g) => (
                <li key={g} className="flex items-start gap-1.5">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {g}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SectionHeading({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: typeof BarChart3;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-3">
      <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
        <Icon className="h-4 w-4 text-primary" /> {title}
      </h2>
      <p className="text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}

function WordGroup({
  label,
  words,
  variant,
  empty,
}: {
  label: string;
  words: string[];
  variant: BadgeProps['variant'];
  empty: string;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {words.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {words.slice(0, 8).map((w) => (
            <Badge key={w} variant={variant}>
              {w}
            </Badge>
          ))}
          {words.length > 8 && (
            <span className="text-xs text-muted-foreground">
              +{words.length - 8}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function PieceRow({ piece }: { piece: ContentPiece }) {
  const [open, setOpen] = useState(false);
  const tone = scoreTone(piece.qualityScore);

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              href={`/dashboard/content/${piece.draftId}`}
              className="font-medium text-foreground hover:underline"
            >
              {piece.title}
            </Link>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="muted">{piece.type}</Badge>
              <Badge variant="secondary">{piece.status}</Badge>
              <span className={cn('font-semibold', tone.text)}>
                Quality {piece.qualityScore}/100
              </span>
              {piece.actualEngagement !== null && (
                <span className="text-muted-foreground">
                  measured engagement {piece.actualEngagement}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 text-xs font-medium text-primary hover:underline"
          >
            {open ? 'Hide' : 'Why this score'}
          </button>
        </div>

        {open && (
          <div className="mt-3 grid gap-3 border-t border-border pt-3 text-xs sm:grid-cols-2">
            <Metric
              label="Hook"
              score={piece.hook.score}
              lines={[
                piece.hook.text ? `“${piece.hook.text}”` : '',
                ...piece.hook.weaknesses,
                ...piece.hook.strengths,
              ].filter(Boolean)}
            />
            <Metric
              label="Readability"
              score={piece.readability.score}
              lines={[
                piece.readability.verdict,
                `Reading grade ${piece.readability.gradeLevel}`,
              ]}
            />
            <Metric
              label="Call to action"
              score={piece.cta.score}
              lines={piece.cta.notes}
            />
            <Metric
              label="Structure"
              score={piece.structure.score}
              lines={[
                `${piece.structure.wordCount} words · ${piece.structure.hashtagCount} hashtags`,
                ...piece.structure.notes,
              ]}
            />
            <div className="sm:col-span-2">
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  Predicted engagement:
                </span>{' '}
                {piece.prediction.band} ({piece.prediction.score}/100)
                {piece.prediction.drivers.length > 0 &&
                  ` — driven by ${piece.prediction.drivers.join(', ')}`}
                . This is a forecast from the writing, not a measurement.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  score,
  lines,
}: {
  label: string;
  score: number;
  lines: string[];
}) {
  const tone = scoreTone(score);
  return (
    <div>
      <p className="font-medium text-foreground">
        {label} <span className={tone.text}>{score}/100</span>
      </p>
      <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The single highest-impact fix, given the visual weight the rest of the list
 * does not get. The review's complaint was that nine items at equal prominence,
 * all labelled "medium", cannot tell anyone what to do first.
 */
function TopPriority({ suggestion }: { suggestion: ImprovementSuggestion }) {
  return (
    <Card className="border-primary/40 bg-primary/[0.03]">
      <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="default">
              <Target className="h-3 w-3" /> Start here
            </Badge>
            <Badge variant={PRIORITY_VARIANT[suggestion.priority]}>
              {suggestion.priority}
            </Badge>
            <Badge variant="outline">{suggestion.area}</Badge>
          </div>
          <h3 className="mt-2 text-base font-semibold text-foreground">
            {suggestion.title}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {suggestion.rationale}
          </p>
          <p className="mt-2 text-sm text-foreground">
            <span className="font-medium">Do this:</span> {suggestion.action}
          </p>
          {suggestion.expectedImpact && (
            <p className="mt-2 text-sm font-medium text-primary">
              {suggestion.expectedImpact}
            </p>
          )}
        </div>
        {suggestion.href && (
          <Button asChild className="shrink-0">
            <Link href={suggestion.href}>
              Fix it <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Setup progress, and the one step worth doing next.
 *
 * A new workspace cannot be scored on activity it has not had time to produce,
 * but it can always be scored on whether it is set up — so this replaces the
 * wall of "Not measured" with a checklist that visibly completes.
 */
function SetupChecklist({
  coverage,
}: {
  coverage: IntelligencePayload['coverage'];
}) {
  const steps = coverage.foundationSteps ?? [];
  if (steps.length === 0) return null;

  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null; // nothing left to nag about

  const next = coverage.nextStep;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Check className="h-5 w-5 text-primary" />
          <div>
            <CardTitle className="text-base">
              Setup — {done} of {steps.length} complete
            </CardTitle>
            <CardDescription>
              Each step unlocks a part of the score that cannot be measured
              without it.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {next && (
          <div className="rounded-lg border border-primary/30 bg-primary/[0.04] p-3">
            <p className="text-sm font-medium text-foreground">
              Next: {next.label}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">{next.action}</p>
            <Button asChild size="sm" variant="outline" className="mt-2">
              <Link href={next.href}>
                Do it <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        )}
        <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
          {steps.map((step) => (
            <li key={step.key} className="flex items-center gap-2">
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px]',
                  step.done
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border text-muted-foreground',
                )}
              >
                {step.done ? '✓' : ''}
              </span>
              <span
                className={
                  step.done ? 'text-muted-foreground line-through' : 'text-foreground'
                }
              >
                {step.label}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
