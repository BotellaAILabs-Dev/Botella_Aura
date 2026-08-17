'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { toast } from '@/components/ui/toaster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { classifyLinkedInUrl } from '@/lib/linkedin-url';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

export function CreateLeadDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    companyName: '',
    name: '',
    title: '',
    linkedInProfileUrl: '',
  });

  const urlInfo = form.linkedInProfileUrl.trim()
    ? classifyLinkedInUrl(form.linkedInProfileUrl)
    : null;

  async function save() {
    if (form.companyName.trim().length < 1) {
      toast.error('Company name is required.');
      return;
    }
    if (form.linkedInProfileUrl.trim() && !classifyLinkedInUrl(form.linkedInProfileUrl).valid) {
      toast.error('Enter a valid LinkedIn /in/ profile or /company/ page URL, or leave it blank.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/outreach/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not add lead.');
        return;
      }
      toast.success('Lead added.');
      setForm({ companyName: '', name: '', title: '', linkedInProfileUrl: '' });
      setOpen(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="h-4 w-4" /> Add lead
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a lead manually</DialogTitle>
          <DialogDescription>
            You confirm the person and their public profile — nothing is scraped.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Company *</Label>
            <Input
              value={form.companyName}
              onChange={(e) => setForm({ ...form, companyName: e.target.value })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Person</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>LinkedIn profile URL</Label>
            <Input
              value={form.linkedInProfileUrl}
              onChange={(e) => setForm({ ...form, linkedInProfileUrl: e.target.value })}
              placeholder="linkedin.com/in/…"
            />
            {urlInfo && (
              <p className="text-xs text-muted-foreground">
                {urlInfo.valid ? (
                  <span className="text-primary">
                    ✓ {urlInfo.kind === 'person' ? 'Personal profile' : 'Company page'}
                    {urlInfo.kind === 'company'
                      ? ' — tip: a person profile (/in/) personalizes outreach best.'
                      : ''}
                  </span>
                ) : (
                  <span>Not a valid LinkedIn profile/company URL.</span>
                )}
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Add lead
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
