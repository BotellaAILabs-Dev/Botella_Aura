'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, CircleDashed, RefreshCw, TriangleAlert, XCircle } from 'lucide-react';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import { CONNECTORS } from '@/lib/connectors';
import { HEALTH_LABEL, healthBlocksExecution } from '@/lib/connection-health';
import type { ConnectionHealthStatus, ConnectionRecord } from '@/lib/connection-manager';
import type { CapabilityLevel, CapabilityRow } from '@/lib/capabilities';
import { LocalTime } from '@/components/ui/local-time';

export interface ConnectionEntryView extends ConnectionRecord {
  capabilityRows: CapabilityRow[];
  capabilityVersion: string | null;
  missingScopes: string[];
}

const HEALTH_VARIANT: Record<ConnectionHealthStatus, BadgeProps['variant']> = {
  CONNECTED: 'secondary',
  HEALTHY: 'success',
  WARNING: 'warning',
  EXPIRED: 'warning',
  DISCONNECTED: 'muted',
  ACTION_REQUIRED: 'destructive',
};

const LEVEL: Record<CapabilityLevel, { label: string; variant: BadgeProps['variant'] }> = {
  supported: { label: 'Yes', variant: 'success' },
  limited: { label: 'Yes, with a limit', variant: 'secondary' },
  unsupported: { label: 'No', variant: 'muted' },
  out_of_scope: { label: 'Not in scope', variant: 'muted' },
};

