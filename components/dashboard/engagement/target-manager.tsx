'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, Linkedin } from 'lucide-react';
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

export interface TargetRow {
  id: string;
  label: string;
  profileUrl: string;
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

  async function add() {
    if (!label.trim() || !url.trim()) {
      toast.error('Add a label and a profile URL.');
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
      toast.success('Target added.');
      setLabel('');
      setUrl('');
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
        <CardTitle>Monitored profiles &amp; pages</CardTitle>
        <CardDescription>
          Public figures/pages you want to engage with. When you browse LinkedIn,
          the extension offers to draft a comment on their posts that are already
          visible on your screen — nothing is fetched server-side.
        </CardDescription>
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
            </div>
            <Button onClick={add} loading={saving}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
        )}

        {targets.length === 0 ? (
          <p className="text-sm text-muted-foreground">No monitored profiles yet.</p>
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
