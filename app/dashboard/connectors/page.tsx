import type { Metadata } from 'next';
import { CheckCircle2, TriangleAlert, XCircle } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { getLinkedInStatus } from '@/server/services/linkedin.service';
import {
  listConnections,
  resolveCredential,
} from '@/server/connectors/connection.service';
import { getProvider, providerReadiness } from '@/server/connectors/providers';
import { PageHeader } from '@/components/dashboard/page-header';
import {
  ConnectorGrid,
  type ConnectorCardData,
} from '@/components/dashboard/connectors/connector-grid';
import { CONNECTORS, CONNECTOR_CATEGORIES } from '@/lib/connectors';

export const metadata: Metadata = { title: 'Connectors' };
export const dynamic = 'force-dynamic';

/** Feedback banner after an OAuth round-trip. */
function CallbackNotice({
  status,
  connector,
  account,
  reason,
}: {
  status?: string;
  connector?: string;
  account?: string;
  reason?: string;
}) {
  if (!status) return null;
  const name =
    CONNECTORS.find((c) => c.id === connector)?.name ?? connector ?? 'The connector';

  if (status === 'connected') {
    return (
      <div className="mb-5 flex items-start gap-2 rounded-lg border border-border bg-card p-3 text-sm">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">{name} connected</span>
          {account ? ` — ${account}` : ''}. Features that depend on it are live now.
        </p>
      </div>
    );
  }
  if (status === 'denied') {
    return (
      <div className="mb-5 flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-muted-foreground">
          {name} was not connected — the authorization was cancelled or declined
          {reason ? `: ${reason}` : ''}.
        </p>
      </div>
    );
  }
  return (
    <div className="mb-5 flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <p className="text-muted-foreground">
        {name} could not be connected{reason ? `: ${reason}` : '.'}
      </p>
    </div>
  );
}

export default async function ConnectorsPage({
  searchParams,
}: {
  searchParams: { status?: string; connector?: string; account?: string; reason?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, linkedIn, connections] = await Promise.all([
    getMembership(user.id, active.id),
    getLinkedInStatus(active.id),
    listConnections(active.id),
  ]);
  const canManage = membership ? can(membership.role, 'company:update') : false;
  const byId = new Map(connections.map((c) => [c.connectorId, c]));

  // A deployment-wide key makes a connector work without anyone connecting it.
  // Say so, rather than showing "Available" next to something already running.
  const envBacked = new Set<string>();
  await Promise.all(
    CONNECTORS.map(async (c) => {
      if (byId.has(c.id)) return;
      const provider = getProvider(c.id);
      if (provider?.auth !== 'api_key') return;
      const cred = await resolveCredential(active.id, c.id);
      if (cred?.origin === 'env') envBacked.add(c.id);
    }),
  );

  const cards: ConnectorCardData[] = CONNECTORS.map((c) => {
    const provider = getProvider(c.id);
    const readiness = providerReadiness(c.id);
    const connection = byId.get(c.id) ?? null;

    // LinkedIn keeps its dedicated OAuth flow in Settings → Connections.
    if (c.id === 'linkedin') {
      return {
        id: c.id,
        name: c.name,
        category: c.category,
        description: c.description,
        color: c.color,
        connectHref: c.connectHref,
        implemented: true,
        connectable: true,
        connection: linkedIn.connected
          ? {
              status: 'CONNECTED' as const,
              accountLabel: linkedIn.displayName ?? 'LinkedIn account',
              errorMessage: null,
              lastSyncedAt: null,
            }
          : null,
      };
    }

    return {
      id: c.id,
      name: c.name,
      category: c.category,
      description: c.description,
      color: c.color,
      implemented: readiness.implemented,
      auth: readiness.auth,
      connectable: readiness.connectable,
      ...(readiness.blockedReason ? { blockedReason: readiness.blockedReason } : {}),
      ...(readiness.unlocks ? { unlocks: readiness.unlocks } : {}),
      ...(provider?.apiKey
        ? {
            apiKeyLabel: provider.apiKey.label,
            apiKeyHelpUrl: provider.apiKey.helpUrl,
            ...(provider.apiKey.secondaryLabel
              ? {
                  secondaryLabel: provider.apiKey.secondaryLabel,
                  secondaryMetadataKey: provider.apiKey.secondaryMetadataKey,
                }
              : {}),
          }
        : {}),
      connection: connection
        ? {
            status: connection.status,
            accountLabel: connection.accountLabel,
            errorMessage: connection.errorMessage,
            lastSyncedAt: connection.lastSyncedAt,
          }
        : null,
      usingEnvFallback: envBacked.has(c.id),
    };
  });

  const liveCount = cards.filter(
    (c) => c.connection?.status === 'CONNECTED' || c.usingEnvFallback,
  ).length;
  const readyCount = cards.filter((c) => c.implemented).length;

  return (
    <div>
      <PageHeader
        title="Connectors"
        description="Securely connect your marketing tools and data sources. Aura only ever uses official APIs — never scraping — and never acts without your approval."
      />

      <CallbackNotice
        status={searchParams.status}
        connector={searchParams.connector}
        account={searchParams.account}
        reason={searchParams.reason}
      />

      <p className="mb-5 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{liveCount} connected</span> ·{' '}
        {readyCount} with a working integration · {CONNECTORS.length - readyCount} on
        the roadmap. Credentials are verified with the provider before they are
        saved, then stored encrypted — they are never sent back to your browser.
      </p>

      <div className="space-y-8">
        {CONNECTOR_CATEGORIES.map((category) => {
          const items = cards.filter((c) => c.category === category);
          if (items.length === 0) return null;
          return (
            <section key={category}>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {category}
              </h2>
              <ConnectorGrid connectors={items} canManage={canManage} />
            </section>
          );
        })}
      </div>
    </div>
  );
}
