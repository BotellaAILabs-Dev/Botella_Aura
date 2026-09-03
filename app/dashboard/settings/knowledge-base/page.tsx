import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getCompanyById } from '@/server/services/company.service';
import { getKnowledgeStatus } from '@/server/knowledge/ingest.service';
import { getMaterialCoverage } from '@/server/knowledge/coverage';
import { getBrandVoiceProfile } from '@/server/content/brand-voice.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { KnowledgeManager } from '@/components/dashboard/knowledge/knowledge-manager';
import { MaterialCoverage } from '@/components/dashboard/knowledge/material-coverage';
import { BrandVoiceCard } from '@/components/dashboard/content/brand-voice-card';

export const metadata: Metadata = { title: 'Business materials' };

export default async function KnowledgeBasePage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const [status, company, coverage] = await Promise.all([
    getKnowledgeStatus(active.id),
    getCompanyById(active.id),
    getMaterialCoverage(active.id),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard/settings"
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Settings
        </Link>
        <PageHeader
          title="Business materials"
          description="Give Aura your real documents — decks, guidelines, product docs, competitor notes — and it writes from what your company actually says, not from guesswork."
        />
      </div>

      <MaterialCoverage coverage={coverage} />

      <KnowledgeManager
        sources={status.sources.map((s) => ({
          id: s.id,
          type: s.type,
          label: s.label,
          status: s.status,
          lastSyncedAt: s.lastSyncedAt ? s.lastSyncedAt.toISOString() : null,
          error: s.error,
          chunkCount: s.chunkCount,
          category: s.category,
        }))}
        uploads={status.uploads}
        totalChunks={status.totalChunks}
        hasWebsite={Boolean(company?.website)}
      />

      <BrandVoiceCard initial={company ? getBrandVoiceProfile(company) : null} />
    </div>
  );
}
