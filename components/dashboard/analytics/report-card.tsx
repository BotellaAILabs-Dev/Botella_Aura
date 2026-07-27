'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Copy, Check, RefreshCw } from 'lucide-react';
import { toast } from '@/components/ui/toaster';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/** Weekly written report — generate + copy to forward to a boss/investor. */
export function ReportCard({
  summary,
  generatedAt,
  canManage,
}: {
  summary: string | null;
  generatedAt: string | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      const res = await fetch('/api/analytics/report', { method: 'POST' });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not generate the report.');
        return;
      }
      toast.success('Weekly report generated.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!summary) return;
    await navigator.clipboard.writeText(summary);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4 text-primary" /> Weekly report
            </CardTitle>
            <CardDescription>
              {generatedAt
                ? `Generated ${new Date(generatedAt).toLocaleString()}`
                : 'A shareable written summary of your results.'}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {summary && (
              <Button variant="outline" size="sm" onClick={copy}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
            {canManage && (
              <Button size="sm" onClick={generate} loading={busy}>
                <RefreshCw className="h-4 w-4" /> Generate
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {summary ? (
          <p className="whitespace-pre-wrap text-sm text-foreground">{summary}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No report yet. Generate one to get a forward-ready weekly summary.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
