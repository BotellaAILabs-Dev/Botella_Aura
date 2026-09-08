'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toaster';
import { cn } from '@/lib/utils';
import { CONTENT_TYPES, type ContentTypeKey } from '@/lib/validations/content';
import { CONTENT_TYPE_LABELS } from '@/lib/content-ui';
import {
  recommendedFormatsFor,
  type MarketMode,
} from '@/lib/validations/profile';

/** What each format actually is, in the terms someone picking would use. */
const FORMAT_BLURBS: Record<ContentTypeKey, string> = {
  LINKEDIN_POST:
    'A hook-first written post. Long enough to make an argument, built for a professional feed.',
  IMAGE_POST:
    'One graphic and a caption. The ordinary social post, and the one that travels everywhere.',
  CAROUSEL:
    'Five to eight slides that build an idea. Strong on LinkedIn and Instagram alike.',
  TWEET_THREAD: 'A numbered thread for X. Short, punchy, one idea per post.',
  BLOG: 'A structured long-form draft with headings. For your own site or newsletter.',
};

/**
 * Which formats Content Studio offers this workspace.
 *
 * Presented as an opt-out list rather than a wizard because the honest default
 * is "all of them", and the useful action is removing the two or three a team
 * knows it will never use. The recommendation button exists for the same
 * reason the market-mode question does — a consumer brand and a B2B one want
 * genuinely different sets, and guessing once beats five separate decisions.
 */
export function ContentFormatsForm({
  initial,
  marketMode,
  canManage,
}: {
  initial: ContentTypeKey[];
  marketMode: MarketMode | undefined;
  canManage: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState<ContentTypeKey[]>(initial);

  const recommended = recommendedFormatsFor(marketMode);
  const isRecommended =
    recommended.length === enabled.length &&
    recommended.every((t) => enabled.includes(t));

  function toggle(type: ContentTypeKey) {
    if (!canManage) return;
    setEnabled((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }

  async function save() {
    // Turning everything off would leave nothing to create. Rather than block
    // the click, treat it as "no preference" — which is what an empty list
    // already means everywhere else.
    const payload = enabled.length === CONTENT_TYPES.length ? [] : enabled;

    setSaving(true);
    try {
      const res = await fetch('/api/company/formats', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: payload }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? 'Could not save.');
        return;
      }
      toast.success('Saved. Content Studio will offer just these.');
      router.refresh();
    } catch {
      toast.error('Could not reach the server. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle className="text-base">Formats you use</CardTitle>
        {canManage && !isRecommended && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEnabled(recommended)}
            type="button"
          >
            <Sparkles className="h-4 w-4" />
            Use the {marketMode === 'B2C' ? 'B2C' : 'B2B'} set
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Turn off what your team never posts. Anything left on is what Content
          Studio, the planner and Autopilot will offer — everything else stops
          appearing. Existing drafts are untouched either way.
        </p>

        <ul className="space-y-2">
          {CONTENT_TYPES.map((type) => {
            const on = enabled.includes(type);
            return (
              <li key={type}>
                <button
                  type="button"
                  onClick={() => toggle(type)}
                  disabled={!canManage}
                  aria-pressed={on}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition',
                    on
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border bg-card hover:bg-muted/40',
                    !canManage && 'cursor-not-allowed opacity-70',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                      on
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input bg-background',
                    )}
                    aria-hidden
                  >
                    {on && <Check className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">
                      {CONTENT_TYPE_LABELS[type]}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {FORMAT_BLURBS[type]}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {enabled.length === 0 && (
          <p className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            Nothing selected, so every format stays available. Pick the ones you
            use to narrow it.
          </p>
        )}

        {canManage && (
          <div className="flex justify-end">
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save formats'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
