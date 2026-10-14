import Link from 'next/link';
import type { Metadata } from 'next';
import { CalendarDays, BookOpen } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { listDrafts } from '@/server/content/content.service';
import { draftSnippet } from '@/lib/content-ui';
import { resolvePlatform, platformSpec } from '@/lib/platforms';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PenLine } from 'lucide-react';
import { CreateContentDialog } from '@/components/dashboard/content/create-content-dialog';
import { getEnabledContentTypes } from '@/server/company/profile.service';
import { QueueBoard, type DraftCard } from '@/components/dashboard/content/queue-board';
import type { ContentTypeKey } from '@/lib/validations/content';
import { isReviewCurrent, type ContentReview } from '@/lib/content-review';
import { getPolicyContext } from '@/server/content/compliance.service';
import { listRecommendations } from '@/server/recommendations/recommendation.service';
import { routeFor } from '@/lib/aura-modules';
import { draftContext } from '@/lib/draft-context';

export const metadata: Metadata = { title: 'Content Studio' };

export default async function ContentPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [drafts, enabledTypes, policy, recommendations] = await Promise.all([
    listDrafts(active.id),
    getEnabledContentTypes(active.id),
    getPolicyContext(active.id),
    // Suggestions already said yes to that Content Studio carries out, so
    // the create dialog can start from one (the ?rec= workflow).
    listRecommendations(active.id, {
      status: ['ACCEPTED', 'EDITED', 'IN_PROGRESS'],
      limit: 20,
    }),
  ]);
  const suggestions = recommendations
    .filter((r) => routeFor(r).primary === 'content-studio')
    .map((r) => ({ id: r.id, title: r.title }));
  const cards: DraftCard[] = drafts.map((d) => {
    const meta = (d.aiMetadata ?? {}) as {
      source?: { kind?: string };
      review?: ContentReview;
    };
    // The AI Reviewer's verdict, only while it is of the body as it stands.
    const review = isReviewCurrent(meta.review, d.body, policy.hash) ? meta.review! : null;
    const type = d.type as ContentTypeKey;
    const platform = resolvePlatform(type, d.platform);
    const rec = draftContext(d.aiMetadata);
    return {
      id: d.id,
      type,
      status: d.status,
      title: d.title,
      snippet: draftSnippet(type, d.body),
      sourceKind: meta.source?.kind ?? null,
      recommendationTitle: rec.fromRecommendation
        ? (rec.title ?? 'Aura’s suggestion')
        : null,
      campaignName: d.campaign?.name ?? null,
      scheduledFor: d.scheduledFor ? d.scheduledFor.toISOString() : null,
      updatedAt: d.updatedAt.toISOString(),
      platformLabel: platformSpec(platform).label,
      // Counted in the same query as the drafts (see listDrafts) rather than
      // one lookup per card — this board routinely renders dozens of rows.
      mediaCount: d._count.media,
      review: review ? review.status : null,
    };
  });

  return (
    <div>
      <PageHeader
        title="Content Studio"
        description="AI drafts on-brand content. You approve before anything publishes."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard/content/calendar">
                <CalendarDays className="h-4 w-4" /> Calendar
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard/settings/knowledge-base">
                <BookOpen className="h-4 w-4" /> Knowledge base
              </Link>
            </Button>
            <CreateContentDialog
              types={enabledTypes}
              suggestions={suggestions}
            />
          </div>
        }
      />

      {cards.length === 0 ? (
        <EmptyState
          icon={PenLine}
          title="No content yet"
          description="Generate your first draft from a brief or a trend. It lands here in Draft, and nothing publishes until you approve it."
          action={
            <CreateContentDialog
              types={enabledTypes}
              suggestions={suggestions}
            />
          }
        />
      ) : (
        <QueueBoard drafts={cards} />
      )}
    </div>
  );
}
