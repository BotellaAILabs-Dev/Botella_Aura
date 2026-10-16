import Link from 'next/link';
import { Lock, Sparkles } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import type { CreationContext } from '@/lib/creation-handoff';

const GAP_LABEL: Record<string, string> = {
  goal: 'Goal',
  audience: 'Audience',
  channel: 'Channel',
  cta: 'Link for the call to action',
  evidence: 'Evidence',
  brandVoice: 'Brand voice',
};

/**
 * What a campaign or outreach run carries from Aura's suggestion
 * (lib/creation-handoff.ts): the suggestion, audience, goal, CTA, channel and
 * content requirements — and what Aura does not have, said plainly rather
 * than filled in. `gate` is the execution notice (lib/execution-gate.ts).
 */
export function CreationContextPanel({
  context: c,
  gate,
  title = 'Carried from Aura’s suggestion',
}: {
  context: CreationContext;
  gate?: string | null;
  title?: string;
}) {
  const r = c.requirements;
  const row = (label: string, value: string | null | undefined) =>
    value ? (
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">{label}:</span> {value}
      </p>
    ) : null;
  return (
    <Card className="border-primary/30">
      <CardContent className="space-y-2 p-4 text-sm">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden />
          {title}
        </p>
        <Link href="/dashboard/suggestions/history" className="block font-medium text-primary hover:underline">
          {c.recommendation.title}
        </Link>
        {row('Why', c.recommendation.why)}
        {row('For', c.audience?.value)}
        {row('Serves', c.goal?.value)}
        {row('Expected outcome', `${c.outcome.outcome}${c.outcome.metric ? ` (measured by ${c.outcome.metric})` : ''}`)}
        {row('Call to action', `${c.cta.guidance}${c.cta.destination ? ` → ${c.cta.destination.value}` : ''}`)}
        {row(
          'Channel',
          c.channel?.channel
            ? `${c.channel.channel}${c.channel.contentType ? ` · ${c.channel.contentType}` : ''}${c.channel.publishing === 'manual' ? ' · posted by hand' : ''}`
            : null,
        )}
        {row('Key message', `${r.keyMessage}${r.angle ? ` — ${r.angle}` : ''}`)}
        {'steps' in r && r.steps.length > 0 && row('Shape', r.steps.join(' · '))}
        {'contentTypes' in r && r.contentTypes.length > 0 && row('Formats', r.contentTypes.join(', '))}
        {'messageTypes' in r && row('Messages', `LinkedIn connection note (≤ ${r.connectionNoteLimit} characters), then a follow-up once accepted`)}
        {row('Evidence it may cite', r.evidence.length ? r.evidence.join('; ') : null)}
        {c.gaps.length > 0 && (
          <div className="space-y-0.5 pt-1">
            <p className="text-xs font-medium text-foreground/80">Not known — left out, not made up</p>
            <ul className="space-y-0.5">
              {c.gaps.map((g) => (
                <li key={g.field} className="text-xs text-muted-foreground">
                  <span className="font-medium">{GAP_LABEL[g.field] ?? g.field}:</span> {g.behaviour}
                </li>
              ))}
            </ul>
          </div>
        )}
        {gate && (
          <p className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-foreground">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {gate}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
