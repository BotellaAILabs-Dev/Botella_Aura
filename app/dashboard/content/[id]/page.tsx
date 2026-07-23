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
import { canAutoPublish } from '@/server/content/publish.service';
import { CONTENT_TYPE_LABELS, CONTENT_STATUS_LABELS } from '@/lib/content-ui';
import { PageHeader } from '@/components/dashboard/page-header';
import { Badge, statusBadgeVariant } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { DraftPreview } from '@/components/dashboard/content/draft-preview';
import { DraftActions } from '@/components/dashboard/content/draft-actions';
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
  const type = draft.type as ContentTypeKey;
  const meta = (draft.aiMetadata ?? {}) as {
    source?: { kind?: string; brief?: string | null };
  };
  const sourceKind = meta.source?.kind;

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
                {canAutoPublish(type) ? (
                  <>
                    LinkedIn posts auto-publish to a connected Company Page{' '}
                    <span className="font-medium text-foreground">
                      once LinkedIn Community Management API access is approved
                    </span>
                    . Until then, use “Copy for manual posting”.
                  </>
                ) : (
                  <>
                    This content type isn&apos;t natively publishable via
                    LinkedIn&apos;s API — use{' '}
                    <span className="font-medium text-foreground">
                      “Copy for manual posting”
                    </span>{' '}
                    and paste it into LinkedIn / X.
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
