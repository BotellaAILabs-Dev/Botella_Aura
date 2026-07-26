import { db } from '@/lib/db';
import { recordAudit } from '@/server/services/audit.service';
import type { OutreachConfigInput } from '@/lib/validations/outreach';
import type { OutreachCriteria } from '@/server/outreach/types';

const DEFAULT_SOURCES = { crunchbase: false, github: true, jobs: true, news: true };

/** Load or lazily create the company's outreach config (1:1). */
export async function ensureOutreachConfig(companyId: string) {
  const existing = await db.outreachConfig.findUnique({ where: { companyId } });
  if (existing) return existing;
  return db.outreachConfig.create({ data: { companyId } });
}

/** Convert a persisted config row into the criteria shape sources/matching use. */
export function toCriteria(config: {
  industries: string[];
  roleTitles: string[];
  companyStages: string[];
  enabledSources: unknown;
}): OutreachCriteria {
  const es = (config.enabledSources ?? {}) as Partial<
    OutreachCriteria['enabledSources']
  >;
  return {
    industries: config.industries,
    roleTitles: config.roleTitles,
    companyStages: config.companyStages,
    enabledSources: { ...DEFAULT_SOURCES, ...es },
  };
}

export async function updateOutreachConfig(args: {
  companyId: string;
  userId: string;
  input: OutreachConfigInput;
  requestMeta?: { ipAddress?: string | null; userAgent?: string | null };
}) {
  const { companyId, userId, input, requestMeta } = args;
  const config = await db.outreachConfig.upsert({
    where: { companyId },
    create: {
      companyId,
      industries: input.industries,
      roleTitles: input.roleTitles,
      companyStages: input.companyStages,
      enabledSources: input.enabledSources,
    },
    update: {
      industries: input.industries,
      roleTitles: input.roleTitles,
      companyStages: input.companyStages,
      enabledSources: input.enabledSources,
    },
  });
  await recordAudit({
    action: 'OUTREACH_CONFIG_UPDATED',
    userId,
    companyId,
    metadata: { enabledSources: input.enabledSources },
    ...requestMeta,
  });
  return config;
}
