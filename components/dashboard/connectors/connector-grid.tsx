'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  Mail,
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
import { connectorInitials, CONNECTOR_CATEGORIES } from '@/lib/connectors';
import { MetaPagePicker } from '@/components/dashboard/connectors/meta-page-picker';

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
    status: 'CONNECTED' | 'ERROR' | 'EXPIRED' | 'DISCONNECTED' | 'REVOKED';
    accountLabel: string | null;
    errorMessage: string | null;
    lastSyncedAt: string | null;
    /** Connection Manager state (lib/connection-health.ts). */
    setupStage?: 'AUTHORIZED' | 'ACCOUNT_SELECTED' | 'CONFIRMED';
    health?: string;
    healthReason?: string | null;
  } | null;
  /** True when a deployment-wide key is doing the work instead of a connection. */
  usingEnvFallback?: boolean;
}

function statusBadge(c: ConnectorCardData): {
  label: string;
  variant: BadgeProps['variant'];
} {
  if (c.connection?.status === 'REVOKED') return { label: 'Access removed', variant: 'destructive' };
  if (c.connection && c.connection.setupStage && c.connection.setupStage !== 'CONFIRMED') return { label: 'Finish setup', variant: 'warning' };
  if (c.connection?.health === 'ACTION_REQUIRED') return { label: 'Action required', variant: 'destructive' };
  if (c.connection?.health === 'EXPIRED') return { label: 'Reconnect', variant: 'warning' };
  if (c.connection?.health === 'WARNING') return { label: 'Warning', variant: 'warning' };
  if (c.connection?.status === 'CONNECTED') return { label: 'Connected', variant: 'success' };
  if (c.connection?.status === 'ERROR') return { label: 'Needs attention', variant: 'destructive' };
  if (c.connection?.status === 'EXPIRED') return { label: 'Reconnect', variant: 'warning' };
  if (c.usingEnvFallback) return { label: 'Active (server key)', variant: 'success' };
  if (!c.implemented) return { label: 'On the roadmap', variant: 'muted' };
  if (!c.connectable) return { label: 'Needs setup', variant: 'warning' };
  return { label: 'Available', variant: 'outline' };
}

/**
 * Connectors, split by whether they actually work.
 *
 * Interleaving 20-odd "On the roadmap" placeholders with the handful that
 * function made the catalog read as feature-rich but hollow, and invited users
 * to click things that cannot connect. Working integrations now get the page;
 * roadmap items collapse into one clearly-labelled, low-prominence list.
 */
