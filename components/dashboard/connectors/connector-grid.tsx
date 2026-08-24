'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check,
  ExternalLink,
  KeyRound,
  Link2,
  Plug,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';

import { toast } from '@/components/ui/toaster';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { connectorInitials } from '@/lib/connectors';

export interface ConnectorCardData {
  id: string;
  name: string;
  category: string;
  description: string;
  color: string;
  /** Bespoke flow (LinkedIn lives in Settings → Connections). */
  connectHref?: string;
  /** Does an integration exist in the codebase at all? */
  implemented: boolean;
  auth?: 'oauth' | 'api_key';
  /** Can it be connected on this deployment right now? */
  connectable: boolean;
  blockedReason?: string;
  unlocks?: string;
  apiKeyLabel?: string;
  apiKeyHelpUrl?: string;
  secondaryLabel?: string;
  secondaryMetadataKey?: string;
  /** Live connection state, if connected. */
  connection: {
    status: 'CONNECTED' | 'ERROR' | 'EXPIRED' | 'DISCONNECTED';
    accountLabel: string | null;
    errorMessage: string | null;
    lastSyncedAt: string | null;
  } | null;
  /** True when a deployment-wide key is doing the work instead of a connection. */
  usingEnvFallback?: boolean;
}

function statusBadge(c: ConnectorCardData): {
  label: string;
  variant: BadgeProps['variant'];
} {
  if (c.connection?.status === 'CONNECTED') return { label: 'Connected', variant: 'success' };
  if (c.connection?.status === 'ERROR') return { label: 'Needs attention', variant: 'destructive' };
  if (c.connection?.status === 'EXPIRED') return { label: 'Reconnect', variant: 'warning' };
  if (c.usingEnvFallback) return { label: 'Active (server key)', variant: 'success' };
  if (!c.implemented) return { label: 'On the roadmap', variant: 'muted' };
  if (!c.connectable) return { label: 'Needs setup', variant: 'warning' };
  return { label: 'Available', variant: 'outline' };
}

export function ConnectorGrid({
  connectors,
  canManage,
}: {
  connectors: ConnectorCardData[];
  canManage: boolean;
}) {
  const [keyDialog, setKeyDialog] = useState<ConnectorCardData | null>(null);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {connectors.map((c) => (
          <ConnectorCard
            key={c.id}
            connector={c}
            canManage={canManage}
            onEnterKey={() => setKeyDialog(c)}
          />
        ))}
      </div>
      <ApiKeyDialog
        connector={keyDialog}
        onClose={() => setKeyDialog(null)}
      />
    </>
  );
}

