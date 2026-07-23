'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { PageHeader } from '@/components/dashboard/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { CONTENT_TYPES, type ContentTypeKey } from '@/lib/validations/content';
import { CONTENT_TYPE_LABELS } from '@/lib/content-ui';

/**
 * Trend hand-off from Sprint 2 ("Generate content from this"). Reads ?trendId,
 * lets the user pick a content type, then generates a draft grounded in that
 * trend and opens the editor.
 */
export default function NewFromSourcePage() {
  const router = useRouter();
  const params = useSearchParams();
  const trendId = params.get('trendId') ?? undefined;
  const [type, setType] = useState<ContentTypeKey>('LINKEDIN_POST');
  const [loading, setLoading] = useState(false);

  async function generate() {
    setLoading(true);
    try {
      const res = await fetch('/api/content/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          source: trendId
            ? { kind: 'TREND', ref: trendId }
            : { kind: 'BRIEF', brief: 'Timely content for our audience.' },
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Generation failed.');
        return;
      }
      const data = (await res.json()) as { id: string };
      toast.success('Draft generated from the trend.');
      router.push(`/dashboard/content/${data.id}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <Link
        href="/dashboard/trends"
        className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Trend Intelligence
      </Link>
      <PageHeader
        title="Generate content"
        description={trendId ? 'From the selected trend, in your brand voice.' : 'Pick a type to generate.'}
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Choose a format</CardTitle>
          <CardDescription>
            We&apos;ll ground it in your knowledge base and brand voice.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {CONTENT_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                aria-pressed={type === t}
                className={
                  'rounded-md border px-3 py-3 text-sm font-medium transition-colors ' +
                  (type === t
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border hover:bg-muted')
                }
              >
                {CONTENT_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
          <Label className="sr-only">Generate</Label>
          <Button onClick={generate} loading={loading} className="w-full">
            <Sparkles className="h-4 w-4" /> Generate draft
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
