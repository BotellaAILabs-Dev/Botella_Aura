import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Circle, FileText } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { NOT_ACCEPTED_BLOCKER } from '@/lib/recommendation-context-handoff';
import type { VisualField } from '@/lib/visual-brief';
import type {
  BriefField,
  ContentBrief,
  FieldRequirement,
} from '@/lib/content-brief';

/**
 * The Content Brief in Content Studio (lib/content-brief.ts): what Aura is
 * to create, from the accepted recommendation — the key message, format and
 * channel, what it must meet, and every field it does and does not have.
 * Missing fields are flagged with what that means and where to add them;
 * nothing is filled in silently.
 */
const READINESS: Record<
  ContentBrief['readiness'],
  { label: string; variant: 'success' | 'warning' | 'destructive' }
> = {
  ready: { label: 'Complete', variant: 'success' },
  ready_with_gaps: { label: 'Some details missing', variant: 'warning' },
  blocked: { label: 'Not ready', variant: 'destructive' },
};

export const BRIEF_FIELD_LABEL: Record<BriefField, string> = {
  recommendation: 'Recommendation',
  opportunity: 'Opportunity',
  businessContext: 'Business context',
  marketingGoal: 'Marketing goal',
  targetAudience: 'Target audience',
  channel: 'Channel',
  recommendedAction: 'Recommended action',
  keyMessage: 'Key message',
  reason: 'Reason',
  evidence: 'Evidence',
  expectedOutcome: 'Expected outcome',
  cta: 'Call to action',
  brandVoice: 'Brand voice',
  relevantMemory: 'What has worked before',
  contentType: 'Content type',
  assetRequirements: 'Asset requirements',
};

/** Visual gaps, as the person reads them (lib/visual-brief.ts). */
const VISUAL_GAP: Record<VisualField, string> = {
  subject: 'what it shows',
  product: 'your product',
  audience: 'the audience',
  palette: 'brand colours',
  mood: 'brand mood',
};

const REQUIREMENT_LABEL: Record<FieldRequirement, string> = {
  required: 'Required',
  recommended: 'Recommended',
  optional: 'Optional',
};

function Line({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <p className="text-xs text-muted-foreground">
      <span className="font-medium text-foreground/80">{label}:</span>{' '}
      {children}
    </p>
  );
}

export function ContentBriefPanel({
  brief: b,
  acceptsOnCreate = false,
}: {
  brief: ContentBrief;
  /** Generating here says yes to it — so "accept it first" is not in the way. */
  acceptsOnCreate?: boolean;
}) {
  const blockedBy = acceptsOnCreate
    ? b.blockedBy.filter((x) => x !== NOT_ACCEPTED_BLOCKER)
    : b.blockedBy;
  const readiness =
    blockedBy.length > 0
      ? 'blocked'
      : b.missing.some((m) => m.requirement === 'recommended')
        ? 'ready_with_gaps'
        : 'ready';
  const r = READINESS[readiness];
  const a = b.assetRequirements;
  const provided = b.fields.filter((f) => f.provided).length;

  return (
    <Card className="mb-4 border-primary/30">
      <CardContent className="space-y-3 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <FileText className="h-4 w-4 text-primary" aria-hidden />
          <span className="font-medium text-foreground">Content brief</span>
          <Badge variant={r.variant}>{r.label}</Badge>
          <span className="text-xs text-muted-foreground">
            {provided} of {b.fields.length} fields
          </span>
        </div>

        {blockedBy.length > 0 && (
          <ul className="space-y-1 text-xs text-foreground">
            {blockedBy.map((x) => (
              <li key={x} className="flex gap-1.5">
                <AlertTriangle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
                  aria-hidden
                />
                {x}
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-1">
          {b.keyMessage && (
            <Line label="Key message">{b.keyMessage.value}</Line>
          )}
          {b.contentType && (
            <Line label="Make">
              {b.contentType.label}
              {b.channel?.name ? ` for ${b.channel.name}` : ''}
              {b.channel?.publishing === 'manual' ? ' (posted by hand)' : ''}
            </Line>
          )}
          {b.opportunity && (
            <Line label="Opportunity">
              <Link
                href={b.opportunity.href}
                className="text-primary hover:underline"
              >
                {b.opportunity.title}
              </Link>{' '}
              ({b.opportunity.typeLabel})
            </Line>
          )}
          {b.marketingGoal && <Line label="Goal">{b.marketingGoal.value}</Line>}
          {b.targetAudience && (
            <Line label="Audience">{b.targetAudience.value}</Line>
          )}
          <Line label="Expected outcome">{b.expectedOutcome.outcome}</Line>
          {b.evidence.length > 0 && (
            <Line label="Evidence">
              {b.evidence.length} piece{b.evidence.length === 1 ? '' : 's'} —{' '}
              {b.evidence.map((e) => e.label).join('; ')}
            </Line>
          )}
          {b.cta.expected && (
            <Line label="Call to action">
              {b.cta.destination
                ? `send people to ${b.cta.destination.value}`
                : 'the next step, with no link'}
            </Line>
          )}
          {a && (
            <Line label="Requirements">
              {`up to ${a.copy.idealMaxChars.toLocaleString('en')} characters · ${
                a.copy.hashtags.max === 0
                  ? 'no hashtags'
                  : `${a.copy.hashtags.min}–${a.copy.hashtags.max} hashtags`
              } · ${
                a.visual.need === 'none'
                  ? 'no image needed'
                  : `${a.visual.need === 'required' ? 'needs' : 'image recommended:'} ${
                      a.visual.count.max > 1
                        ? `${a.visual.count.min}–${a.visual.count.max} images`
                        : '1 image'
                    }${a.visual.aspectRatio ? ` at ${a.visual.aspectRatio}` : ''}`
              }`}
            </Line>
          )}
          {b.visual && b.visual.need !== 'none' && b.visual.missing.length > 0 && (
            <Line label="Image brief">
              {`missing ${b.visual.missing.map((m) => VISUAL_GAP[m.field]).join(', ')} — the image is made without it, nothing invented.`}
            </Line>
          )}
        </div>

        {b.missing.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground">
              Missing — flagged, not made up:
            </p>
            <ul className="space-y-1">
              {b.missing.map((m) => (
                <li key={m.field} className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">
                    {BRIEF_FIELD_LABEL[m.field]}
                  </span>{' '}
                  <span className="text-[11px] uppercase tracking-wide">
                    ({REQUIREMENT_LABEL[m.requirement]})
                  </span>
                  : {m.whenMissing}{' '}
                  {m.fix && (
                    <Link
                      href={m.fix.href}
                      className="text-primary hover:underline"
                    >
                      {m.fix.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            All brief fields
          </summary>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {b.fields.map((f) => (
              <li
                key={f.field}
                className="flex items-center gap-1.5 text-muted-foreground"
              >
                {f.provided ? (
                  <CheckCircle2
                    className="h-3.5 w-3.5 shrink-0 text-primary"
                    aria-label="provided"
                  />
                ) : (
                  <Circle
                    className="h-3.5 w-3.5 shrink-0"
                    aria-label="missing"
                  />
                )}
                <span className={f.provided ? 'text-foreground/80' : ''}>
                  {BRIEF_FIELD_LABEL[f.field]}
                </span>
                <span className="text-[11px]">
                  · {REQUIREMENT_LABEL[f.requirement].toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        </details>
      </CardContent>
    </Card>
  );
}
