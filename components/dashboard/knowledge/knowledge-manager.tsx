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
import {
  MATERIAL_CATEGORIES,
  guessCategory,
  materialCategory,
} from '@/lib/materials';
import type { MaterialCategory } from '@prisma/client';
import { cn } from '@/lib/utils';

export interface KnowledgeSourceView {
  id: string;
  type: string;
  label: string;
  status: string;
  lastSyncedAt: string | null;
  category: MaterialCategory | null;
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
  uploads: Array<{
    filename: string;
    chunkCount: number;
    category: MaterialCategory | null;
  }>;
  totalChunks: number;
  hasWebsite: boolean;
}) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [uploading, setUploading] = useState(false);
  /** The chosen file, held while the user confirms what kind of material it is. */
  const [pending, setPending] = useState<{ file: File; category: MaterialCategory } | null>(null);
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

  /**
   * Picking a file opens the "what is this?" step rather than uploading
   * straight away.
   *
   * Asking AFTER the file is chosen means the question can name the actual
   * document and pre-select an answer from its filename — far easier than
   * choosing a category from an empty dropdown before you have picked
   * anything. Nothing is sent until the user confirms.
   */
  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPending({ file, category: guessCategory(file.name) });
  }

  async function confirmUpload() {
    if (!pending) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', pending.file);
      form.append('category', pending.category);
      const res = await fetch('/api/knowledge/upload', { method: 'POST', body: form });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Upload failed.');
        return;
      }
      const data = (await res.json()) as { chunks: number };
      const label = materialCategory(pending.category)?.label ?? 'Document';
      toast.success(`${label} added — Aura has read ${data.chunks} sections.`);
      setPending(null);
      router.refresh();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function cancelUpload() {
    setPending(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Your documents</CardTitle>
            <CardDescription>
              {totalChunks} sections of text Aura can draw on when it writes.
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
              accept=".pdf,.docx,.pptx,.txt,.md,.markdown"
              onChange={onPick}
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

        {/*
          What kind of document is this? Asked once, per upload, because the
          answer changes how the material is used: guidelines become rules to
          follow, competitor material becomes context to position against and
          must never be echoed as our own claim. A single "documents" pile
          cannot express either.
        */}
        {pending && (
          <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
            <div>
              <p className="text-sm font-medium text-foreground">
                What kind of document is{' '}
                <span className="font-semibold">{pending.file.name}</span>?
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                This decides how Aura uses it. You can pick a different kind if
                our guess is wrong.
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {MATERIAL_CATEGORIES.map((c) => {
                const selected = pending.category === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setPending({ ...pending, category: c.id })}
                    className={cn(
                      'rounded-md border p-2.5 text-left transition-colors',
                      selected
                        ? 'border-primary bg-primary/10'
                        : 'border-border hover:bg-muted',
                    )}
                  >
                    <p
                      className={cn(
                        'text-sm font-medium',
                        selected ? 'text-primary' : 'text-foreground',
                      )}
                    >
                      {c.label}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{c.examples}</p>
                  </button>
                );
              })}
            </div>

            {/* What they get for choosing correctly, for the current choice. */}
            <p className="rounded-md bg-background/60 px-3 py-2 text-xs text-muted-foreground">
              {materialCategory(pending.category)?.helps}
            </p>

            <div className="flex flex-wrap gap-2">
              <Button onClick={confirmUpload} loading={uploading}>
                <Upload className="h-4 w-4" /> Add this material
              </Button>
              <Button variant="ghost" onClick={cancelUpload} disabled={uploading}>
                Cancel
              </Button>
            </div>
          </div>
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
                      {s.status === 'SYNCED' && s.chunkCount === 0 && (
                        <p className="mt-0.5 text-xs [color:hsl(var(--warning))]">
                          No readable text found — this site likely renders content
                          with JavaScript. Try uploading a doc or adding your blog RSS.
                        </p>
                      )}
                    </div>
                  </div>
                  {s.status === 'ERROR' ? (
                    <Badge variant="destructive">
                      <AlertTriangle className="h-3 w-3" /> Error
                    </Badge>
                  ) : s.status === 'SYNCED' && s.chunkCount === 0 ? (
                    <Badge variant="warning">
                      <AlertTriangle className="h-3 w-3" /> No text
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
            {uploads.map((u) => {
              const kind = materialCategory(u.category);
              return (
                <li key={u.filename} className="flex items-center justify-between gap-2 py-2.5">
                  <div className="flex items-center gap-3">
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {u.filename}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {u.chunkCount} chunks
                        {kind ? ` · ${kind.helps}` : ''}
                      </p>
                    </div>
                  </div>
                  {/* The kind of material, not "Upload" — which said only that
                      a file had been chosen, and never what it was for. */}
                  <Badge variant={kind ? 'secondary' : 'muted'} className="shrink-0">
                    {kind?.label ?? 'Uncategorised'}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
