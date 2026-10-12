import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ArrowLeft, Info } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { getDraft } from '@/server/content/content.service';
import { renderForManual } from '@/server/content/render';
import { canAutoPublishTo } from '@/server/content/publish.service';
import {
  CONTENT_TYPE_LABELS,
  CONTENT_STATUS_LABELS,
  draftSnippet,
} from '@/lib/content-ui';
import type { QualityReport } from '@/lib/content-quality';
import { isCopyOnlyType } from '@/lib/validations/content';
import { ContentAssistantPanel } from '@/components/dashboard/content/content-assistant-panel';
import {
  resolvePlatform,
  platformSpec,
  platformsForType,
} from '@/lib/platforms';
import {
  attachedAssetIds,
  getAttachedMedia,
  listAssets,
  toAssetView,
} from '@/server/media/asset.service';
import { findActiveImageJob } from '@/server/jobs/job.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Badge, statusBadgeVariant } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { DraftPreview } from '@/components/dashboard/content/draft-preview';
import { availableVariations } from '@/lib/content-variations';
import type { SocialPlatformKey } from '@/lib/platforms';
import { CreatedFromSuggestion } from '@/components/dashboard/content/created-from-suggestion';
import { FactCheckPanel } from '@/components/dashboard/content/fact-check-panel';
import { claimsToReview } from '@/lib/fact-check';
import { factCheckDraft } from '@/server/content/fact-check.service';
import { VisualBriefPanel } from '@/components/dashboard/content/visual-brief-panel';
import { visualBriefForDraft } from '@/server/media/visual-brief.service';
import type { CreationProvenance } from '@/lib/recommendation-creation';
import { DraftActions } from '@/components/dashboard/content/draft-actions';
import { GraphicStudio } from '@/components/dashboard/content/graphic-studio';
import { AgnesImageGenerator } from '@/components/dashboard/content/agnes-image-generator';
import { googleImageProvider } from '@/server/media/providers/gemini';
import { agnesImageProvider } from '@/server/media/providers/agnes';
import { PostComposer } from '@/components/dashboard/content/post-composer';
import type { ContentTypeKey } from '@/lib/validations/content';

/** Where each copied-out format is used, and its copy button. */
const COPY_OUT: Partial<
  Record<ContentTypeKey, { what: string; where: string; button: string }>
> = {
  EMAIL: { what: 'Emails are', where: 'your email tool', button: 'Copy email' },
  AD: { what: 'Ads are', where: 'your ad manager', button: 'Copy ad' },
  CAMPAIGN_COPY: {
    what: 'Campaign copy is',
    where: 'the channels your campaign runs on',
    button: 'Copy campaign copy',
  },
  PROMO: {
    what: 'Promotional copy is',
    where: 'your site, newsletter or posts',
    button: 'Copy promotion',
  },
};

export const metadata: Metadata = { title: 'Content draft' };

