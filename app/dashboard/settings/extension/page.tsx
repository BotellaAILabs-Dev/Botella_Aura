import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft, AlertTriangle } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { can } from '@/lib/rbac';
import { listExtensionTokens } from '@/server/extension/token.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { Button } from '@/components/ui/button';
import {
  ExtensionManager,
  type ExtensionTokenRow,
} from '@/components/dashboard/extension/extension-manager';
import {
  ExtensionInstallCard,
  type ExtensionBuildInfo,
} from '@/components/dashboard/extension/extension-install-card';
import { getAppUrl } from '@/lib/app-url';

export const metadata: Metadata = { title: 'Browser extension' };
export const dynamic = 'force-dynamic';

/**
 * Metadata for the packaged build, written by scripts/package-extension.mjs
 * during `pnpm build`. Absent in a dev checkout that has not packaged yet, in
 * which case the install card explains how to produce it.
 */
async function readBuildInfo(): Promise<ExtensionBuildInfo | null> {
  try {
    const raw = await readFile(
      join(process.cwd(), 'public', 'downloads', 'botella-aura-extension.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as Partial<ExtensionBuildInfo>;
    if (!parsed.version) return null;
    return {
      version: parsed.version,
      bytes: Number(parsed.bytes ?? 0),
      sha256Prefix: String(parsed.sha256Prefix ?? ''),
    };
  } catch {
    return null;
  }
}

export default async function ExtensionSettingsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [membership, tokens, build] = await Promise.all([
    getMembership(user.id, active.id),
    listExtensionTokens(user.id, active.id),
    readBuildInfo(),
  ]);
  const canManage = membership ? can(membership.role, 'linkedin:connect') : false;

  const rows: ExtensionTokenRow[] = tokens.map((t) => ({
    id: t.id,
    label: t.label,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
    expiresAt: t.expiresAt ? t.expiresAt.toISOString() : null,
  }));

  return (
    <div>
      <PageHeader
        title="Browser extension"
        description="Pair the companion extension — your one-click action layer for LinkedIn."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/settings">
              <ArrowLeft className="h-4 w-4" /> Settings
            </Link>
          </Button>
        }
      />

      {/* Honest beta framing — the extension is not yet on the Chrome Web Store. */}
      <div className="mb-6 flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning-foreground" />
        <div className="text-sm">
          <p className="font-medium text-foreground">
            Internal / Beta build
          </p>
          <p className="mt-0.5 text-muted-foreground">
            The companion extension is an <strong>internal beta</strong> and is not
            yet on the Chrome Web Store — that needs your own Google developer
            account and Google&apos;s review. It is fully testable today: download
            the packaged build below and load it unpacked. Nothing is posted or
            sent without your explicit click.
          </p>
        </div>
      </div>

      {/* Download + sideload — what makes end-to-end testing possible now. */}
      <ExtensionInstallCard build={build} appUrl={getAppUrl()} />

      <ExtensionManager tokens={rows} canManage={canManage} />
    </div>
  );
}
