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
import { CONTENT_TYPE_LABELS, CONTENT_STATUS_LABELS } from '@/lib/content-ui';
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
import { DraftActions } from '@/components/dashboard/content/draft-actions';
import { GraphicStudio } from '@/components/dashboard/content/graphic-studio';
import { AgnesImageGenerator } from '@/components/dashboard/content/agnes-image-generator';
import { googleImageProvider } from '@/server/media/providers/gemini';
import { agnesImageProvider } from '@/server/media/providers/agnes';
import { PostComposer } from '@/components/dashboard/content/post-composer';
import type { ContentTypeKey } from '@/lib/validations/content';

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
  };
  const sourceKind = meta.source?.kind;

  // Graphics and attachments are loaded server-side so the panel renders with
  // its history already present — no spinner on a page that has been visited.
  const [assets, attached, media, activeJob] = await Promise.all([
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
  ]);

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
          <Badge variant={statusBadgeVariant(draft.status)}>
            {CONTENT_STATUS_LABELS[draft.status]}
          </Badge>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Preview + actions */}
        <div className="space-y-5">
          <DraftPreview type={type} body={draft.body} />

          {/* Content → graphic → post → queue, in the order the user works. */}
          <GraphicStudio
            draftId={draft.id}
            platform={platform}
            platformLabel={platformSpec(platform).label}
            defaultRatio={platformSpec(platform).defaultRatio}
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

          <Card>
            <CardContent className="p-4">
              <DraftActions
                draftId={draft.id}
                type={type}
                status={draft.status}
                bodyJson={JSON.stringify(draft.body, null, 2)}
                manualText={renderForManual(draft)}
                publishedUrl={draft.publishedUrl}
                canPublish={canPublish}
              />
            </CardContent>
          </Card>
        </div>

        {/* Metadata sidebar */}
        <aside className="space-y-4">
          <Card>
            <CardContent className="space-y-3 p-4 text-sm">
              <Row label="Type" value={CONTENT_TYPE_LABELS[type]} />
              <Row label="Status" value={CONTENT_STATUS_LABELS[draft.status]} />
              <Row label="Platform" value={platformSpec(platform).label} />
              <Row
                label="Graphic"
                value={media.length === 0 ? 'None attached' : `${media.length} attached`}
              />
              {sourceKind && (
                <Row label="Source" value={sourceKind.toLowerCase()} />
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
                {canAutoPublishTo(type, platform) ? (
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