export default async function DraftDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const draft = await getDraft(active.id, params.id);
  if (!draft) notFound();

  const membership = await getMembership(user.id, active.id);
  const canPublish = membership ? can(membership.role, 'content:publish') : false;
  // Editing covers the graphic studio and the composer: a MEMBER who can draft
  // content can also make its graphic and queue it for review.
  const canEdit =
    membership !== null &&
    can(membership.role, 'content:create') &&
    draft.status !== 'PUBLISHED';

  const type = draft.type as ContentTypeKey;
  const platform = resolvePlatform(type, draft.platform);
  const meta = (draft.aiMetadata ?? {}) as {
    source?: { kind?: string; brief?: string | null };
    quality?: QualityReport;
    variations?: {
      angle?: string;
      body?: unknown;
      quality?: QualityReport;
      kind?: string;
      platform?: SocialPlatformKey;
      facts?: { introduced?: string[] };
    }[];
    activeVariation?: number;
    history?: unknown[];
    writtenFor?: string | null;
    tone?: string | null;
    /**
     * The Aura recommendation it was written for, with the context it carried
     * (lib/recommendation-creation.ts). Older drafts have only id and title.
     */
    recommendation?: Partial<CreationProvenance> & { id?: string; title?: string };
    /** The Content Brief it was written from (lib/content-brief.ts). */
    brief?: {
      keyMessage?: { value?: string } | null;
      contentType?: { label?: string } | null;
      channel?: { name?: string | null } | null;
    };
  };
  const sourceKind = meta.source?.kind;
  const copyOnly = isCopyOnlyType(type);
  const variations = (meta.variations ?? []).map((v, i) => {
    // The version in use reads as the draft does now (hand edits included).
    const body = i === (meta.activeVariation ?? 0) ? draft.body : v.body;
    const blockers = (v.quality?.issues ?? []).filter((x) => x.severity === 'block');
    return {
      angle: v.angle ?? '',
      snippet: draftSnippet(type, body),
      text: renderForManual({ ...draft, body } as typeof draft),
      approvable: v.quality?.approvable ?? true,
      issues: blockers.length,
      blockers: blockers.map((x) => x.message),
      ...(v.kind ? { kind: v.kind } : {}),
      platformLabel: v.platform ? platformSpec(v.platform).label : null,
      // Only variations are fact-checked; versions written at generation are originals.
      factsKept: v.facts ? (v.facts.introduced ?? []).length === 0 : null,
      introduced: v.facts?.introduced ?? [],
    };
  });
  // What can be asked for here (lib/content-variations.ts).
  const variationOptions =
    canEdit
      ? availableVariations(type, isCopyOnlyType(type) && type !== 'AD' ? null : platform).map((o) => ({
          kind: o.kind,
          label: o.label,
          available: o.available,
          reason: o.reason,
          ...(o.platforms ? { platforms: o.platforms.map((p) => ({ key: p, label: platformSpec(p).label })) } : {}),
          ...(o.tones ? { tones: o.tones } : {}),
        }))
      : [];

  // Graphics and attachments are loaded server-side so the panel renders with
  // its history already present — no spinner on a page that has been visited.
  const [assets, attached, media, activeJob, visual, factCheck] = await Promise.all([
    listAssets(active.id, { draftId: draft.id }),
    attachedAssetIds(active.id, draft.id),
    getAttachedMedia({
      companyId: active.id,
      draftId: draft.id,
      type,
      platform: draft.platform,
    }),
    // A generation still running for this draft, so a reload reattaches to it
    // rather than showing an idle panel while images are still being made.
    findActiveImageJob(active.id, draft.id),
    // What the image is for (lib/visual-brief.ts).
    visualBriefForDraft(draft, platform),
    // Every claim, against what Aura trusts now (lib/fact-check.ts).
    factCheckDraft(draft),
  ]);
  const toReview = claimsToReview(factCheck).length;

  return (
    <div>
      <Link
        href="/dashboard/content"
        className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Content Studio
      </Link>
      <PageHeader
        title={draft.title ?? CONTENT_TYPE_LABELS[type]}
        description={`${CONTENT_TYPE_LABELS[type]} · created ${draft.createdAt.toLocaleDateString()}`}
        actions={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant={statusBadgeVariant(draft.status)}>
              {CONTENT_STATUS_LABELS[draft.status]}
            </Badge>
            {(factCheck.status === 'needs_review' || factCheck.status === 'contradicted') && (
              <Badge variant={factCheck.status === 'contradicted' ? 'destructive' : 'warning'}>
                {factCheck.status === 'contradicted' ? 'Contradiction' : 'Needs fact review'}
              </Badge>
            )}
          </span>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Preview + actions */}
        <div className="space-y-5">
          <DraftPreview type={type} body={draft.body} />
          <FactCheckPanel report={factCheck} />

          {/* Content → graphic → post → queue, in the order the user works. */}
          <VisualBriefPanel
            brief={visual.brief}
            fromRecommendation={visual.source === 'content_brief'}
            hasImage={media.length > 0}
          />
          <GraphicStudio
            draftId={draft.id}
            platform={platform}
            platformLabel={platformSpec(platform).label}
            // The shape the visual brief names for this format and channel
            // (an email header is landscape), else the network's default.
            defaultRatio={visual.brief.format.aspectRatio ?? platformSpec(platform).defaultRatio}
            initialAssets={assets.map((a) => toAssetView(a, attached))}
            attachedAssetIds={[...attached]}
            activeJobId={activeJob?.id ?? null}
            canEdit={canEdit}
          />

          {/* Text-to-image via Agnes AI. Talks to /api/generate-image, which
              holds the credential server-side — the browser never sees it. */}
          {canEdit && (
            <AgnesImageGenerator
              configured={{
                huggingface: Boolean(process.env.HUGGINGFACE_API_KEY),
                'nano-banana': googleImageProvider.isConfigured(),
                agnes: agnesImageProvider.isConfigured(),
              }}
            />
          )}

          {/* Email and ad copy are copied out, never queued or posted. */}
          {!copyOnly && (
            <PostComposer
              draftId={draft.id}
              status={draft.status}
              contentPreview={renderForManual(draft)}
              platform={platform}
              platformOptions={platformsForType(type)}
              media={media}
              scheduledFor={draft.scheduledFor ? draft.scheduledFor.toISOString() : null}
              canEdit={canEdit}
            />
          )}

          <Card>
            <CardContent className="p-4">
              <DraftActions
                draftId={draft.id}
                type={type}
                status={draft.status}
                bodyJson={JSON.stringify(draft.body, null, 2)}
                manualText={renderForManual(draft)}
                publishedUrl={draft.publishedUrl}
                canPublish={canPublish && !copyOnly}
                canUndo={(meta.history?.length ?? 0) > 0}
                copyOnly={copyOnly}
                factCheck={{ status: factCheck.status, toReview, mustFix: factCheck.mustFix }}
              />
            </CardContent>
          </Card>
        </div>

        {/* Metadata sidebar */}
        <aside className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <p className="mb-3 text-sm font-semibold text-foreground">
                Writing assistant
              </p>
              <ContentAssistantPanel
                draftId={draft.id}
                editable={canEdit}
                writtenFor={
                  meta.writtenFor
                    ? platformSpec(meta.writtenFor as typeof platform).label
                    : type === 'EMAIL'
                      ? 'email'
                      : type === 'CAMPAIGN_COPY' || type === 'PROMO'
                        ? CONTENT_TYPE_LABELS[type].toLowerCase()
                        : null
                }
                tone={meta.tone ?? null}
                quality={meta.quality ?? null}
                variations={variations}
                options={variationOptions}
                activeVariation={meta.activeVariation ?? 0}
              />
            </CardContent>
          </Card>
          {meta.recommendation?.id && (
            <CreatedFromSuggestion
              recommendation={meta.recommendation}
              keyMessage={meta.brief?.keyMessage?.value ?? null}
              made={
                meta.brief?.contentType?.label
                  ? `${meta.brief.contentType.label}${meta.brief.channel?.name ? ` for ${meta.brief.channel.name}` : ''}`
                  : null
              }
            />
          )}
          <Card>
            <CardContent className="space-y-3 p-4 text-sm">
              <Row label="Type" value={CONTENT_TYPE_LABELS[type]} />
              <Row label="Status" value={CONTENT_STATUS_LABELS[draft.status]} />
              <Row
                label={type === 'AD' ? 'Placement' : 'Platform'}
                value={
                  type === 'EMAIL' || type === 'CAMPAIGN_COPY' || type === 'PROMO'
                    ? `${CONTENT_TYPE_LABELS[type]} (copied out)`
                    : platformSpec(platform).label
                }
              />
              <Row
                label="Graphic"
                value={media.length === 0 ? 'None attached' : `${media.length} attached`}
              />
              {sourceKind && (
                <Row label="Source" value={sourceKind.toLowerCase()} />
              )}
              {meta.recommendation?.id && (
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Written for</span>
                  <Link
                    href="/dashboard/suggestions/history"
                    className="text-right font-medium text-primary hover:underline"
                  >
                    {meta.recommendation.title ?? 'Aura’s suggestion'}
                  </Link>
                </div>
              )}
              {draft.scheduledFor && (
                <Row
                  label="Scheduled"
                  value={new Date(draft.scheduledFor).toLocaleString()}
                />
              )}
              {draft.rejectionReason && (
                <Row label="Rejection reason" value={draft.rejectionReason} />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-start gap-2 p-4 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                {copyOnly ? (
                  <>
                    {COPY_OUT[type]?.what ?? 'This is'} written here and used
                    in {COPY_OUT[type]?.where ?? 'your own tools'} — approve
                    it, then use{' '}
                    <span className="font-medium text-foreground">
                      “{COPY_OUT[type]?.button ?? 'Copy'}”
                    </span>
                    . Aura never posts it to a social network.
                  </>
                ) : canAutoPublishTo(type, platform) ? (
                  <>
                    Approved posts publish to{' '}
                    <span className="font-medium text-foreground">
                      {platformSpec(platform).label}
                    </span>{' '}
                    through its official API, with the attached graphic. If the
                    connection lacks posting permission, you get the “copy for
                    manual posting” fallback instead — never a false “published”.
                  </>
                ) : (
                  <>
                    This content type isn&apos;t natively publishable to{' '}
                    {platformSpec(platform).label} via API — use{' '}
                    <span className="font-medium text-foreground">
                      “Copy for manual posting”
                    </span>{' '}
                    or the browser extension, which carries the graphic too.
                  </>
                )}
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}
