import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { listProfiles, listRuns } from '@/server/leads/profile.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  DiscoveryManager,
  type DiscoveryProfileRow,
} from '@/components/dashboard/leads/discovery-manager';

export const metadata: Metadata = { title: 'Discover leads' };
export const dynamic = 'force-dynamic';

export default async function DiscoverPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, profiles, runs] = await Promise.all([
    getMembership(user.id, active.id),
    listProfiles(active.id),
    listRuns(active.id),
  ]);
  const canManage = membership ? can(membership.role, 'content:approve') : false;

  const rows: DiscoveryProfileRow[] = profiles.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    criteria: p.criteria as DiscoveryProfileRow['criteria'],
    autoRun: p.autoRun,
    isActive: p.isActive,
    lastRunAt: p.lastRunAt ? p.lastRunAt.toISOString() : null,
    leadCount: p._count.leads,
    runCount: p._count.runs,
  }));

  return (
    <div>
      <PageHeader
        title="Discover leads"
        description="Define who you want to reach; discovery searches legitimate public sources to build a qualified, AI-scored list."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/leads">
              <ArrowLeft className="h-4 w-4" /> All leads
            </Link>
          </Button>
        }
      />

      <DiscoveryManager profiles={rows} canManage={canManage} />

      {runs.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
            Recent runs
          </h2>
          <div className="space-y-2">
            {runs.map((r) => (
              <Card key={r.id}>
                <CardContent className="flex items-center justify-between p-3 text-sm">
                  <div>
                    <span className="font-medium">{r.profile.name}</span>
                    <Badge variant="outline" className="ml-2">
                      {r.profile.category ?? r.profile.name}
                    </Badge>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {new Date(r.startedAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground">
                      {r.leadsCreated} new · {r.leadsFound} found
                    </span>
                    <Badge
                      variant={
                        r.status === 'COMPLETED'
                          ? 'success'
                          : r.status === 'FAILED'
                            ? 'destructive'
                            : 'warning'
                      }
                    >
                      {r.status}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
