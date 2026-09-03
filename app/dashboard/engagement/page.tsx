import Link from 'next/link';
import type { Metadata } from 'next';
import { MessageCircle, Settings2, ExternalLink, ShieldCheck } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { listComments } from '@/server/engagement/comment.service';
import { listTargets } from '@/server/engagement/target.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  TargetManager,
  type TargetRow,
} from '@/components/dashboard/engagement/target-manager';

export const metadata: Metadata = { title: 'Engagement' };
// Targets are added from this page; never render a cached list.
export const dynamic = 'force-dynamic';

function statusVariant(status: string): BadgeProps['variant'] {
  if (status === 'POSTED') return 'success';
  if (status === 'DISCARDED') return 'muted';
  return 'warning'; // DRAFT
}

export default async function EngagementPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, comments, targets] = await Promise.all([
    getMembership(user.id, active.id),
    listComments(active.id),
    listTargets(active.id),
  ]);
  const canManage = membership ? can(membership.role, 'company:update') : false;

  const targetRows: TargetRow[] = targets.map((t) => ({
    id: t.id,
    label: t.label,
    profileUrl: t.profileUrl,
    addedAt: t.createdAt.toISOString(),
  }));

  const actions = (
    <Button asChild variant="ghost" size="sm">
      <Link href="/dashboard/settings/engagement">
        <Settings2 className="h-4 w-4" /> Target settings
      </Link>
    </Button>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Engagement Copilot"
        description="AI-drafted comments for posts you're already viewing — drafted and posted from the extension."
        actions={actions}
      />

      <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          The drafting happens in the{' '}
          <span className="font-medium text-foreground">extension</span>, on posts
          already visible on your screen — Aura never fetches LinkedIn feeds.
          The comment history below is the read-only record of what you&apos;ve
          drafted and posted.
        </p>
      </div>

      {/*
        Targets are shown and managed here, not only behind a settings link.
        Previously this page only mentioned a count in a paragraph, so saved
        targets looked like they had vanished on the next visit — the "targets
        are not persisting" report. They are stored server-side and listed here.
      */}
      <TargetManager targets={targetRows} canManage={canManage} />

      <div>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
          Drafted &amp; posted comments
        </h2>
        {comments.length === 0 ? (
          <EmptyState
            icon={MessageCircle}
            title="No comments yet"
            description={
              targets.length > 0
                ? `You're monitoring ${targets.length} profile${targets.length === 1 ? '' : 's'} (listed above). Browse LinkedIn with the extension installed — when one of them posts, the extension offers to draft an on-brand comment, and every draft appears here.`
                : 'Add a profile to monitor above, then browse LinkedIn — the extension will offer to draft a thoughtful, on-brand comment on their posts you are viewing.'
            }
            // Both paths through this screen depend on the browser extension,
            // and the copy said so without offering a way to get it. Whichever
            // branch the reader is on, installing it is the next step.
            action={
              <Button asChild variant="outline">
                <Link href="/dashboard/settings/extension">
                  <Settings2 className="h-4 w-4" /> Set up the browser extension
                </Link>
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {comments.map((c) => (
              <Card key={c.id}>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {c.targetAuthor ? `On ${c.targetAuthor}'s post` : 'On a post'}
                    </span>
                    <div className="flex items-center gap-2">
                      <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                      <a
                        href={c.targetPostUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted-foreground hover:text-primary"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </div>
                  </div>
                  {c.postExcerpt && (
                    <p className="line-clamp-2 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
                      {c.postExcerpt}
                    </p>
                  )}
                  <p className="whitespace-pre-wrap text-sm">{c.draftText}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.postedAt
                      ? `Posted ${new Date(c.postedAt).toLocaleString()}`
                      : `Drafted ${new Date(c.createdAt).toLocaleString()}`}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
