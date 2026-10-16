'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  keepWork,
  keptWork,
  newIdempotencyKey,
  showFailure,
  showNetworkFailure,
  type FailureBody,
} from '@/lib/client-failure';
import { toast } from '@/components/ui/toaster';
import { CONTENT_TYPES, type ContentTypeKey } from '@/lib/validations/content';
import { CONTENT_TYPE_LABELS as TYPE_LABELS } from '@/lib/content-ui';
import {
  DEFAULT_CHOICES,
  GenerationOptions,
  choicesPayload,
  type GenerationChoices,
} from '@/components/dashboard/content/generation-options';

interface Campaign {
  id: string;
  name: string;
}

type SourceKind = 'BRIEF' | 'CAMPAIGN' | 'SUGGESTION';

/**
 * Modal to create a new draft from a brief or campaign, then open its editor —
 * or to start from an Aura suggestion, which opens the recommendation workflow
 * (`/dashboard/content/new?rec=`) with its Content Brief filled in.
 *
 * `types` is the workspace's enabled format list, resolved on the server. It
 * defaults to every format so the component keeps working anywhere it is
 * rendered without one. `suggestions` are the accepted ones Content Studio
 * carries out; without them the option is shown as unavailable.
 */
/** The quick-create brief, kept across a lost session (sessionStorage). */
const WORK_KEY = 'aura-create-content-dialog';

