'use client';

import { useEffect, useState } from 'react';
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
import { toast } from '@/components/ui/toaster';
import { CONTENT_TYPES, type ContentTypeKey } from '@/lib/validations/content';

const TYPE_LABELS: Record<ContentTypeKey, string> = {
  LINKEDIN_POST: 'LinkedIn post',
  IMAGE_POST: 'Single image post',
  CAROUSEL: 'Carousel',
  TWEET_THREAD: 'X thread',
  BLOG: 'Blog draft',
};

interface Campaign {
  id: string;
  name: string;
}

/**
 * Modal to create a new draft from a brief or campaign, then open its editor.
 *
 * `types` is the workspace's enabled format list, resolved on the server. It
 * defaults to every format so the component keeps working anywhere it is
 * rendered without one.
 */
export function CreateContentDialog({
  types = [...CONTENT_TYPES],
}: {
  types?: ContentTypeKey[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<ContentTypeKey>(types[0] ?? 'LINKEDIN_POST');
  const [sourceKind, setSourceKind] = useState<'BRIEF' | 'CAMPAIGN'>('BRIEF');
  const [brief, setBrief] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignsLoaded, setCampaignsLoaded] = useState(false);
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

  async function generate() {
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
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Generation failed.');
        return;
      }
      const data = (await res.json()) as { id: string };
      toast.success('Draft generated.');
      setOpen(false);
      router.push(`/dashboard/content/${data.id}`);
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

          <div className="space-y-1.5">
            <Label htmlFor="source">From</Label>
            <select
              id="source"
              className={selectCls}
              value={sourceKind}
              onChange={(e) => setSourceKind(e.target.value as 'BRIEF' | 'CAMPAIGN')}
            >
              <option value="BRIEF">A brief I write</option>
              <option value="CAMPAIGN" disabled={noCampaigns}>
                A campaign{noCampaigns ? ' (none yet)' : ''}
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
        </div>

        <DialogFooter>
          <Button onClick={generate} loading={loading} disabled={campaignMissing}>
            <Sparkles className="h-4 w-4" /> Generate draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
