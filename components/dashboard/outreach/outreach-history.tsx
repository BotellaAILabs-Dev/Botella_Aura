import { Check, ExternalLink, Send, UserCheck, MessageSquare } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DATE_LOCALE } from '@/lib/dates';
import {
  OUTREACH_STATUS_LABELS,
  OUTREACH_TYPE_LABELS,
  outreachStatusVariant,
  type OutreachStatusKey,
} from '@/lib/outreach-ui';

export interface OutreachHistoryRow {
  id: string;
  leadName: string;
  companyName: string;
  linkedInProfileUrl: string | null;
  type: string;
  status: OutreachStatusKey;
  sentAt: string | null;
  connectionAccepted: boolean;
  replyReceived: boolean;
}

export interface OutreachHistorySummary {
  total: number;
  sent: number;
  connected: number;
  replied: number;
}

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(DATE_LOCALE, {
    month: 'short',
    day: 'numeric',
  });
}

export function OutreachHistory({
  rows,
  summary,
}: {
  rows: OutreachHistoryRow[];
  summary: OutreachHistorySummary;
}) {
  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Outreach history &amp; connection status</CardTitle>
        <CardDescription>
          Every message and how it landed. Connection and reply outcomes feed
          what Aura learns works for you (confirmed by you — no platform API exposes these).
        </CardDescription>
        <div className="flex flex-wrap gap-2 pt-2">
          <Stat icon={Send} label="Sent" value={summary.sent} />
          <Stat icon={UserCheck} label="Connected" value={summary.connected} />
          <Stat icon={MessageSquare} label="Replied" value={summary.replied} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-3 font-medium">Lead</th>
                <th className="pb-2 pr-3 font-medium">Type</th>
                <th className="pb-2 pr-3 font-medium">Status</th>
                <th className="pb-2 pr-3 font-medium">Sent</th>
                <th className="pb-2 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-foreground">
                        {r.leadName || r.companyName}
                      </span>
                      {r.linkedInProfileUrl && (
                        <a
                          href={r.linkedInProfileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-primary"
                          aria-label="Open profile"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {r.companyName}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 text-muted-foreground">
                    {OUTREACH_TYPE_LABELS[r.type] ?? r.type}
                  </td>
                  <td className="py-2.5 pr-3">
                    <Badge variant={outreachStatusVariant(r.status)}>
                      {OUTREACH_STATUS_LABELS[r.status] ?? r.status}
                    </Badge>
                  </td>
                  <td className="py-2.5 pr-3 text-muted-foreground">
                    {when(r.sentAt)}
                  </td>
                  <td className="py-2.5">
                    <div className="flex flex-wrap gap-1.5">
                      {r.connectionAccepted && (
                        <Badge variant="success">
                          <Check className="h-3 w-3" /> Connected
                        </Badge>
                      )}
                      {r.replyReceived && (
                        <Badge variant="default">
                          <Check className="h-3 w-3" /> Replied
                        </Badge>
                      )}
                      {!r.connectionAccepted && !r.replyReceived && (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Send;
  label: string;
  value: number;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1 text-xs">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="font-semibold text-foreground">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}
