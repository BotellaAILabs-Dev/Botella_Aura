'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
import {
  keepWork,
  keptWork,
  newIdempotencyKey,
  showFailure,
  showNetworkFailure,
  type FailureBody,
} from '@/lib/client-failure';
import { toast } from '@/components/ui/toaster';
import type { ContentTypeKey } from '@/lib/validations/content';
import {
  briefText,
  buildContentBrief,
  validateContentBrief,
  type BuildBriefInput,
} from '@/lib/content-brief';
import { NOT_ACCEPTED_BLOCKER } from '@/lib/recommendation-context-handoff';
import { ContentBriefPanel } from '@/components/dashboard/content/content-brief-panel';
import { CreationNotice } from '@/components/dashboard/content/creation-notice';
import type { CreationPlan } from '@/lib/recommendation-creation';
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
  briefInput = null,
  creation = null,
  recUnavailable = false,
}: {
  types: ContentTypeKey[];
  /**
   * What the recommendation's Content Brief is built from, when opened with
   * `?rec=` (lib/content-brief.ts). The brief itself is rebuilt here as the
   * person picks a format and network, so it always describes what will be
   * made.
   */
  briefInput?: Omit<BuildBriefInput, 'choice'> | null;
  /**
   * What writing from that recommendation means (lib/recommendation-creation.ts):
   * ready, say-yes-first, missing something required, or nothing to write.
   */
  creation?: CreationPlan | null;
  /** `?rec=` named a suggestion this workspace does not have. */
  recUnavailable?: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const trendId = params.get('trendId') ?? undefined;
  const handoff = briefInput?.handoff ?? null;
  // From a recommendation, the text, format and network come from its
  // Content Brief — the source of truth for what is to be made.
  const initialContentBrief = useMemo(
    () => (briefInput ? buildContentBrief({ ...briefInput, choice: null }) : null),
    [briefInput],
  );
  const initialBrief = initialContentBrief
    ? briefText(initialContentBrief)
    : (params.get('brief') ?? '');
  const initialType = (initialContentBrief?.contentType?.key ??
    params.get('type')) as ContentTypeKey | null;
  const campaignId = params.get('campaignId') ?? undefined;
  // From an Aura recommendation (lib/aura-modules.ts): the draft remembers it.
  // A suggestion that is not this workspace's is not sent at all.
  const recommendationId = creation?.recommendationId ?? undefined;
  const needsInfo = creation?.state === 'needs_info';

  // A ?type= deep link for a format this workspace disabled falls back to the
  // first one it does allow, rather than pre-selecting something the generate
  // route will refuse.
  const [type, setType] = useState<ContentTypeKey>(
    initialType && types.includes(initialType) ? initialType : types[0]!,
  );
  const [brief, setBrief] = useState(initialBrief);
  const [choices, setChoices] = useState<GenerationChoices>({
    ...DEFAULT_CHOICES,
    // The network the recommendation named, so it is not lost to the default.
    platform:
      initialContentBrief?.channel?.source === 'recommendation'
        ? (initialContentBrief.channel.platform ?? null)
        : null,
  });
  const [loading, setLoading] = useState(false);
  // Failure & recovery (lib/client-failure.ts): one key per open form so a
  // retry returns the draft already written; the brief survives a lost
  // session or a reload.
  const idempotency = useRef(newIdempotencyKey());
  const workKey = `aura-new-content:${recommendationId ?? trendId ?? campaignId ?? 'brief'}`;
  useEffect(() => {
    const kept = keptWork<{ brief: string; type: ContentTypeKey }>(workKey);
    if (kept?.brief) setBrief(kept.brief);
    if (kept?.type && types.includes(kept.type)) setType(kept.type);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workKey]);
  useEffect(() => {
    keepWork(workKey, brief.trim() && brief !== initialBrief ? { brief, type } : null);
  }, [workKey, brief, type, initialBrief]);

  // The brief for exactly what is about to be made, and the same check the
  // server runs before generating from it.
  const contentBrief = useMemo(
    () =>
      briefInput
        ? buildContentBrief({
            ...briefInput,
            choice: { type, ...(choices.platform ? { platform: choices.platform } : {}) },
          })
        : null,
    [briefInput, type, choices.platform],
  );
  const briefErrors = contentBrief
    ? validateContentBrief(contentBrief).errors.filter(
        (e) => !(creation?.acceptsOnCreate && e === NOT_ACCEPTED_BLOCKER),
      )
    : [];

  async function generate() {
    setLoading(true);
    try {
      // Writing from a suggestion that is still open says yes to it first —
      // the same decision as Accept, recorded as made from Content Studio.
      if (recommendationId && creation?.acceptsOnCreate) {
        const yes = await fetch(`/api/recommendations/${recommendationId}/creation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ module: 'content-studio' }),
        });
        if (!yes.ok) {
          const b = (await yes.json().catch(() => ({}))) as FailureBody;
          showFailure(yes.status, b, 'Could not say yes to this suggestion.');
          return;
        }
      }
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
          idempotencyKey: idempotency.current,
        }),
      });
      if (!res.ok) {
        // The brief stays in the form (and in session storage); the fix, if
        // the server named one, is a button.
        const b = (await res.json().catch(() => ({}))) as FailureBody;
        showFailure(res.status, b, 'Generation failed — your brief is kept. Try again.');
        return;
      }
      const data = (await res.json()) as { id: string };
      keepWork(workKey, null);
      idempotency.current = newIdempotencyKey();
      toast.success(
        choices.variations > 1
          ? `${choices.variations} versions written — pick your favourite on the draft.`
          : 'Draft generated.',
      );
      // Carry the suggestion, so the context bar on the draft is this one's.
      router.push(
        `/dashboard/content/${data.id}${recommendationId ? `?rec=${recommendationId}` : ''}`,
      );
    } catch {
      showNetworkFailure();
    } finally {
      setLoading(false);
    }
  }

  // Nothing to write from this suggestion: say so, and where it IS done.
  if (
    creation &&
    handoff &&
    (creation.state === 'not_creatable' || creation.state === 'closed')
  ) {
    return (
      <div className="mx-auto max-w-xl">
        <Link
          href="/dashboard/suggestions"
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Aura Suggests
        </Link>
        <PageHeader
          title="Generate content"
          description="From Aura’s suggestion."
        />
        <CreationNotice plan={creation} title={handoff.action.title} />
      </div>
    );
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
      {recUnavailable && (
        <p
          className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          role="status"
        >
          That suggestion isn’t available any more, so nothing is filled in —
          write from your own brief below, or pick another in{' '}
          <Link href="/dashboard/suggestions" className="text-primary hover:underline">
            Aura Suggests
          </Link>
          .
        </p>
      )}
      {contentBrief && (
        <ContentBriefPanel
          brief={contentBrief}
          acceptsOnCreate={creation?.acceptsOnCreate ?? false}
        />
      )}
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
          {needsInfo && creation && (
            <p className="text-xs text-foreground" role="status">
              Aura can’t write this one yet: {creation.message}{' '}
              {creation.fix && (
                <Link href={creation.fix.href} className="text-primary hover:underline">
                  {creation.fix.label}
                </Link>
              )}
            </p>
          )}
          {!needsInfo && briefErrors.length > 0 && (
            <p className="text-xs text-foreground" role="status">
              The brief isn’t complete yet: {briefErrors[0]}
            </p>
          )}
          <Button
            onClick={generate}
            loading={loading}
            disabled={needsInfo || briefErrors.length > 0}
            className="w-full"
          >
            <Sparkles className="h-4 w-4" />{' '}
            {creation?.acceptsOnCreate ? 'Say yes and generate' : 'Generate draft'}
          </Button>
          {creation?.acceptsOnCreate && (
            <p className="text-center text-xs text-muted-foreground">
              Generating from this suggestion also says yes to it.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
