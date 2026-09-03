'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Wand2, Save } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { TagInput } from '@/components/ui/tag-input';
import { toast } from '@/components/ui/toaster';
import type { BrandVoiceProfile } from '@/lib/validations/content';

const EMPTY: BrandVoiceProfile = {
  toneDescriptors: [],
  sentenceLength: 'varied',
  vocabulary: [],
  commonPhrases: [],
  topicsToAvoid: [],
  formatting: { emojiUsage: 'minimal', hashtagStyle: 'a few relevant hashtags', notes: '' },
  summary: '',
};

export function BrandVoiceCard({ initial }: { initial: BrandVoiceProfile | null }) {
  const router = useRouter();
  const [profile, setProfile] = useState<BrandVoiceProfile>(initial ?? EMPTY);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const exists = initial !== null;

  function set<K extends keyof BrandVoiceProfile>(k: K, v: BrandVoiceProfile[K]) {
    setProfile((p) => ({ ...p, [k]: v }));
  }

  async function regenerate() {
    setBusy('regen');
    try {
      const res = await fetch('/api/brand-voice', { method: 'POST' });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not analyze voice.');
        return;
      }
      const data = (await res.json()) as { profile: BrandVoiceProfile };
      setProfile(data.profile);
      setEditing(false);
      toast.success('Brand voice analyzed.');
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy('save');
    try {
      const res = await fetch('/api/brand-voice', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      });
      if (!res.ok) {
        toast.error('Could not save.');
        return;
      }
      toast.success('Brand voice saved.');
      setEditing(false);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> Brand voice
            </CardTitle>
            <CardDescription>
              AI-analyzed from your content. Every draft is written in this voice —
              review and edit it.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={regenerate} loading={busy === 'regen'}>
              <Wand2 className="h-4 w-4" /> {exists ? 'Re-analyze' : 'Analyze voice'}
            </Button>
            {exists && (
              <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)}>
                {editing ? 'Cancel' : 'Edit'}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!exists && !editing ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No brand voice profile yet. Add your business materials, then click
            &ldquo;Analyze voice&rdquo;.
          </p>
        ) : editing ? (
          <div className="space-y-4">
            <Field label="Tone descriptors">
              <TagInput value={profile.toneDescriptors} onChange={(v) => set('toneDescriptors', v)} placeholder="confident, warm…" />
            </Field>
            <Field label="Sentence length">
              <select
                value={profile.sentenceLength}
                onChange={(e) => set('sentenceLength', e.target.value as BrandVoiceProfile['sentenceLength'])}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {['short', 'medium', 'long', 'varied'].map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </Field>
            <Field label="Signature vocabulary">
              <TagInput value={profile.vocabulary} onChange={(v) => set('vocabulary', v)} placeholder="words you use" />
            </Field>
            <Field label="Common phrases">
              <TagInput value={profile.commonPhrases} onChange={(v) => set('commonPhrases', v)} placeholder="recurring phrases" />
            </Field>
            <Field label="Topics to avoid">
              <TagInput value={profile.topicsToAvoid} onChange={(v) => set('topicsToAvoid', v)} placeholder="off-brand topics" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Emoji usage">
                <Input
                  value={profile.formatting.emojiUsage}
                  onChange={(e) => set('formatting', { ...profile.formatting, emojiUsage: e.target.value })}
                />
              </Field>
              <Field label="Hashtag style">
                <Input
                  value={profile.formatting.hashtagStyle}
                  onChange={(e) => set('formatting', { ...profile.formatting, hashtagStyle: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Summary">
              <Textarea rows={3} value={profile.summary} onChange={(e) => set('summary', e.target.value)} />
            </Field>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            {profile.summary && <p className="text-foreground">{profile.summary}</p>}
            {profile.toneDescriptors.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {profile.toneDescriptors.map((t) => (
                  <Badge key={t} variant="secondary">{t}</Badge>
                ))}
              </div>
            )}
            <dl className="grid gap-2 sm:grid-cols-2">
              <Meta label="Sentence length" value={profile.sentenceLength} />
              <Meta label="Emoji" value={profile.formatting.emojiUsage} />
              <Meta label="Hashtags" value={profile.formatting.hashtagStyle} />
              {profile.vocabulary.length > 0 && (
                <Meta label="Vocabulary" value={profile.vocabulary.join(', ')} />
              )}
              {profile.topicsToAvoid.length > 0 && (
                <Meta label="Avoid" value={profile.topicsToAvoid.join(', ')} />
              )}
            </dl>
          </div>
        )}
      </CardContent>

      {editing && (
        <CardFooter className="justify-end">
          <Button onClick={save} loading={busy === 'save'}>
            <Save className="h-4 w-4" /> Save voice
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
