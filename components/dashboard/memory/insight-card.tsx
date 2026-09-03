'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Brain,
  LayoutTemplate,
  Clock,
  Hash,
  MessageSquare,
  Info,
  Pencil,
  X,
} from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toaster';

export interface InsightCardData {
  id: string;
  insightType: string;
  insight: string;
  confidence: string;
  sampleSize: number;
  basis?: string;
  editedByUser?: boolean;
}

const CATEGORY_ICON: Record<string, typeof Brain> = {
  CONTENT_FORMAT: LayoutTemplate,
  CONTENT_LENGTH: MessageSquare,
  TIMING: Clock,
  TOPIC: Hash,
  HASHTAG: Hash,
  OUTREACH_APPROACH: MessageSquare,
  OTHER: Info,
};

function confidenceVariant(c: string): BadgeProps['variant'] {
  if (c === 'HIGH') return 'success';
  if (c === 'MEDIUM') return 'warning';
  return 'muted';
}

/**
 * A single learned insight — with controls to correct its wording or dismiss it.
 * What Aura learned belongs to the user: if a pattern is wrong, they fix it here
 * and it stops (or starts) shaping future drafts accordingly.
 */
export function InsightCard({ memory }: { memory: InsightCardData }) {
  const router = useRouter();
  const Icon = CATEGORY_ICON[memory.insightType] ?? Brain;

  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.insight);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/memory/${memory.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ insight: text }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not save the correction.');
        return;
      }
      toast.success('Insight updated.');
      setEditing(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    if (!confirm('Dismiss this insight? It will stop shaping future drafts.'))
      return;
    setBusy(true);
    try {
      const res = await fetch(`/api/memory/${memory.id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error('Could not dismiss the insight.');
        return;
      }
      toast.success('Insight dismissed.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
            <Icon className="h-4 w-4" /> {memory.insightType.replace(/_/g, ' ')}
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <Badge variant={confidenceVariant(memory.confidence)}>
              {memory.confidence} confidence
            </Badge>
            {!editing && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Correct this insight"
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Dismiss this insight"
                  loading={busy}
                  onClick={dismiss}
                >
                  <X className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {editing ? (
          <div className="space-y-2">
            <Textarea
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={save} loading={busy}>
                Save correction
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setText(memory.insight);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm font-medium text-foreground">{memory.insight}</p>
            <p className="text-xs text-muted-foreground">
              Based on {memory.sampleSize} posts
              {memory.basis ? ` · ${memory.basis}` : ''}
              {memory.editedByUser ? ' · edited by you' : ''}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
