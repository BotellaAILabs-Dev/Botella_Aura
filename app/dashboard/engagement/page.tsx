import Link from 'next/link';
import type { Metadata } from 'next';
import { MessageCircle, Settings2, ExternalLink, ShieldCheck } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { listComments } from '@/server/engagement/comment.service';
import { listTargets } from '@/server/engagement/target.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Engagement' };

function statusVariant(status: string): BadgeProps['variant'] {
  if (status === 'POSTED') return 'success';
  if (status === 'DISCARDED') return 'muted';
  return 'warning'; // DRAFT
}

export default async function EngagementPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [comments, targets] = await Promise.all([
    listComments(active.id),
    listTargets(active.id),
  ]);

  const actions = (
    <Button asChild variant="ghost" size="sm">
      <Link href="/dashboard/settings/engagement">
        <Settings2 className="h-4 w-4" /> Targets
      </Link>
    </Button>
  );

  return (
    <div>
      <PageHeader
        title="Engagement Copilot"
        description="AI-drafted comments for posts you're already viewing — drafted and posted from the extension."
        actions={actions}
      />

      <div className="mb-5 flex items-start gap-2 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          The drafting happens in the{' '}
          <span className="font-medium text-foreground">extension</span>, on posts
          already visible on your screen — Aura never fetches LinkedIn feeds.
          This page is the read-only record of what you&apos;ve drafted and posted.
          {targets.length > 0 && ` Monitoring ${targets.length} profile(s).`}
        </p>
      </div>

      {comments.length === 0 ? (
        <EmptyState
          icon={MessageCircle}
          title="No comments yet"
          description="Add profiles to monitor in settings, then browse LinkedIn — the extension will offer to draft a thoughtful, on-brand comment on their posts you're viewing."
          action={
            <Button asChild variant="outline">
              <Link href="/dashboard/settings/engagement">Add targets</Link>
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
  );
}
