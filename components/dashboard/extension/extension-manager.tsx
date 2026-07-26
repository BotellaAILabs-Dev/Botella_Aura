'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Puzzle,
  Copy,
  Check,
  Send,
  Trash2,
  ShieldCheck,
  KeyRound,
} from 'lucide-react';
import { toast } from '@/components/ui/toaster';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export interface ExtensionTokenRow {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/**
 * Extension pairing + token management. The raw token is shown exactly once,
 * with a "Send to extension" button that uses window.postMessage — the
 * extension's content script (injected on this origin) forwards it into
 * chrome.storage. A copy/paste fallback is always available.
 */
export function ExtensionManager({
  tokens,
  canManage,
}: {
  tokens: ExtensionTokenRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [newToken, setNewToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      const res = await fetch('/api/extension/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Browser extension' }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not generate a token.');
        return;
      }
      const data = (await res.json()) as { token: string };
      setNewToken(data.token);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!newToken) return;
    await navigator.clipboard.writeText(newToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function sendToExtension() {
    if (!newToken) return;
    // The extension's content script on this origin listens for this message.
    window.postMessage(
      { source: 'botella-aura', type: 'AURA_EXT_TOKEN', token: newToken },
      window.location.origin,
    );
    toast.success('Sent to the extension (if installed). Check the popup.');
  }

  async function revoke(id: string) {
    if (!confirm('Disconnect this extension? It will stop working immediately.'))
      return;
    const res = await fetch(`/api/extension/token/${id}/revoke`, {
      method: 'POST',
    });
    if (!res.ok) {
      toast.error('Could not revoke the token.');
      return;
    }
    toast.success('Extension disconnected.');
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Puzzle className="h-5 w-5 text-primary" /> Botella Aura browser
            extension
          </CardTitle>
          <CardDescription>
            The extension is the only place LinkedIn actions happen — you review
            each item and click send yourself, inside your own browser. The
            backend never logs into LinkedIn or acts on your behalf.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <p>
              This token authorizes <span className="font-medium">only</span> the
              extension&apos;s action queue — never your full account. It&apos;s
              revocable anytime and scoped to this workspace.
            </p>
          </div>

          {canManage ? (
            <div>
              <Button onClick={generate} loading={busy}>
                <KeyRound className="h-4 w-4" /> Generate pairing token
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Ask an owner or admin to pair the extension.
            </p>
          )}

          {newToken && (
            <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4">
              <p className="text-sm font-medium">
                Your pairing token (shown once — copy it now):
              </p>
              <code className="block break-all rounded-md border border-border bg-background px-3 py-2 font-mono text-xs">
                {newToken}
              </code>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={copy}>
                  {copied ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                <Button size="sm" onClick={sendToExtension}>
                  <Send className="h-4 w-4" /> Send to extension
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Paste it into the extension popup, or click{' '}
                <span className="font-medium">Send to extension</span> if
                it&apos;s installed.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Paired devices</CardTitle>
          <CardDescription>
            Active extension tokens. Disconnect any you no longer use.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No extensions paired yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {tokens.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {t.label ?? 'Extension'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Paired {new Date(t.createdAt).toLocaleDateString()}
                      {t.lastUsedAt
                        ? ` · last used ${new Date(t.lastUsedAt).toLocaleString()}`
                        : ' · never used'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {t.lastUsedAt ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="muted">Pending</Badge>
                    )}
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => revoke(t.id)}
                        title="Disconnect"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Install the extension</CardTitle>
          <CardDescription>Chrome / Edge, developer mode (v1).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <ol className="ml-5 list-decimal space-y-1">
            <li>
              Open <code className="text-foreground">chrome://extensions</code>{' '}
              and enable <span className="font-medium">Developer mode</span>.
            </li>
            <li>
              Click <span className="font-medium">Load unpacked</span> and select
              the <code className="text-foreground">/extension</code> folder from
              the repo.
            </li>
            <li>
              Open the extension popup, generate a token above, and paste it (or
              click <span className="font-medium">Send to extension</span>).
            </li>
            <li>
              Go to LinkedIn — approved items from Content Studio appear in the
              extension&apos;s action panel, ready for you to send.
            </li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
