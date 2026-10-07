'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { PageHeader } from '@/components/dashboard/page-header';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';
import type { ContentTypeKey } from '@/lib/validations/content';
import {
  handoffBrief,
  type ContextHandoff,
} from '@/lib/recommendation-context-handoff';
import { HandoffPanel } from '@/components/dashboard/content/handoff-panel';
import { CONTENT_TYPE_LABELS } from '@/lib/content-ui';
import {
  DEFAULT_CHOICES,
  GenerationOptions,
  choicesPayload,
  type GenerationChoices,
} from '@/components/dashboard/content/generation-options';

/**
 * Single hand-off point into Content Studio.
 *
 * `?rec=` comes from an Aura recommendation, with its `?brief=` and `?type=`
 * (lib/aura-modules.ts): the draft is linked back to it. `?trendId=` comes
 * from Market trends; `?brief=` also comes from
 * Opportunities and the Content plan calendar, so a suggested idea can
 * be turned into a real draft without retyping it. The brief stays editable —
 * the suggestion is a starting point, not a instruction.
 *
 * `types` is the workspace's enabled format list, resolved on the server. It is
 * a prop rather than a fetch so the buttons are correct on first paint: a page
 * that renders five formats and then removes two looks like a bug, and a
 * workspace that turned a format off should never see it offered at all.
 */
export function NewContentForm({
  types,
  handoff = null,
}: {
  types: ContentTypeKey[];
  /** The recommendation's Context Handoff, when opened with `?rec=`. */
  handoff?: ContextHandoff | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const trendId = params.get('trendId') ?? undefined;
  // From a recommendation, the brief and format come from its handoff: the
  // full context, with what is missing stated instead of invented.
  const initialBrief = handoff
    ? handoffBrief(handoff)
    : (params.get('brief') ?? '');
  const initialType = (handoff?.channel?.contentType ??
    params.get('type')) as ContentTypeKey | null;
  const campaignId = params.get('campaignId') ?? undefined;
  // From an Aura recommendation (lib/aura-modules.ts): the draft remembers it.
  const recommendationId = params.get('rec') ?? undefined;

  // A ?type= deep link for a format this workspace disabled falls back to the
  // first one it does allow, rather than pre-selecting something the generate
  // route will refuse.
  const [type, setType] = useState<ContentTypeKey>(
    initialType && types.includes(initialType) ? initialType : types[0]!,
  );
  const [brief, setBrief] = useState(initialBrief);
  const [choices, setChoices] = useState<GenerationChoices>(DEFAULT_CHOICES);
  const [loading, setLoading] = useState(false);

  async function generate() {
    setLoading(true);
    try {
      const res = await fetch('/api/content/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          source: trendId
            ? { kind: 'TREND', ref: trendId, ...(brief.trim() ? { brief: brief.trim() } : {}) }
            : {
                kind: 'BRIEF',
                brief: brief.trim() || 'Timely content for our audience.',
              },
          ...(campaignId ? { campaignId } : {}),
          ...(recommendationId ? { recommendationId } : {}),
          ...choicesPayload(choices),
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Generation failed.');
        return;
      }
      const data = (await res.json()) as { id: string };
      toast.success(
        choices.variations > 1
          ? `${choices.variations} versions written — pick your favourite on the draft.`
          : 'Draft generated.',
      );
      router.push(`/dashboard/content/${data.id}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <Link
        href={trendId ? '/dashboard/trends' : '/dashboard/content'}
        className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />{' '}
        {trendId ? 'Market trends' : 'Content Studio'}
      </Link>
      <PageHeader
        title="Generate content"
        description={
          trendId
            ? 'From the selected trend, in your brand voice.'
            : recommendationId && initialBrief
              ? 'From Aura’s suggestion — the brief is filled in below. Edit it before generating.'
              : initialBrief
              ? 'From the suggested brief below — edit it before generating.'
              : 'Pick a type to generate.'
        }
      />
      {handoff && <HandoffPanel handoff={handoff} />}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Choose a format</CardTitle>
          <CardDescription>
            We&apos;ll ground it in your business materials and brand voice.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {types.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                aria-pressed={type === t}
                className={
                  'rounded-md border px-3 py-3 text-sm font-medium transition-colors ' +
                  (type === t
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border hover:bg-muted')
                }
              >
                {CONTENT_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="brief">
              Brief {trendId && <span className="text-muted-foreground">(optional)</span>}
            </Label>
            <Textarea
              id="brief"
              rows={4}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="What should this piece say? Edit freely — this is your instruction to the writer."
            />
          </div>
          <GenerationOptions type={type} value={choices} onChange={setChoices} />
          <Button onClick={generate} loading={loading} className="w-full">
            <Sparkles className="h-4 w-4" /> Generate draft
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
