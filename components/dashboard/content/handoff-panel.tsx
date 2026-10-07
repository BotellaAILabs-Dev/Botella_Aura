import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { ContextHandoff } from '@/lib/recommendation-context-handoff';

/**
 * What an Aura recommendation hands Content Studio
 * (lib/recommendation-context-handoff.ts): each part of the context that is
 * there, and each that is not — with what the writer does without it and
 * where to add it. Nothing missing is filled in silently.
 */
const READINESS: Record<
  ContextHandoff['readiness'],
  { label: string; variant: 'success' | 'warning' | 'destructive' }
> = {
  ready: { label: 'Full context', variant: 'success' },
  ready_with_gaps: { label: 'Some context missing', variant: 'warning' },
  blocked: { label: 'Not ready to hand over', variant: 'destructive' },
};

const FIELD_LABEL: Record<string, string> = {
  business: 'What your business does',
  goal: 'Business goal',
  audience: 'Audience',
  channel: 'Channel and format',
  evidence: 'Evidence',
  cta: 'Where the call to action sends people',
  brandVoice: 'Brand voice',
  memory: 'What has worked before',
};

export function HandoffPanel({ handoff: h }: { handoff: ContextHandoff }) {
  const r = READINESS[h.readiness];
  const passed = [
    h.goal && `Goal (${h.goal.source.replace('_', ' ')})`,
    h.audience && `Audience (${h.audience.source.replace('_', ' ')})`,
    h.channel?.channel && `Channel: ${h.channel.channel}`,
    h.evidence.length &&
      `${h.evidence.length} piece${h.evidence.length === 1 ? '' : 's'} of evidence`,
    h.cta.destination && 'Call-to-action link',
    h.brandVoice && 'Brand voice',
    h.memory.length &&
      `${h.memory.length} learned pattern${h.memory.length === 1 ? '' : 's'}`,
  ].filter((x): x is string => Boolean(x));

  return (
    <Card className="mb-4 border-primary/30">
      <CardContent className="space-y-3 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden />
          <span className="font-medium text-foreground">
            Context from Aura’s suggestion
          </span>
          <Badge variant={r.variant}>{r.label}</Badge>
        </div>

        {h.blockedBy.length > 0 && (
          <ul className="space-y-1 text-xs text-foreground">
            {h.blockedBy.map((b) => (
              <li key={b} className="flex gap-1.5">
                <AlertTriangle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  aria-hidden
                />
                {b}
              </li>
            ))}
          </ul>
        )}

        {passed.length > 0 && (
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-primary" aria-hidden />
            Passed to the writer: {passed.join(' · ')}
          </p>
        )}

        {h.missing.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground">
              Not provided — left out, not made up:
            </p>
            <ul className="space-y-1">
              {h.missing.map((m) => (
                <li key={m.field} className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">
                    {FIELD_LABEL[m.field] ?? m.field}:
                  </span>{' '}
                  {m.behaviour}{' '}
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
      </CardContent>
    </Card>
  );
}