export function CreateContentDialog({
  types = [...CONTENT_TYPES],
  suggestions = [],
}: {
  types?: ContentTypeKey[];
  suggestions?: { id: string; title: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<ContentTypeKey>(types[0] ?? 'LINKEDIN_POST');
  const [sourceKind, setSourceKind] = useState<SourceKind>('BRIEF');
  const [suggestionId, setSuggestionId] = useState(
    suggestions.length === 1 ? suggestions[0]!.id : '',
  );
  const [brief, setBrief] = useState('');
  // Failure & recovery (lib/client-failure.ts): a retried generate returns the
  // same draft; the brief survives a lost session or a reload.
  const idempotency = useRef(newIdempotencyKey());
  useEffect(() => {
    const kept = keptWork<{ brief: string }>(WORK_KEY);
    if (kept?.brief) setBrief(kept.brief);
  }, []);
  useEffect(() => {
    keepWork(WORK_KEY, brief.trim() ? { brief } : null);
  }, [brief]);
  const [campaignId, setCampaignId] = useState('');
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignsLoaded, setCampaignsLoaded] = useState(false);
  const [choices, setChoices] = useState<GenerationChoices>(DEFAULT_CHOICES);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch('/api/campaigns')
      .then((r) => (r.ok ? r.json() : { campaigns: [] }))
      .then((d) => {
        const list: Campaign[] = d.campaigns ?? [];
        setCampaigns(list);
        // Only auto-select when there is exactly one campaign — with several,
        // silently picking the first one means content gets filed against a
        // campaign the user never chose.
        if (list.length === 1) setCampaignId((prev) => prev || list[0]!.id);
      })
      .catch(() => setCampaigns([]))
      .finally(() => setCampaignsLoaded(true));
  }, [open]);

  const noCampaigns = campaignsLoaded && campaigns.length === 0;
  const campaignMissing = sourceKind === 'CAMPAIGN' && !campaignId;
  const fromSuggestion = sourceKind === 'SUGGESTION';

  async function generate() {
    if (fromSuggestion) {
      // The suggestion's own workflow: its brief, format and network filled
      // in and checked, and the draft linked back to it.
      if (!suggestionId) {
        toast.error('Pick a suggestion first.');
        return;
      }
      setOpen(false);
      router.push(
        `/dashboard/content/new?rec=${encodeURIComponent(suggestionId)}`,
      );
      return;
    }
    if (sourceKind === 'BRIEF' && brief.trim().length < 3) {
      toast.error('Write a short brief first.');
      return;
    }
    if (sourceKind === 'CAMPAIGN' && !campaignId) {
      toast.error('Pick a campaign (or create one first).');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/content/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          source: {
            kind: sourceKind,
            ref: sourceKind === 'CAMPAIGN' ? campaignId || undefined : undefined,
            brief: brief.trim() || undefined,
          },
          campaignId: sourceKind === 'CAMPAIGN' ? campaignId || undefined : undefined,
          ...choicesPayload(choices),
          idempotencyKey: idempotency.current,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as FailureBody;
        showFailure(res.status, b, 'Generation failed — your brief is kept. Try again.');
        return;
      }
      const data = (await res.json()) as { id: string };
      keepWork(WORK_KEY, null);
      idempotency.current = newIdempotencyKey();
      toast.success('Draft generated.');
      setOpen(false);
      router.push(`/dashboard/content/${data.id}`);
    } catch {
      showNetworkFailure();
    } finally {
      setLoading(false);
    }
  }

  const selectCls =
    'h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" /> Create content
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create content</DialogTitle>
          <DialogDescription>
            AI drafts in your brand voice. You review before anything publishes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!fromSuggestion && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="type">Type</Label>
                <select
                  id="type"
                  className={selectCls}
                  value={type}
                  onChange={(e) => setType(e.target.value as ContentTypeKey)}
                >
                  {types.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>
              <GenerationOptions
                type={type}
                value={choices}
                onChange={setChoices}
              />
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="source">From</Label>
            <select
              id="source"
              className={selectCls}
              value={sourceKind}
              onChange={(e) => setSourceKind(e.target.value as SourceKind)}
            >
              <option value="BRIEF">A brief I write</option>
              <option value="CAMPAIGN" disabled={noCampaigns}>
                A campaign{noCampaigns ? ' (none yet)' : ''}
              </option>
              <option value="SUGGESTION" disabled={suggestions.length === 0}>
                An Aura suggestion
                {suggestions.length === 0 ? ' (none accepted yet)' : ''}
              </option>
            </select>
            <p className="text-xs text-muted-foreground">
              Tip: generate from a specific trend using &ldquo;Generate content
              from this&rdquo; on the Market trends page.
            </p>
          </div>

          {sourceKind === 'CAMPAIGN' &&
            (noCampaigns ? (
              <div className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-sm">
                <p className="text-foreground">You don&apos;t have any campaigns yet.</p>
                <p className="mt-0.5 text-muted-foreground">
                  Create a campaign to plan and tag content, or use a brief instead.
                </p>
                <Button asChild variant="outline" size="sm" className="mt-2">
                  <Link href="/dashboard/campaigns">Go to Campaigns</Link>
                </Button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="campaign">
                  Campaign {campaigns.length > 1 && <span aria-hidden>*</span>}
                </Label>
                <select
                  id="campaign"
                  className={selectCls}
                  value={campaignId}
                  onChange={(e) => setCampaignId(e.target.value)}
                >
                  {/* Explicit placeholder: with several campaigns the user picks. */}
                  {campaigns.length > 1 && (
                    <option value="">Select a campaign…</option>
                  )}
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {campaigns.length > 1
                    ? `You have ${campaigns.length} campaigns — choose which one this content belongs to.`
                    : 'This draft will be filed against your campaign.'}
                </p>
              </div>
            ))}

          {fromSuggestion && (
            <div className="space-y-1.5">
              <Label htmlFor="suggestion">Suggestion</Label>
              <select
                id="suggestion"
                className={selectCls}
                value={suggestionId}
                onChange={(e) => setSuggestionId(e.target.value)}
              >
                {suggestions.length > 1 && (
                  <option value="">Select a suggestion…</option>
                )}
                {suggestions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Opens the suggestion&apos;s brief — format, network, key message
                and evidence filled in — for you to check and edit before
                generating.
              </p>
            </div>
          )}

          {!fromSuggestion && (
            <div className="space-y-1.5">
              <Label htmlFor="brief">
                Brief {sourceKind === 'CAMPAIGN' && '(optional)'}
              </Label>
              <Textarea
                id="brief"
                rows={4}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="e.g. Write about our new usage-based pricing and why it's fairer for small teams"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            onClick={generate}
            loading={loading}
            disabled={campaignMissing || (fromSuggestion && !suggestionId)}
          >
            <Sparkles className="h-4 w-4" />{' '}
            {fromSuggestion
              ? 'Continue with this suggestion'
              : 'Generate draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
