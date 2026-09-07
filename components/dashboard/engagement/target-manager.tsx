'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, Linkedin, CheckCircle2 } from 'lucide-react';
import { toast } from '@/components/ui/toaster';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { classifyLinkedInUrl } from '@/lib/linkedin-url';
import { LocalTime } from '@/components/ui/local-time';

export interface TargetRow {
  id: string;
  label: string;
  profileUrl: string;
  /** ISO timestamp - proves persistence at a glance. */
  addedAt?: string;
}

export function TargetManager({
  targets,
  canManage,
}: {
  targets: TargetRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);

  const info = url.trim() ? classifyLinkedInUrl(url) : null;

  async function add() {
    if (!label.trim() || !url.trim()) {
      toast.error('Add a label and a profile URL.');
      return;
    }
    const check = classifyLinkedInUrl(url);
    if (!check.valid) {
      toast.error(
        'Enter a valid LinkedIn profile (linkedin.com/in/…) or company page (linkedin.com/company/…).',
      );
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/engagement/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, profileUrl: url }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not add target.');
        return;
      }
      toast.success(`Saved - ${label.trim()} is now monitored.`);
      setLabel('');
      setUrl('');
      // Re-fetch the server list so what is on screen is what is stored.
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    const res = await fetch(`/api/engagement/targets/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Could not remove target.');
      return;
    }
    toast.success('Target removed.');
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Monitored profiles &amp; pages</CardTitle>
            <CardDescription>
              Public figures/pages you want to engage with. When you browse
              LinkedIn, the extension offers to draft a comment on their posts that
              are already visible on your screen — nothing is fetched server-side.
            </CardDescription>
          </div>
          {targets.length > 0 && (
            <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              {targets.length} saved to your workspace
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {canManage && (
          <div className="grid gap-2 sm:grid-cols-[1fr_1.5fr_auto]">
            <div className="space-y-1.5">
              <Label className="sr-only">Label</Label>
              <Input
                placeholder="Label (e.g. Jane, industry voice)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="sr-only">Profile URL</Label>
              <Input
                placeholder="linkedin.com/in/… or /company/…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              {info && (
                <p className="text-xs text-muted-foreground">
                  {info.valid ? (
                    <span className="text-primary">
                      ✓ {info.kind === 'person' ? 'Personal profile' : 'Company / organization page'}
                    </span>
                  ) : (
                    <span>Enter a LinkedIn /in/ profile or /company/ page URL.</span>
                  )}
                </p>
              )}
            </div>
            <Button onClick={add} loading={saving}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
        )}

        {/* Examples of good engagement targets. */}
        {canManage && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Good targets:</span>{' '}
            industry thought leaders, prospective customers, partners, or a
            competitor&apos;s company page — people/pages whose posts your audience
            already reads.
          </p>
        )}

        {targets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No monitored profiles yet. Anything you add here is stored on your
            workspace and stays until you remove it.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {targets.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
              >
                <div className="flex items-center gap-2">
                  <Linkedin className="h-4 w-4 text-[#0A66C2]" />
                  <div>
                    <p className="text-sm font-medium">{t.label}</p>
                    <a
                      href={t.profileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-muted-foreground hover:text-primary hover:underline"
                    >
                      {t.profileUrl}
                    </a>
                    {t.addedAt && (
                      <p className="text-xs text-muted-foreground">
                        Added <LocalTime iso={t.addedAt} kind="date" />
                      </p>
                    )}
                  </div>
                </div>
                {canManage && (
                  <Button variant="ghost" size="icon" onClick={() => remove(t.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
