'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sparkles, ArrowRight } from 'lucide-react';
import { toast } from '@/components/ui/toaster';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeProps } from '@/components/ui/badge';

export interface LeadTableRow {
  id: string;
  name: string | null;
  title: string | null;
  companyName: string;
  source: string;
  status: string;
  fitScore: number | null;
  fitRationale: string | null;
  signalCount: number;
  messageCount: number;
}

const SOURCE_LABEL: Record<string, string> = {
  SIGNAL: 'Signal',
  DISCOVERY_ENGINE: 'Discovery',
  MANUAL: 'Manual',
};

function sourceVariant(s: string): BadgeProps['variant'] {
  if (s === 'DISCOVERY_ENGINE') return 'default';
  if (s === 'MANUAL') return 'secondary';
  return 'outline';
}
function scoreVariant(n: number): BadgeProps['variant'] {
  if (n >= 75) return 'success';
  if (n >= 50) return 'warning';
  return 'muted';
}

export function LeadsTable({
  leads,
  canManage,
}: {
  leads: LeadTableRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [source, setSource] = useState('ALL');
  const [minScore, setMinScore] = useState(0);
  const [draftingId, setDraftingId] = useState<string | null>(null);

  const filtered = leads.filter(
    (l) =>
      (source === 'ALL' || l.source === source) &&
      (l.fitScore ?? 0) >= minScore,
  );

  async function draft(id: string) {
    setDraftingId(id);
    try {
      const res = await fetch(`/api/outreach/leads/${id}/draft`, { method: 'POST' });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not draft outreach.');
        return;
      }
      toast.success('Outreach drafted — review it in Outreach.');
      router.push('/dashboard/outreach');
    } finally {
      setDraftingId(null);
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Source</span>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1"
          >
            <option value="ALL">All</option>
            <option value="DISCOVERY_ENGINE">Discovery</option>
            <option value="SIGNAL">Signal</option>
            <option value="MANUAL">Manual</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Min fit</span>
          <select
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            className="rounded-md border border-input bg-background px-2 py-1"
          >
            <option value={0}>Any</option>
            <option value={50}>50+</option>
            <option value={75}>75+</option>
          </select>
        </div>
        <span className="text-muted-foreground">
          {filtered.length} of {leads.length}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Company</th>
              <th className="px-3 py-2">Contact</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2" title="AI fit score out of 100">Fit /100</th>
              <th className="px-3 py-2">Status</th>
              <th
                className="px-3 py-2"
                title="Public buying signals detected · outreach messages drafted"
              >
                Signals · Msgs
              </th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.map((l) => (
              <tr key={l.id} className="hover:bg-muted/20">
                {/* Company — always known. */}
                <td className="px-3 py-2">
                  <Link
                    href={`/dashboard/leads/${l.id}`}
                    className="font-medium hover:underline"
                  >
                    {l.companyName}
                  </Link>
                </td>
                {/* Contact — separate; company-only leads clearly marked. */}
                <td className="px-3 py-2">
                  {l.name ? (
                    <span>
                      {l.name}
                      {l.title && (
                        <span className="block text-xs text-muted-foreground">
                          {l.title}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-xs italic text-muted-foreground">
                      Company-only — no contact yet
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={sourceVariant(l.source)}>
                    {SOURCE_LABEL[l.source] ?? l.source}
                  </Badge>
                </td>
                {/* Fit score with scale + "why" on hover. */}
                <td className="px-3 py-2">
                  {l.fitScore != null ? (
                    <Badge
                      variant={scoreVariant(l.fitScore)}
                      title={
                        l.fitRationale
                          ? `Why ${l.fitScore}/100: ${l.fitRationale}`
                          : `AI fit score: ${l.fitScore}/100`
                      }
                    >
                      {l.fitScore}/100
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge variant="secondary">{l.status}</Badge>
                </td>
                <td
                  className="px-3 py-2 text-muted-foreground"
                  title={
                    l.signalCount === 0
                      ? 'No public signals detected yet — this is normal, not an error.'
                      : `${l.signalCount} public signal(s) detected`
                  }
                >
                  {l.signalCount} signal{l.signalCount === 1 ? '' : 's'} ·{' '}
                  {l.messageCount} msg
                </td>
                <td className="px-3 py-2 text-right">
                  {canManage &&
                    (l.messageCount === 0 ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => draft(l.id)}
                        loading={draftingId === l.id}
                      >
                        <Sparkles className="h-4 w-4" /> Draft
                      </Button>
                    ) : (
                      <Button asChild size="sm" variant="ghost">
                        <Link href="/dashboard/outreach">
                          Outreach <ArrowRight className="h-4 w-4" />
                        </Link>
                      </Button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
