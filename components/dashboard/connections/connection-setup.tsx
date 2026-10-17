'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, CheckCircle2, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import type { ConnectedAccountView } from '@/lib/connection-manager';
import type { ConnectionEntryView } from '@/components/dashboard/connections/connection-manager';

interface Step {
  key: string;
  label: string;
  state: 'done' | 'current' | 'todo';
}

export interface SetupData {
  connection: ConnectionEntryView;
  steps: Step[];
  permissions: { scope: string; granted: boolean }[];
  choices: ConnectedAccountView[];
  needsChoice: boolean;
  canConfirm: boolean;
  blockedReason: string | null;
}

async function startConnect(connectorId: string) {
  if (connectorId === 'linkedin') {
    window.location.href = '/api/linkedin/connect';
    return;
  }
  const res = await fetch(`/api/connectors/${connectorId}`, { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as { authorizeUrl?: string; error?: string };
  if (!res.ok || !body.authorizeUrl) {
    toast.error(body.error ?? 'Could not start the connection.');
    return;
  }
  window.location.href = body.authorizeUrl;
}

export function ConnectionSetup({
  connectorId,
  name,
  initial,
  justAuthorized,
  canManage,
}: {
  connectorId: string;
  name: string;
  initial: SetupData | null;
  justAuthorized: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [setup, setSetup] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);

  const steps: Step[] = setup?.steps ?? [
    { key: 'connect', label: 'Connect', state: 'current' },
    { key: 'authenticate', label: 'Authenticate', state: 'todo' },
    { key: 'authorize', label: 'Authorize', state: 'todo' },
    { key: 'select', label: 'Select account/page', state: 'todo' },
    { key: 'confirm', label: 'Confirm connection', state: 'todo' },
  ];

  async function choose(accountId: string) {
    setBusy(accountId);
    try {
      const res = await fetch(`/api/connections/${connectorId}/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      });
      const body = (await res.json().catch(() => ({}))) as SetupData & { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not choose that account.');
        return;
      }
      setSetup(body);
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    setBusy('confirm');
    try {
      const res = await fetch(`/api/connections/${connectorId}/confirm`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as SetupData & { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? 'Could not confirm the connection.');
        return;
      }
      setSetup(body);
      toast.success(`${name} is connected.`);
      router.push('/dashboard/connections');
    } finally {
      setBusy(null);
    }
  }

  const confirmed = setup?.connection.setupStage === 'CONFIRMED';

  return (
    <div className="space-y-6">
      <ol className="grid gap-2 sm:grid-cols-5" aria-label="Connection steps">
        {steps.map((s, i) => (
          <li
            key={s.key}
            className={`flex items-center gap-2 rounded-md border p-2 text-sm ${
              s.state === 'current' ? 'border-primary bg-primary/5 font-medium' : 'border-border'
            } ${s.state === 'todo' ? 'text-muted-foreground' : ''}`}
            aria-current={s.state === 'current' ? 'step' : undefined}
          >
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${s.state === 'done' ? 'bg-primary text-primary-foreground' : 'border border-border'}`}>
              {s.state === 'done' ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            {s.label}
          </li>
        ))}
      </ol>

      {!setup ? (
        <section className="rounded-lg border border-border bg-card p-5 text-sm">
          <p>{name} isn’t connected to this workspace yet. Connecting opens {name}’s sign-in, where you approve what Aura may do.</p>
          {canManage ? (
            <Button className="mt-3" onClick={() => startConnect(connectorId)}>
              Connect {name}
            </Button>
          ) : (
            <p className="mt-2 text-muted-foreground">Ask an owner or admin to connect it.</p>
          )}
        </section>
      ) : (
        <>
          {justAuthorized && !confirmed ? (
            <p className="rounded-md bg-muted/50 p-3 text-sm">
              Signed in to {name} and access granted. Check the account and permissions below, then confirm.
            </p>
          ) : null}

          {setup.needsChoice ? (
            <section className="rounded-lg border border-border bg-card p-5">
              <h2 className="text-base font-semibold">Which account or page should Aura use?</h2>
              <p className="mt-1 text-sm text-muted-foreground">Posts are published here. You can change it later.</p>
              <ul className="mt-3 space-y-2">
                {setup.choices.map((a) => {
                  const ig = setup.connection.accounts.find((x) => x.parentId === a.id && x.kind === 'INSTAGRAM_ACCOUNT');
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        disabled={!canManage || busy !== null}
                        onClick={() => choose(a.id)}
                        aria-pressed={a.selected}
                        className={`flex w-full items-center justify-between gap-3 rounded-md border p-3 text-left text-sm transition-colors ${
                          a.selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{a.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {connectorId === 'meta' ? (ig ? `Instagram: ${ig.name}` : 'No Instagram account linked — Facebook only') : a.kind.toLowerCase().replace(/_/g, ' ')}
                          </span>
                        </span>
                        {a.selected ? <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" /> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : setup.connection.accounts.length ? (
            <section className="rounded-lg border border-border bg-card p-5 text-sm">
              <h2 className="text-base font-semibold">Account</h2>
              <p className="mt-1">{setup.connection.accounts.filter((a) => a.selected).map((a) => a.name).join(' · ') || setup.connection.accountLabel}</p>
            </section>
          ) : null}

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-base font-semibold">Required permissions</h2>
            {setup.permissions.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">This connection only reads data; it needs no publishing permission.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {setup.permissions.map((p) => (
                  <li key={p.scope} className="flex items-center gap-2">
                    {p.granted ? <CheckCircle2 className="h-4 w-4 text-primary" /> : <XCircle className="h-4 w-4 text-destructive" />}
                    <code className="break-all text-xs">{p.scope}</code>
                    <span className="text-xs text-muted-foreground">{p.granted ? 'granted' : 'not granted'}</span>
                  </li>
                ))}
              </ul>
            )}
            {setup.permissions.some((p) => !p.granted) && canManage ? (
              <Button className="mt-3" variant="outline" size="sm" onClick={() => startConnect(connectorId)}>
                Reconnect and allow
              </Button>
            ) : null}
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-base font-semibold">{confirmed ? 'Connected' : 'Confirm connection'}</h2>
            {confirmed ? (
              <p className="mt-1 text-sm text-muted-foreground">This connection is confirmed. Its health is shown in the Connection Manager.</p>
            ) : setup.blockedReason ? (
              <p className="mt-1 text-sm text-destructive">{setup.blockedReason}</p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">Aura will publish through {setup.connection.accountLabel ?? name} once you confirm.</p>
            )}
            {canManage && !confirmed ? (
              <Button className="mt-3" onClick={confirm} disabled={!setup.canConfirm || busy !== null} loading={busy === 'confirm'}>
                Confirm connection
              </Button>
            ) : null}
            {!canManage ? <p className="mt-2 text-sm text-muted-foreground">Only owners and admins can confirm connections.</p> : null}
          </section>
        </>
      )}
    </div>
  );
}
