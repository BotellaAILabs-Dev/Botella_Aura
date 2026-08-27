'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sparkles, ArrowRight, Send, FolderTree, EyeOff, ThumbsDown } from 'lucide-react';
import { toast } from '@/components/ui/toaster';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

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
  /** Stated criteria this lead meets / does not — the reviewable breakdown. */
  fitMatched: string[];
  fitMissed: string[];
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
  /**
   * Leads below this are collapsed out of the way rather than listed at the
   * same visual weight as qualified ones. A page of unexplained low scores
   * reads as noise; hiding them by default keeps the list to leads worth a
   * human's time, and the count stays visible so nothing is silently dropped.
   */
  const [minScore, setMinScore] = useState(0);
  const LOW_FIT_THRESHOLD = 40;
  const [showLowFit, setShowLowFit] = useState(false);
  const [draftingId, setDraftingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [dismissing, setDismissing] = useState<LeadTableRow | null>(null);
  /** Group the table by requirement instead of showing one flat list. */
  const [grouped, setGrouped] = useState(categories.length > 1);

  const matching = useMemo(
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

  // A lead with no score yet is not "low fit" — it is unscored, and hiding it
  // would make discovery look like it returned nothing.
  const lowFit = useMemo(
    () =>
      matching.filter(
        (l) => typeof l.fitScore === 'number' && l.fitScore < LOW_FIT_THRESHOLD,
      ),
    [matching],
  );
  const filtered = useMemo(
    () =>
      showLowFit
        ? matching
        : matching.filter(
            (l) =>
              typeof l.fitScore !== 'number' || l.fitScore >= LOW_FIT_THRESHOLD,
          ),
    [matching, showLowFit],
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
        {/* Never silently truncate: say how many are hidden and why. */}
        {lowFit.length > 0 && (
          <button
            type="button"
            onClick={() => setShowLowFit((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50"
          >
            <EyeOff className="h-3.5 w-3.5" />
            {showLowFit
              ? `Hide ${lowFit.length} low-fit (under ${LOW_FIT_THRESHOLD}/100)`
              : `${lowFit.length} low-fit lead${lowFit.length === 1 ? '' : 's'} hidden — show`}
          </button>
        )}
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
                      {/* Fit score, with the criteria it met and missed shown
                          inline — a bare number can't be reviewed. */}
                      <td className="px-3 py-2 align-top">
                        {l.fitScore != null ? (
                          <div className="space-y-1">
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
                            {l.fitMatched.length > 0 && (
                              <p className="max-w-[16rem] text-[11px] leading-tight text-muted-foreground">
                                <span className="font-medium text-foreground">
                                  Matched:
                                </span>{' '}
                                {l.fitMatched.slice(0, 3).join(', ')}
                              </p>
                            )}
                            {l.fitMatched.length === 0 && l.fitMissed.length > 0 && (
                              <p className="max-w-[16rem] text-[11px] leading-tight text-muted-foreground">
                                <span className="font-medium text-foreground">
                                  No match on:
                                </span>{' '}
                                {l.fitMissed.slice(0, 2).join('; ')}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span
                            className="text-muted-foreground"
                            title="Not scored yet — this lead arrived without a discovery requirement to score against."
                          >
                            Not scored
                          </span>
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
                        {canManage && l.status !== 'ARCHIVED' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Not relevant — tell us why"
                            onClick={() => setDismissing(l)}
                          >
                            <ThumbsDown className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        )}
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

      <DismissLeadDialog
        lead={dismissing}
        onClose={() => setDismissing(null)}
        onDone={() => {
          setDismissing(null);
          router.refresh();
        }}
      />
    </div>
  );
}

/**
 * "Not relevant, because…" — the correction channel for bad matches.
 *
 * A reason is required rather than optional: an unexplained dismissal removes
 * the lead but teaches the discovery criteria nothing, so the same wrong
 * matches come back on the next run.
 */
function DismissLeadDialog({
  lead,
  onClose,
  onDone,
}: {
  lead: LeadTableRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const PRESETS = [
    'Wrong industry',
    'Wrong company size',
    'Wrong region',
    'Not a decision maker',
    'Already a customer',
    'Competitor',
  ];

  async function submit() {
    if (!lead) return;
    if (reason.trim().length < 3) {
      toast.error('Say briefly why this lead is not relevant.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}/irrelevant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not save that.');
        return;
      }
      toast.success('Noted — future discovery runs will use this.');
      setReason('');
      onDone();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={Boolean(lead)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Not relevant — {lead?.companyName}</DialogTitle>
          <DialogDescription>
            Why doesn&apos;t this lead fit? Your answer is stored against the
            requirement that found it, so the same kind of mismatch stops being
            surfaced.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setReason(p)}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
              >
                {p}
              </button>
            ))}
          </div>
          <Textarea
            rows={3}
            placeholder="e.g. They're a distributor, not a distillery."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving}>
            Mark not relevant
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}