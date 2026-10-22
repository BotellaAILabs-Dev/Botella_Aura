'use client';

import { useState } from 'react';
import { Contact } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { detailProblem, type BusinessFacts, type DetailKey } from '@/lib/post-details';

/**
 * Business details for posts: the address, phone and email a post may carry
 * (lib/post-details.ts). Saved once here, they can be added to any post as
 * already-approved details. Aura never writes them into copy on its own.
 */
export function ContactFactsCard({ initial, canEdit }: { initial: BusinessFacts; canEdit: boolean }) {
  const [form, setForm] = useState({ address: initial.address ?? '', phone: initial.phone ?? '', contactEmail: initial.email ?? '' });
  const [saved, setSaved] = useState(form);
  const [busy, setBusy] = useState(false);

  const fields: { key: keyof typeof form; detail: DetailKey; label: string; type: string }[] = [
    { key: 'address', detail: 'address', label: 'Business address', type: 'text' },
    { key: 'phone', detail: 'phone', label: 'Phone', type: 'tel' },
    { key: 'contactEmail', detail: 'email', label: 'Contact email', type: 'email' },
  ];
  const problems = Object.fromEntries(fields.map((f) => [f.key, form[f.key].trim() ? detailProblem(f.detail, form[f.key]) : null]));
  const dirty = fields.some((f) => form[f.key] !== saved[f.key]);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch('/api/company/contact', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: form.address.trim() || null,
          phone: form.phone.trim() || null,
          contactEmail: form.contactEmail.trim() || null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not save the business details.');
        return;
      }
      setSaved(form);
      toast.success('Business details saved. They can now be added to any post.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="mb-1 flex items-center gap-2">
          <Contact className="h-4 w-4 text-primary" aria-hidden />
          <CardTitle className="text-base">Business details for posts</CardTitle>
        </div>
        <CardDescription>
          Your address, phone and email, ready to add to a post with one click. Aura never adds them to a post by itself or
          makes them up. Your website is set under About my business{initial.website ? ` (${initial.website})` : ''}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {fields.map((f) => (
          <div key={f.key} className="space-y-1.5">
            <Label htmlFor={`contact-${f.key}`}>{f.label}</Label>
            <Input
              id={`contact-${f.key}`}
              type={f.type}
              value={form[f.key]}
              disabled={!canEdit}
              maxLength={300}
              aria-invalid={Boolean(problems[f.key])}
              onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
            />
            {problems[f.key] && <p className="text-xs text-destructive">{problems[f.key]}</p>}
          </div>
        ))}
        {canEdit ? (
          <Button onClick={save} loading={busy} disabled={!dirty || busy || Object.values(problems).some(Boolean)}>
            Save business details
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">Only owners and admins can change these.</p>
        )}
      </CardContent>
    </Card>
  );
}