function ConnectorCard({
  connector,
  canManage,
  onEnterKey,
}: {
  connector: ConnectorCardData;
  canManage: boolean;
  onEnterKey: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const badge = statusBadge(connector);
  const connected = connector.connection?.status === 'CONNECTED';

  async function startOAuth() {
    setBusy('connect');
    try {
      const res = await fetch(`/api/connectors/${connector.id}`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as {
        authorizeUrl?: string;
        error?: string;
      };
      if (!res.ok || !body.authorizeUrl) {
        toast.error(body.error ?? 'Could not start the connection.');
        return;
      }
      window.location.href = body.authorizeUrl;
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    try {
      const res = await fetch(`/api/connectors/${connector.id}/test`, {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        accountLabel?: string;
        error?: string;
      };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not run the test.');
        return;
      }
      if (body.ok) toast.success(`Working — ${body.accountLabel ?? connector.name}.`);
      else toast.error(body.error ?? 'The provider rejected these credentials.');
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!confirm(`Disconnect ${connector.name}? Stored credentials are deleted.`))
      return;
    setBusy('remove');
    try {
      const res = await fetch(`/api/connectors/${connector.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(b.error ?? 'Could not disconnect.');
        return;
      }
      toast.success(`${connector.name} disconnected.`);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="flex h-full flex-col">
      <CardContent className="flex flex-1 flex-col p-4">
        <div className="mb-2 flex items-center gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white"
            style={{ backgroundColor: connector.color }}
            aria-hidden
          >
            {connectorInitials(connector.name)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {connector.name}
            </p>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">{connector.description}</p>

        {/* What connecting actually turns on inside Aura. */}
        {connector.unlocks && !connected && (
          <p className="mt-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Unlocks:</span>{' '}
            {connector.unlocks}
          </p>
        )}

        {connected && connector.connection?.accountLabel && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="h-3.5 w-3.5 text-primary" />
            {connector.connection.accountLabel}
          </p>
        )}

        {connector.usingEnvFallback && !connected && (
          <p className="mt-2 text-xs text-muted-foreground">
            Already active using a key configured on the server. Connect here to
            manage it per workspace instead.
          </p>
        )}

        {connector.connection?.errorMessage && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {connector.connection.errorMessage}
          </p>
        )}

        {/* Honest reason instead of an indefinite "coming soon". */}
        {!connector.connectable && connector.blockedReason && (
          <p className="mt-2 text-xs text-muted-foreground">
            {connector.blockedReason}
          </p>
        )}

        <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
          {connector.connectHref ? (
            <Button asChild size="sm" variant="outline">
              <Link href={connector.connectHref}>
                <Link2 className="h-4 w-4" /> Manage
              </Link>
            </Button>
          ) : !canManage ? null : connected ? (
            <>
              <Button size="sm" variant="outline" onClick={test} loading={busy === 'test'}>
                <RefreshCw className="h-4 w-4" /> Test
              </Button>
              {connector.auth === 'api_key' && (
                <Button size="sm" variant="ghost" onClick={onEnterKey}>
                  <KeyRound className="h-4 w-4" /> Replace key
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={remove}
                loading={busy === 'remove'}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </>
          ) : connector.auth === 'api_key' ? (
            <Button size="sm" onClick={onEnterKey}>
              <KeyRound className="h-4 w-4" /> Add key
            </Button>
          ) : connector.auth === 'oauth' && connector.connectable ? (
            <Button size="sm" onClick={startOAuth} loading={busy === 'connect'}>
              <Plug className="h-4 w-4" /> Connect
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function ApiKeyDialog({
  connector,
  onClose,
}: {
  connector: ConnectorCardData | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState('');
  const [secondary, setSecondary] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!connector) return;
    if (apiKey.trim().length < 8) {
      toast.error('Paste the full key.');
      return;
    }
    setSaving(true);
    try {
      const metadata =
        connector.secondaryMetadataKey && secondary.trim()
          ? { [connector.secondaryMetadataKey]: secondary.trim() }
          : undefined;
      const res = await fetch(`/api/connectors/${connector.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim(), metadata }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        // The key is verified against the provider before it is stored, so this
        // message is the provider's own reason, not a guess.
        toast.error(body.error ?? 'That key was rejected.');
        return;
      }
      toast.success(`${connector.name} connected.`);
      setApiKey('');
      setSecondary('');
      onClose();
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={Boolean(connector)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {connector && (
          <>
            <DialogHeader>
              <DialogTitle>Connect {connector.name}</DialogTitle>
              <DialogDescription>
                Your key is verified with {connector.name} before it is saved, then
                stored encrypted. It is never shown again or sent to the browser.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>{connector.apiKeyLabel ?? 'API key'}</Label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Paste your key"
                  autoComplete="off"
                />
              </div>
              {connector.secondaryLabel && (
                <div className="space-y-1.5">
                  <Label>{connector.secondaryLabel}</Label>
                  <Input
                    value={secondary}
                    onChange={(e) => setSecondary(e.target.value)}
                    autoComplete="off"
                  />
                </div>
              )}
              {connector.apiKeyHelpUrl && (
                <a
                  href={connector.apiKeyHelpUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  Where do I get this key? <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={save} loading={saving}>
                Verify &amp; save
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
