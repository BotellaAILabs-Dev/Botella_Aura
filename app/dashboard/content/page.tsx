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

export const metadata: Metadata = { title: 'Content Studio' };

export default async function ContentPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [drafts, enabledTypes] = await Promise.all([
    listDrafts(active.id),
    getEnabledContentTypes(active.id),
  ]);
  const cards: DraftCard[] = drafts.map((d) => {
    const meta = (d.aiMetadata ?? {}) as { source?: { kind?: string } };
    const type = d.type as ContentTypeKey;
    const platform = resolvePlatform(type, d.platform);
    return {
      id: d.id,
      type,
      status: d.status,
      title: d.title,
      snippet: draftSnippet(type, d.body),
      sourceKind: meta.source?.kind ?? null,
      campaignName: d.campaign?.name ?? null,
      scheduledFor: d.scheduledFor ? d.scheduledFor.toISOString() : null,
      updatedAt: d.updatedAt.toISOString(),
      platformLabel: platformSpec(platform).label,
      // Counted in the same query as the drafts (see listDrafts) rather than
      // one lookup per card — this board routinely renders dozens of rows.
      mediaCount: d._count.media,
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
            <CreateContentDialog types={enabledTypes} />
          </div>
        }
      />

      {cards.length === 0 ? (
        <EmptyState
          icon={PenLine}
          title="No content yet"
          description="Generate your first draft from a brief or a trend. It lands here in Draft, and nothing publishes until you approve it."
          action={<CreateContentDialog types={enabledTypes} />}
        />
      ) : (
        <QueueBoard drafts={cards} />
      )}
    </div>
  );
}
