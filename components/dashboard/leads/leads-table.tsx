'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sparkles, ArrowRight, Send, FolderTree } from 'lucide-react';
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
  /** The requirement this lead came from, e.g. "Distillery". */
  category: string | null;
  /** The discovery profile that found it (may have been renamed since). */
  profileName: string | null;
  fitScore: number | null;
  fitRationale: string | null;
  signalCount: number;
  messageCount: number;
}

export interface LeadCategoryOption {
  category: string | null;
  label: string;
  count: number;
}

const SOURCE_LABEL: Record<string, string> = {
  SIGNAL: 'Signal',
  DISCOVERY_ENGINE: 'Discovery',
  MANUAL: 'Manual',
};

const UNCATEGORISED = '__none__';

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
  categories,
  canManage,
}: {
  leads: LeadTableRow[];
  categories: LeadCategoryOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [source, setSource] = useState('ALL');
  const [category, setCategory] = useState('ALL');
  const [minScore, setMinScore] = useState(0);
  const [draftingId, setDraftingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  /** Group the table by requirement instead of showing one flat list. */
  const [grouped, setGrouped] = useState(categories.length > 1);

  const filtered = useMemo(
    () =>
      leads.filter(
        (l) =>
          (source === 'ALL' || l.source === source) &&
          (category === 'ALL' ||
            (category === UNCATEGORISED ? !l.category : l.category === category)) &&
          (l.fitScore ?? 0) >= minScore,
      ),
    [leads, source, category, minScore],
  );

  /** Requirement buckets present in the current filter, in table order. */
  const groups = useMemo(() => {
    if (!grouped) return [{ key: 'ALL', label: 'All leads', rows: filtered }];
    const map = new Map<string, { key: string; label: string; rows: LeadTableRow[] }>();
    for (const l of filtered) {
      const key = l.category ?? UNCATEGORISED;
      const label = l.category ?? 'No requirement (signal / manual)';
      if (!map.has(key)) map.set(key, { key, label, rows: [] });
      map.get(key)!.rows.push(l);
    }
    return [...map.values()].sort((a, b) => b.rows.length - a.rows.length);
  }, [filtered, grouped]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll(rows: LeadTableRow[]) {
    const ids = rows.map((r) => r.id);
    const allOn = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

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

  /**
   * The explicit Leads → Outreach hand-off. Qualifies the selected leads and
   * lands on the Outreach board already filtered to the same requirement, so
   * the leads you just moved are the leads you see.
   */
  async function sendToOutreach() {
    const leadIds = [...selected];
    if (leadIds.length === 0) return;
    setSending(true);
    try {
      const res = await fetch('/api/outreach/leads/send-to-outreach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadIds }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        moved?: number;
        categories?: string[];
      };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not move these leads to Outreach.');
        return;
      }
      toast.success(
        `${body.moved ?? leadIds.length} lead(s) moved to Outreach — draft their messages there.`,
      );
      setSelected(new Set());
      const only = body.categories?.length === 1 ? body.categories[0] : undefined;
      router.push(
        only
          ? `/dashboard/outreach?category=${encodeURIComponent(only)}`
          : '/dashboard/outreach',
      );
    } finally {
      setSending(false);
    }
  }

  const selectCls = 'rounded-md border border-input bg-background px-2 py-1';

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        {/* Requirement / category — the primary grouping. */}
        {categories.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Requirement</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className={selectCls}
              title="Leads keep the requirement they were discovered for"
            >
              <option value="ALL">All requirements</option>
              {categories.map((c) => (
                <option key={c.category ?? UNCATEGORISED} value={c.category ?? UNCATEGORISED}>
                  {c.label} ({c.count})
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Source</span>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className={selectCls}
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
            className={selectCls}
          >
            <option value={0}>Any</option>
            <option value={50}>50+</option>
            <option value={75}>75+</option>
          </select>
        </div>
        {categories.length > 1 && (
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <input
              type="checkbox"
              checked={grouped}
              onChange={(e) => setGrouped(e.target.checked)}
              className="h-4 w-4 accent-[hsl(var(--primary))]"
            />
            <FolderTree className="h-4 w-4" /> Group by requirement
          </label>
        )}
        <span className="text-muted-foreground">
          {filtered.length} of {leads.length}
        </span>
      </div>

      {/* Bulk hand-off bar — the explicit Leads → Outreach step. */}
      {canManage && selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="text-foreground">
            {selected.size} lead{selected.size === 1 ? '' : 's'} selected
          </span>
          <div className="flex gap-2">
            <Button size="sm" onClick={sendToOutreach} loading={sending}>
              <Send className="h-4 w-4" /> Send to Outreach
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-6">
        {groups.map((g) => (
          <div key={g.key}>
            {grouped && (
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">{g.label}</h3>
                <Badge variant="muted">{g.rows.length}</Badge>
              </div>
            )}
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    {canManage && (
                      <th className="w-8 px-3 py-2">
                        <input
                          type="checkbox"
                          aria-label="Select all in this group"
                          checked={
                            g.rows.length > 0 &&
                            g.rows.every((r) => selected.has(r.id))
                          }
                          onChange={() => toggleAll(g.rows)}
                          className="h-4 w-4 accent-[hsl(var(--primary))]"
                        />
                      </th>
                    )}
                    <th className="px-3 py-2">Company</th>
                    <th className="px-3 py-2">Contact</th>
                    {!grouped && <th className="px-3 py-2">Requirement</th>}
                    <th className="px-3 py-2">Source</th>
                    <th className="px-3 py-2" title="AI fit score out of 100">
                      Fit /100
                    </th>
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
                  {g.rows.map((l) => (
                    <tr key={l.id} className="hover:bg-muted/20">
                      {canManage && (
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label={`Select ${l.companyName}`}
                            checked={selected.has(l.id)}
                            onChange={() => toggle(l.id)}
                            className="h-4 w-4 accent-[hsl(var(--primary))]"
                          />
                        </td>
                      )}
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
                      {!grouped && (
                        <td className="px-3 py-2">
                          {l.category ? (
                            <Badge
                              variant="outline"
                              title={
                                l.profileName && l.profileName !== l.category
                                  ? `Discovered by "${l.profileName}"`
                                  : 'The requirement this lead was discovered for'
                              }
                            >
                              {l.category}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      )}
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
                              <Link
                                href={
                                  l.category
                                    ? `/dashboard/outreach?category=${encodeURIComponent(l.category)}`
                                    : '/dashboard/outreach'
                                }
                              >
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
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">
          No leads match these filters. Widen the requirement or fit-score filter to
          see the rest.
        </p>
      )}
    </div>
  );
}
