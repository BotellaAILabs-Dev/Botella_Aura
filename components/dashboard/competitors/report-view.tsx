import { Lightbulb, Rocket, DollarSign, Activity } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { CompetitorReportPayload } from '@/server/competitors/types';

/** Presentational weekly-report digest. Server-rendered (no client state). */
export function ReportView({ payload }: { payload: CompetitorReportPayload }) {
  return (
    <div className="space-y-5">
      {/* Overall synthesis — "what this means for you" */}
      <Card className="border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="h-5 w-5 text-primary" />
            What this means for you
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed text-foreground">
            {payload.synthesis}
          </p>
          {payload.model === 'none' && (
            <p className="mt-2 text-xs text-muted-foreground">
              Generated without AI (no ANTHROPIC_API_KEY) — this is a basic
              summary of the raw signal.
            </p>
          )}
        </CardContent>
      </Card>

      {payload.competitors.map((c) => {
        const empty =
          !c.newLaunches.length &&
          !c.pricingChanges.length &&
          !c.notableActivity.length;
        return (
          <Card key={c.competitorId}>
            <CardHeader>
              <CardTitle className="text-base">{c.competitor}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {empty ? (
                <p className="text-muted-foreground">
                  No material public activity detected this week.
                </p>
              ) : (
                <>
                  <Section icon={Rocket} title="New launches" items={c.newLaunches} />
                  <Section
                    icon={DollarSign}
                    title="Pricing changes"
                    items={c.pricingChanges}
                  />
                  <Section
                    icon={Activity}
                    title="Notable activity"
                    items={c.notableActivity}
                  />
                </>
              )}
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3">
                <Badge variant="default" className="mt-0.5 shrink-0">
                  Takeaway
                </Badge>
                <p className="text-foreground">{c.strategicTakeaway}</p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  items,
}: {
  icon: typeof Rocket;
  title: string;
  items: string[];
}) {
  if (!items.length) return null;
  return (
    <div>
      <p className="mb-1 flex items-center gap-1.5 font-medium">
        <Icon className="h-4 w-4 text-muted-foreground" /> {title}
      </p>
      <ul className="ml-6 list-disc space-y-0.5 text-muted-foreground">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
