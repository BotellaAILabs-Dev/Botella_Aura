'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Upload, Globe, Rss, FileText, CheckCircle2, AlertTriangle } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toaster';

export interface KnowledgeSourceView {
  id: string;
  type: string;
  label: string;
  status: string;
  lastSyncedAt: string | null;
  error: string | null;
  chunkCount: number;
}

const ICON: Record<string, typeof Globe> = {
  WEBSITE: Globe,
  BLOG: Rss,
  UPLOAD: FileText,
};

export function KnowledgeManager({
  sources,
  uploads,
  totalChunks,
  hasWebsite,
}: {
  sources: KnowledgeSourceView[];
  uploads: Array<{ filename: string; chunkCount: number }>;
  totalChunks: number;
  hasWebsite: boolean;
}) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function resync() {
    setSyncing(true);
    try {
      const res = await fetch('/api/knowledge/sync', { method: 'POST' });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Sync failed.');
        return;
      }
      const data = (await res.json()) as { chunks: number };
      toast.success(`Synced — ${data.chunks} chunks ingested.`);
      router.refresh();
    } finally {
      setSyncing(false);
    }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/knowledge/upload', { method: 'POST', body: form });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Upload failed.');
        return;
      }
      const data = (await res.json()) as { chunks: number };
      toast.success(`Uploaded — ${data.chunks} chunks added.`);
      router.refresh();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Knowledge base</CardTitle>
            <CardDescription>
              {totalChunks} chunks — what Aura reads to write in your voice.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={resync} loading={syncing} disabled={!hasWebsite}>
              <RefreshCw className="h-4 w-4" /> Re-sync website
            </Button>
            <Button onClick={() => fileRef.current?.click()} loading={uploading}>
              <Upload className="h-4 w-4" /> Upload document
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.markdown,.pdf"
              onChange={onUpload}
              className="hidden"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hasWebsite && (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Add a company website in Settings to enable website ingestion.
          </p>
        )}

        {sources.length === 0 && uploads.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No sources yet. Re-sync your website or upload a document to get started.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {sources.map((s) => {
              const Icon = ICON[s.type] ?? FileText;
              return (
                <li key={s.id} className="flex items-center justify-between py-2.5">
                  <div className="flex items-center gap-3">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{s.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.chunkCount} chunks
                        {s.lastSyncedAt &&
                          ` · synced ${new Date(s.lastSyncedAt).toLocaleString()}`}
                      </p>
                    </div>
                  </div>
                  {s.status === 'ERROR' ? (
                    <Badge variant="destructive">
                      <AlertTriangle className="h-3 w-3" /> Error
                    </Badge>
                  ) : s.status === 'SYNCED' ? (
                    <Badge variant="success">
                      <CheckCircle2 className="h-3 w-3" /> Synced
                    </Badge>
                  ) : (
                    <Badge variant="muted">{s.status}</Badge>
                  )}
                </li>
              );
            })}
            {uploads.map((u) => (
              <li key={u.filename} className="flex items-center justify-between py-2.5">
                <div className="flex items-center gap-3">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium text-foreground">{u.filename}</p>
                    <p className="text-xs text-muted-foreground">{u.chunkCount} chunks</p>
                  </div>
                </div>
                <Badge variant="muted">Upload</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