export function ConnectorGrid({
  connectors,
  canManage,
}: {
  connectors: ConnectorCardData[];
  canManage: boolean;
}) {
  const [keyDialog, setKeyDialog] = useState<ConnectorCardData | null>(null);
  const [emailDialog, setEmailDialog] = useState<ConnectorCardData | null>(null);
  const [showRoadmap, setShowRoadmap] = useState(false);

  const live = connectors.filter((c) => c.implemented);
  const roadmap = connectors.filter((c) => !c.implemented);

  return (
    <>
      <section>
        <h2 className="mb-1 text-sm font-semibold text-foreground">
          Available now
        </h2>
        <p className="mb-4 text-xs text-muted-foreground">
          {live.length} integration{live.length === 1 ? '' : 's'} built and ready
          to connect. Anything needing a credential says exactly which one.
        </p>
        {/* Categories group the working integrations only — roadmap items are
            never mixed in among them. */}
        <div className="space-y-6">
          {CONNECTOR_CATEGORIES.map((category) => {
            const items = live.filter((c) => c.category === category);
            if (items.length === 0) return null;
            return (
              <div key={category}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {category}
                </h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {items.map((c) => (
                    <ConnectorCard
                      key={c.id}
                      connector={c}
                      canManage={canManage}
                      onEnterKey={() => setKeyDialog(c)}
                      onEmailVerify={() => setEmailDialog(c)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {roadmap.length > 0 && (
        <section className="mt-8">
          <button
            type="button"
            onClick={() => setShowRoadmap((v) => !v)}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/40"
          >
            <ChevronDown
              className={`h-4 w-4 shrink-0 transition-transform ${showRoadmap ? '' : '-rotate-90'}`}
            />
            <span className="font-medium text-foreground">Coming soon</span>
            <span>
              — {roadmap.length} integration{roadmap.length === 1 ? '' : 's'} on the
              roadmap, not yet built. Nothing here can be connected.
            </span>
          </button>
          {showRoadmap && (
            <ul className="mt-3 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {roadmap.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2 text-xs text-muted-foreground"
                >
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white opacity-50"
                    style={{ backgroundColor: c.color }}
                    aria-hidden
                  >
                    {connectorInitials(c.name)}
                  </span>
                  <span className="truncate">{c.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide">
                    {c.category}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <ApiKeyDialog connector={keyDialog} onClose={() => setKeyDialog(null)} />
      <EmailVerifyDialog
        connector={emailDialog}
        onClose={() => setEmailDialog(null)}
      />
    </>
  );
}

function ConnectorCard({
  connector,
  canManage,
  onEnterKey,
  onEmailVerify,
}: {
  connector: ConnectorCardData;
  canManage: boolean;
  onEnterKey: () => void;
  onEmailVerify: () => void;
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
        redirectUri?: string;
        error?: string;
      };
      if (!res.ok || !body.authorizeUrl) {
        // The pre-flight check ran server-side, so this message already names
        // the fix rather than deferring to the provider's error page.
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

        {/* Which Page (and Instagram) Meta publishes to; expiry warning. */}
        {connected && connector.id === 'meta' && <MetaPagePicker canManage={canManage} />}

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
            <>
              <Button size="sm" onClick={startOAuth} loading={busy === 'connect'}>
                <Plug className="h-4 w-4" /> Connect
              </Button>
              <Button size="sm" variant="ghost" onClick={onEmailVerify}>
                <Mail className="h-4 w-4" /> Use email code
              </Button>
            </>
          ) : connector.auth === 'oauth' ? (
            // OAuth app credentials are missing, but the workspace can still
            // record which account this connector belongs to.
            <Button size="sm" variant="outline" onClick={onEmailVerify}>
              <Mail className="h-4 w-4" /> Verify by email
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

/**
 * Connect by proving control of the account email.
 *
 * The alternative path for when a provider's OAuth client is not registered on
 * this deployment — the user is not left staring at "needs setup" with nothing
 * they can do. It records which account the connector belongs to; it does not
 * pretend to grant API access, and says so.
 */
function EmailVerifyDialog({
  connector,
  onClose,
}: {
  connector: ConnectorCardData | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);

  function close() {
    setEmail('');
    setCode('');
    setStage('email');
    onClose();
  }

  async function submit(payload: { email: string } | { code: string }) {
    if (!connector) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/connectors/${connector.id}/email-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as {
        stage?: string;
        accountLabel?: string;
        error?: string;
      };
      if (!res.ok) {
        toast.error(body.error ?? 'That did not work.');
        return;
      }
      if (body.stage === 'code_sent') {
        toast.success('Code sent — check that inbox.');
        setStage('code');
        return;
      }
      toast.success(`${connector.name} verified as ${body.accountLabel}.`);
      close();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(connector)} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Verify {connector?.name} by email</DialogTitle>
          <DialogDescription>
            We&apos;ll email a 6-digit code to the account address. This confirms
            which account is yours so results can be logged against it —
            automatic metric sync still needs OAuth or an API key.
          </DialogDescription>
        </DialogHeader>

        {stage === 'email' ? (
          <div className="space-y-2">
            <Label htmlFor="verify-email">Account email</Label>
            <Input
              id="verify-email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="verify-code">6-digit code</Label>
            <Input
              id="verify-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="text-center text-lg tracking-[0.4em]"
            />
            <p className="text-xs text-muted-foreground">
              Sent to {email}. It expires in 15 minutes.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          {stage === 'email' ? (
            <Button onClick={() => void submit({ email })} loading={busy}>
              Send code
            </Button>
          ) : (
            <Button
              onClick={() => void submit({ code })}
              loading={busy}
              disabled={code.length !== 6}
            >
              Verify
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The exact redirect URIs this deployment sends providers.
 *
 * `redirect_uri_mismatch` is almost always a transcription problem, so the
 * value is shown verbatim with a copy button rather than described in prose
 * and retyped by hand into a provider console.
 */
export function RedirectUriPanel({
  entries,
  appUrl,
}: {
  entries: { label: string; uri: string; connectors: string[] }[];
  appUrl: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(uri: string) {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(uri);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error('Could not copy — select the text and copy it manually.');
    }
  }

  if (entries.length === 0) return null;

  return (
    <Card className="mt-8">
      <CardContent className="p-4">
        <p className="text-sm font-medium text-foreground">
          Redirect URIs to register
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Paste these into each provider&apos;s OAuth console exactly as shown. A
          single character of difference is what produces{' '}
          <code className="rounded bg-muted px-1">Error 400: redirect_uri_mismatch</code>.
          This deployment identifies itself as{' '}
          <span className="font-medium text-foreground">{appUrl}</span>.
        </p>
        <ul className="mt-3 space-y-2">
          {entries.map((entry) => (
            <li
              key={entry.uri}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-2"
            >
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {entry.label}
              </span>
              <code className="min-w-0 flex-1 break-all text-xs text-foreground">
                {entry.uri}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void copy(entry.uri)}
              >
                {copied === entry.uri ? (
                  <>
                    <Check className="h-4 w-4" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" /> Copy
                  </>
                )}
              </Button>
            </li>
          ))}
        </ul>
        <ProviderCheck />
      </CardContent>
    </Card>
  );
}

type CheckRow = { label: string; url: string; verdict: string; detail: string };

const VERDICT: Record<string, { text: string; tone: string }> = {
  accepted: { text: 'Accepted', tone: 'text-primary' },
  redirect_not_registered: { text: 'Not registered', tone: 'text-destructive' },
  scope_not_allowed: { text: 'Permission missing', tone: 'text-destructive' },
  unknown_client: { text: 'App not recognised', tone: 'text-destructive' },
  no_credentials: { text: 'Not set up', tone: 'text-muted-foreground' },
  unchecked: { text: 'Unclear', tone: 'text-muted-foreground' },
};

/**
 * Asks the providers themselves whether this deployment's redirect URLs are
 * registered — the check behind most "Sign in with LinkedIn doesn't work".
 */
function ProviderCheck() {
  const [rows, setRows] = useState<CheckRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch('/api/connectors/oauth-check');
      const data = (await res.json().catch(() => ({}))) as { results?: CheckRow[]; error?: string };
      if (!res.ok || !data.results) {
        toast.error(data.error ?? 'Could not run the check.');
        return;
      }
      setRows(data.results);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-2">
      <Button size="sm" variant="outline" onClick={() => void run()} loading={busy}>
        Check with LinkedIn, Google and Meta
      </Button>
      {rows && (
        <ul className="space-y-1 text-xs">
          {rows.map((r) => (
            <li key={r.url} className="flex flex-wrap gap-x-2">
              <span className={`font-medium ${VERDICT[r.verdict]?.tone ?? ''}`}>{VERDICT[r.verdict]?.text ?? r.verdict}</span>
              <span className="text-foreground">{r.label}</span>
              <span className="text-muted-foreground">— {r.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
