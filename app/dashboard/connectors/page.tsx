import Link from 'next/link';
import type { Metadata } from 'next';
import { Check, ArrowRight, Plug } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getLinkedInStatus } from '@/server/services/linkedin.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CONNECTORS,
  CONNECTOR_CATEGORIES,
  connectorInitials,
  type Connector,
} from '@/lib/connectors';

export const metadata: Metadata = { title: 'Connectors' };

export default async function ConnectorsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  // Real-time status for connectors that actually have an integration.
  const linkedIn = await getLinkedInStatus(active.id);
  const linkedInConnected = linkedIn.connected;

  return (
    <div>
      <PageHeader
        title="Connectors"
        description="Securely connect your marketing tools and data sources. Aura only ever uses official APIs — never scraping — and never acts without your approval."
      />

      <div className="space-y-8">
        {CONNECTOR_CATEGORIES.map((category) => {
          const items = CONNECTORS.filter((c) => c.category === category);
          if (items.length === 0) return null;
          return (
            <section key={category}>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {category}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((c) => (
                  <ConnectorCard
                    key={c.id}
                    connector={c}
                    connected={c.id === 'linkedin' && linkedInConnected}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ConnectorCard({
  connector,
  connected,
}: {
  connector: Connector;
  connected: boolean;
}) {
  const available = connector.status === 'available';
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
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {connector.name}
            </p>
            {connected ? (
              <Badge variant="success" className="mt-0.5">
                <Check className="h-3 w-3" /> Connected
              </Badge>
            ) : available ? (
              <Badge variant="secondary" className="mt-0.5">
                Available
              </Badge>
            ) : (
              <Badge variant="muted" className="mt-0.5">
                Coming soon
              </Badge>
            )}
          </div>
        </div>

        <p className="flex-1 text-sm text-muted-foreground">
          {connector.description}
        </p>

        <div className="mt-3">
          {connected ? (
            <Button asChild variant="outline" size="sm" className="w-full">
              <Link href={connector.connectHref ?? '#'}>Manage</Link>
            </Button>
          ) : available && connector.connectHref ? (
            <Button asChild size="sm" className="w-full">
              <Link href={connector.connectHref}>
                Connect <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="w-full" disabled>
              <Plug className="h-4 w-4" /> Coming soon
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