const CHANNEL: Record<string, string> = { FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', LINKEDIN: 'LinkedIn', WEB: 'Web', EMAIL: 'Email', CRM: 'CRM', SLACK: 'Slack' };

function providerName(connectorId: string): string {
  if (connectorId === 'meta') return 'Facebook & Instagram';
  return CONNECTORS.find((c) => c.id === connectorId)?.name ?? connectorId;
}

/** Start the provider's OAuth again (reconnect / reauthorize). */
async function reconnect(connectorId: string) {
  if (connectorId === 'linkedin') {
    window.location.href = '/api/linkedin/connect';
    return;
  }
  const res = await fetch(`/api/connectors/${connectorId}`, { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as { authorizeUrl?: string; error?: string };
  if (!res.ok || !body.authorizeUrl) {
    toast.error(body.error ?? 'Could not start reconnecting.');
    return;
  }
  window.location.href = body.authorizeUrl;
}

export function ConnectionManager({
  initial,
  canManage,
  canRefresh,
}: {
  initial: ConnectionEntryView[];
  canManage: boolean;
  canRefresh: boolean;
}) {
  const [connections, setConnections] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);

  async function refreshAll() {
    setBusy('*');
    try {
      const res = await fetch('/api/connections/health', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { connections?: ConnectionEntryView[]; changed?: unknown[]; error?: string };
      if (!res.ok || !body.connections) {
        toast.error(body.error ?? 'Could not re-check the connections.');
        return;
      }
      setConnections(body.connections);
      toast.success(body.changed?.length ? `Checked — ${body.changed.length} status change(s).` : 'Checked — no changes.');
    } finally {
      setBusy(null);
    }
  }

  async function refreshOne(connectorId: string) {
    setBusy(connectorId);
    try {
      const res = await fetch(`/api/connections/${connectorId}/health`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { connection?: ConnectionEntryView; error?: string };
      if (!res.ok || !body.connection) {
        toast.error(body.error ?? 'Could not re-check this connection.');
        return;
      }
      setConnections((list) => list.map((c) => (c.connectorId === connectorId ? body.connection! : c)));
      toast.success(`${providerName(connectorId)}: ${HEALTH_LABEL[body.connection.health]}.`);
    } finally {
      setBusy(null);
    }
  }

  if (connections.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
        Nothing is connected yet.{' '}
        <Link href="/dashboard/connectors" className="font-medium text-foreground underline underline-offset-2">
          Connect a tool
        </Link>{' '}
        to see it here.
      </div>
    );
  }

  const needsAction = connections.filter((c) => healthBlocksExecution(c.health)).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {connections.length} connection{connections.length === 1 ? '' : 's'}
          {needsAction ? ` · ${needsAction} can’t be used until fixed` : ' · all usable'}
        </p>
        {canRefresh ? (
          <Button variant="outline" size="sm" onClick={refreshAll} disabled={busy !== null}>
            <RefreshCw className={`h-4 w-4 ${busy === '*' ? 'animate-spin' : ''}`} /> Re-check all
          </Button>
        ) : null}
      </div>

      {connections.map((c) => (
        <ConnectionCard
          key={c.id}
          c={c}
          canManage={canManage}
          canRefresh={canRefresh}
          busy={busy === c.connectorId || busy === '*'}
          onRefresh={() => refreshOne(c.connectorId)}
        />
      ))}
    </div>
  );
}

function ConnectionCard({
  c,
  canManage,
  canRefresh,
  busy,
  onRefresh,
}: {
  c: ConnectionEntryView;
  canManage: boolean;
  canRefresh: boolean;
  busy: boolean;
  onRefresh: () => void;
}) {
  const blocked = healthBlocksExecution(c.health);
  const unconfirmed = c.setupStage !== 'CONFIRMED';
  const selected = c.accounts.filter((a) => a.selected && a.kind !== 'USER');
  const rows = c.capabilityRows;

  return (
    <section className="rounded-lg border border-border bg-card p-4 sm:p-5" aria-label={providerName(c.connectorId)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{providerName(c.connectorId)}</h2>
          <p className="truncate text-sm text-muted-foreground">{c.accountLabel ?? 'Account not identified yet'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={HEALTH_VARIANT[c.health]}>{HEALTH_LABEL[c.health]}</Badge>
          {unconfirmed ? <Badge variant="warning">Setup not finished</Badge> : null}
          {c.capabilityVersion ? <Badge variant="outline">{c.capabilityVersion}</Badge> : null}
        </div>
      </div>

      {c.healthReason || unconfirmed ? (
        <div className={`mt-3 flex items-start gap-2 rounded-md p-3 text-sm ${blocked ? 'bg-destructive/5' : 'bg-muted/50'}`}>
          {blocked ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> : <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1">
            <p>{c.healthReason ?? 'Choose and confirm the account Aura should use.'}</p>
            {blocked ? <p className="mt-1 text-xs text-muted-foreground">Nothing is published through this connection until it is fixed.</p> : null}
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {canManage && unconfirmed ? (
          <Button asChild size="sm">
            <Link href={`/dashboard/connections/${c.connectorId}/setup`}>Finish setup</Link>
          </Button>
        ) : null}
        {canManage && (blocked || c.health === 'WARNING' || c.missingScopes.length > 0) ? (
          <Button size="sm" variant={unconfirmed ? 'outline' : 'default'} onClick={() => reconnect(c.connectorId)}>
            Reconnect
          </Button>
        ) : null}
        {canRefresh ? (
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={busy}>
            <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /> Re-check
          </Button>
        ) : null}
        {canManage && !unconfirmed && c.accounts.some((a) => a.selectable) ? (
          <Button asChild size="sm" variant="ghost">
            <Link href={`/dashboard/connections/${c.connectorId}/setup`}>Change account</Link>
          </Button>
        ) : null}
      </div>

      <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Fact label="Uses">{selected.length ? selected.map((a) => a.name).join(' · ') : (c.accountLabel ?? '—')}</Fact>
        <Fact label="Channels">{c.channels.length ? c.channels.map((ch) => CHANNEL[ch] ?? ch).join(', ') : '—'}</Fact>
        <Fact label="Token">
          {!c.hasCredential ? 'None stored' : c.tokenExpiresAt ? <>Expires <LocalTime iso={c.tokenExpiresAt} /></> : 'No expiry set'}
          {c.credentialRef !== 'self' ? <span className="text-muted-foreground"> (held by the LinkedIn integration)</span> : null}
        </Fact>
        <Fact label="Last checked">{c.healthCheckedAt ? <LocalTime iso={c.healthCheckedAt} /> : 'Not yet'}</Fact>
        <Fact label="Last healthy">{c.lastHealthyAt ? <LocalTime iso={c.lastHealthyAt} /> : '—'}</Fact>
        <Fact label="Last published through it">
          {c.lastExecutionAt ? <LocalTime iso={c.lastExecutionAt} /> : '—'}
          {c.consecutiveFailures > 0 ? <span className="text-destructive"> · {c.consecutiveFailures} failure(s) since</span> : null}
        </Fact>
      </dl>

      <details className="mt-4 text-sm">
        <summary className="cursor-pointer font-medium">Permissions ({c.scopes.length} granted{c.missingScopes.length ? `, ${c.missingScopes.length} missing` : ''})</summary>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {c.scopes.map((s) => (
            <li key={s}>
              <Badge variant="outline" className="break-all font-mono text-[11px]">{s}</Badge>
            </li>
          ))}
          {c.missingScopes.map((s) => (
            <li key={`missing-${s}`}>
              <Badge variant="destructive" className="break-all font-mono text-[11px]">missing: {s}</Badge>
            </li>
          ))}
          {c.scopes.length === 0 && c.missingScopes.length === 0 ? <li className="text-muted-foreground">Not reported by the provider.</li> : null}
        </ul>
      </details>

      {c.accounts.length > 0 ? (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-medium">Accounts and pages ({c.accounts.length})</summary>
          <ul className="mt-2 space-y-1">
            {c.accounts.map((a) => (
              <li key={a.id} className={`flex items-center gap-2 ${a.parentId ? 'pl-5' : ''}`}>
                {a.selected ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> : <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />}
                <span className="min-w-0 truncate">{a.name}</span>
                <span className="text-xs text-muted-foreground">{a.kind.toLowerCase().replace(/_/g, ' ')}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {rows.length > 0 ? (
        <details className="mt-3 text-sm" open={c.connectorId === 'meta' || c.connectorId === 'linkedin'}>
          <summary className="cursor-pointer font-medium">What it can do</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[320px] text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Capability</th>
                  <th className="py-1 pr-3 font-medium">Available</th>
                  <th className="py-1 font-medium">Why / limit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.channel}-${r.capability}`} className="border-t border-border align-top">
                    <td className="py-1.5 pr-3">
                      {r.label}
                      {r.channel ? <span className="text-muted-foreground"> · {CHANNEL[r.channel] ?? r.channel}</span> : null}
                    </td>
                    <td className="py-1.5 pr-3">
                      <Badge variant={r.missingScopes.length ? 'destructive' : LEVEL[r.level].variant}>
                        {r.missingScopes.length ? 'Needs permission' : LEVEL[r.level].label}
                      </Badge>
                    </td>
                    <td className="py-1.5 text-muted-foreground">{r.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="w-40 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
