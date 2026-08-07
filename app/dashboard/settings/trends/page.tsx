import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getCompanyById } from '@/server/services/company.service';
import {
  ensureTrendConfig,
  getEnabledFlags,
  seedSmartDefaults,
} from '@/server/services/trend-config.service';
import { PageHeader } from '@/components/dashboard/page-header';
import { TrendConfigForm } from '@/components/dashboard/trends/trend-config-form';

export const metadata: Metadata = { title: 'Trend sources' };

export default async function TrendSettingsPage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  // Seed smart defaults on first visit (best-effort; never blocks the page).
  const company = await getCompanyById(active.id);
  if (company) {
    await seedSmartDefaults(company).catch(() => undefined);
  }
  const config = await ensureTrendConfig(active.id);

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
          title="Trend sources"
          description="Tune what your daily AI Trend Insights digest watches."
        />
      </div>

      <TrendConfigForm
        initial={{
          keywords: config.keywords,
          subreddits: config.subreddits,
          rssFeeds: config.rssFeeds,
          competitorNames: config.competitorNames,
          enabledSources: getEnabledFlags(config) as {
            reddit: boolean;
            hackernews: boolean;
            news: boolean;
            twitter: boolean;
          },
          geoCountry: config.geoCountry ?? '',
          geoRegion: config.geoRegion ?? '',
          geoCity: config.geoCity ?? '',
          language: config.language ?? 'en',
          timeRangeDays: config.timeRangeDays ?? 4,
        }}
      />
    </div>
  );
}
