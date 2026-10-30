'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, History, RotateCw, X } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import { PublishStateBadge } from '@/components/dashboard/websites/status-badges';
import type { BlogPublishState } from '@/lib/website-platforms';
import { safeExternalUrl } from '@/lib/safe-url';

export interface PublicationRow {
  id: string;
  draftId: string;
  draftTitle: string;
  websiteId: string;
  websiteName: string;
  platformName: string;
  state: BlogPublishState;
  mode: string;
  scheduledFor: string | null;
  publishedAt: string | null;
  externalUrl: string | null;
  errorMessage: string | null;
  attempts: number;
  viaSchedule: boolean;
  updatedAt: string;
  retryable: boolean;
  cancellable: boolean;
}

function when(p: PublicationRow): string {
  const at = p.state === 'scheduled' ? p.scheduledFor : p.state === 'published' ? p.publishedAt ?? p.updatedAt : p.updatedAt;
  return at ? new Date(at).toLocaleString() : '';
}

/** Retry / cancel one publication; returns the updated row, or null. */
export async function actOnPublication(id: string, action: 'retry' | 'cancel'): Promise<PublicationRow | null> {
  const res = await fetch(`/api/websites/publications/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  const body = (await res.json().catch(() => ({}))) as { publication?: PublicationRow; error?: string };
  if (!res.ok || !body.publication) {
    toast.error(body.error ?? 'That didn’t work.');
    return null;
  }
  const p = body.publication;
  if (action === 'cancel') toast.success('Scheduled publish cancelled.');
  else if (p.state === 'published') toast.success(`Published to ${p.websiteName}.`);
  else if (p.state === 'drafted') toast.success(`Saved as a draft on ${p.websiteName}.`);
  else toast.error(p.errorMessage ?? 'It failed again.');
  return p;
}

/** Every blog sent to a website: where, when, what happened, and Retry. */
export function PublishingHistory({ canAct }: { canAct: boolean }) {
  const [rows, setRows] = useState<PublicationRow[] | null>(null);
  const [site, setSite] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/websites/publications${site ? `?websiteId=${encodeURIComponent(site)}` : ''}`);
    if (r.ok) setRows(((await r.json()) as { publications: PublicationRow[] }).publications);
  }, [site]);
  useEffect(() => {
    void load();
  }, [load]);

  const sites = [...new Map((rows ?? []).map((r) => [r.websiteId, r.websiteName])).entries()];

  async function act(p: PublicationRow, action: 'retry' | 'cancel') {
    setBusy(p.id);
    await actOnPublication(p.id, action);
    setBusy(null);
    await load();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4 text-primary" /> Publishing history
        </CardTitle>
        <CardDescription>Every blog sent to a website. A retry updates the post already on the site — it never creates a second one.</CardDescription>
      </CardHeader>
      <CardContent>
        {sites.length > 1 && (
          <select aria-label="Filter by website" className="mb-3 h-9 rounded-md border border-input bg-background px-2 text-sm" value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="">All websites</option>
            {sites.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
        {!rows ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing published to a website yet. Open an approved blog in Content Studio to publish it.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Blog</th>
                  <th className="pb-2 font-medium">Website</th>
                  <th className="pb-2 font-medium">When</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((p) => {
                  const href = safeExternalUrl(p.externalUrl);
                  return (
                    <tr key={p.id} className="align-top">
                      <td className="py-2 pr-3">
                        <Link href={`/dashboard/content/${p.draftId}`} className="font-medium text-foreground hover:underline">
                          {p.draftTitle}
                        </Link>
                        {p.errorMessage && (p.state === 'failed' || p.state === 'cancelled') && <p className="mt-0.5 text-xs text-muted-foreground">{p.errorMessage}</p>}
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        {p.websiteName}
                        <span className="block text-muted-foreground">{p.platformName}</span>
                      </td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {when(p)}
                        {p.viaSchedule && <span className="block">auto-publish</span>}
                        {p.attempts > 1 && <span className="block">{p.attempts} attempts</span>}
                      </td>
                      <td className="py-2 pr-3">
                        <PublishStateBadge state={p.state} />
                      </td>
                      <td className="py-2 text-right">
                        <span className="inline-flex flex-wrap justify-end gap-1">
                          {href && (
                            <Button asChild size="sm" variant="ghost">
                              <a href={href} target="_blank" rel="noreferrer noopener">
                                View <ExternalLink className="h-3 w-3" />
                              </a>
                            </Button>
                          )}
                          {canAct && p.retryable && (
                            <Button size="sm" variant="outline" loading={busy === p.id} onClick={() => act(p, 'retry')}>
                              <RotateCw className="h-3.5 w-3.5" /> Retry
                            </Button>
                          )}
                          {canAct && p.cancellable && (
                            <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => act(p, 'cancel')}>
                              <X className="h-3.5 w-3.5" /> Cancel
                            </Button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
