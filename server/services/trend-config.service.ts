import type { Company, CompanyTrendConfig } from '@prisma/client';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import {
  completeJson,
  isClaudeConfigured,
  getModel,
} from '@/server/ai/claude';
import type { EnabledSourcesFlags } from '@/server/trends/sources';
import type { TrendFetchContext } from '@/server/trends/types';
import type { UpdateTrendConfigInput } from '@/lib/validations/trends';
import {
  businessContextToPrompt,
  getBusinessContext,
} from '@/server/business-context/business-context.service';

const DEFAULT_ENABLED: EnabledSourcesFlags = {
  reddit: true,
  hackernews: true,
  news: true,
  twitter: false,
};

/** Create the config row on first access (empty; defaults seeded separately). */
export async function ensureTrendConfig(
  companyId: string,
): Promise<CompanyTrendConfig> {
  const existing = await db.companyTrendConfig.findUnique({
    where: { companyId },
  });
  if (existing) return existing;
  return db.companyTrendConfig.create({
    data: { companyId, enabledSources: DEFAULT_ENABLED },
  });
}

export async function getTrendConfig(companyId: string) {
  return db.companyTrendConfig.findUnique({ where: { companyId } });
}

/** Convert a stored config into the context passed to trend sources. */
export function toFetchContext(config: CompanyTrendConfig): TrendFetchContext {
  return {
    keywords: config.keywords,
    subreddits: config.subreddits,
    rssFeeds: config.rssFeeds,
    competitorNames: config.competitorNames,
    country: config.geoCountry,
    region: config.geoRegion,
    city: config.geoCity,
    language: config.language,
    timeRangeDays: config.timeRangeDays,
  };
}

export function getEnabledFlags(config: CompanyTrendConfig): EnabledSourcesFlags {
  const raw = config.enabledSources as Record<string, unknown> | null;
  return {
    reddit: raw?.reddit !== false,
    hackernews: raw?.hackernews !== false,
    news: raw?.news !== false,
    twitter: raw?.twitter === true,
  };
}

interface UpdateArgs {
  companyId: string;
  userId: string;
  input: UpdateTrendConfigInput;
  requestMeta?: { ipAddress?: string | null; userAgent?: string | null };
}

export async function updateTrendConfig({
  companyId,
  userId,
  input,
  requestMeta,
}: UpdateArgs) {
  const geo = {
    geoCountry: input.geoCountry ?? null,
    geoRegion: input.geoRegion ?? null,
    geoCity: input.geoCity ?? null,
    language: input.language,
    timeRangeDays: input.timeRangeDays,
  };
  const config = await db.companyTrendConfig.upsert({
    where: { companyId },
    create: {
      companyId,
      keywords: input.keywords,
      subreddits: input.subreddits,
      rssFeeds: input.rssFeeds,
      competitorNames: input.competitorNames,
      enabledSources: input.enabledSources,
      ...geo,
      defaultsSeeded: true, // user edited it — treat as intentional
    },
    update: {
      keywords: input.keywords,
      subreddits: input.subreddits,
      rssFeeds: input.rssFeeds,
      competitorNames: input.competitorNames,
      enabledSources: input.enabledSources,
      ...geo,
      defaultsSeeded: true,
    },
  });

  await recordAudit({
    action: 'TREND_CONFIG_UPDATED',
    userId,
    companyId,
    metadata: {
      keywords: input.keywords.length,
      subreddits: input.subreddits.length,
    },
    ...requestMeta,
  });

  return config;
}

// ---------------------------------------------------------------------------
// Smart defaults — a one-time suggestion from onboarding data.
// ---------------------------------------------------------------------------

interface SmartDefaults {
  keywords: string[];
  subreddits: string[];
  competitorNames: string[];
}

/**
 * Generate starter keywords/subreddits/competitors from the company's industry
 * and brand voice. Uses Claude when configured; otherwise a deterministic
 * heuristic so onboarding still produces a usable config. Idempotent: only runs
 * when `defaultsSeeded` is false, and never overwrites user edits.
 */
export async function seedSmartDefaults(
  company: Pick<Company, 'id' | 'name' | 'industry'>,
): Promise<CompanyTrendConfig> {
  const config = await ensureTrendConfig(company.id);
  if (config.defaultsSeeded) return config;

  let defaults: SmartDefaults;
  let source = 'heuristic';
  if (isClaudeConfigured()) {
    try {
      defaults = await generateDefaultsWithClaude(company);
      source = getModel();
    } catch (err) {
      logger.warn('seedSmartDefaults: Claude failed, using heuristic', {
        error: err instanceof Error ? err.message : String(err),
      });
      defaults = heuristicDefaults(company);
    }
  } else {
    defaults = heuristicDefaults(company);
  }

  const updated = await db.companyTrendConfig.update({
    where: { companyId: company.id },
    data: {
      keywords: dedupeStrings(defaults.keywords).slice(0, 15),
      subreddits: dedupeStrings(defaults.subreddits.map(cleanSubreddit)).slice(0, 10),
      competitorNames: dedupeStrings(defaults.competitorNames).slice(0, 10),
      defaultsSeeded: true,
    },
  });

  await recordAudit({
    action: 'AI_SUGGESTION_GENERATED',
    companyId: company.id,
    metadata: { kind: 'trend_defaults', source },
  });

  return updated;
}

async function generateDefaultsWithClaude(
  company: Pick<Company, 'id' | 'name' | 'industry'>,
): Promise<SmartDefaults> {
  /**
   * What the business does and who buys from it, from the Business Context
   * layer.
   *
   * This used to send the name, the industry label and the brand-VOICE notes
   * — tone, not substance — so the model guessed keywords and competitors for
   * "a company in an industry". Those guesses are stored and labelled
   * AI-derived until a person reviews them, so grounding them in the real
   * description makes fewer of them wrong in the first place.
   */
  const context = await getBusinessContext(company.id, { sections: ['targeting'] });
  const about = businessContextToPrompt(context, 'qualification');
  const system =
    'You are a B2B marketing strategist configuring a trend-monitoring tool. ' +
    'Given a company profile, suggest what to monitor. Respond with ONLY a JSON ' +
    'object, no prose.';
  const prompt = [
    `Company: ${company.name}`,
    `Industry: ${company.industry ?? 'unknown'}`,
    about,
    '',
    'Return JSON of this exact shape:',
    '{',
    '  "keywords": [8-12 topical phrases this company should monitor],',
    '  "subreddits": [4-8 relevant subreddit names, WITHOUT the "r/" prefix],',
    '  "competitorNames": [0-5 likely competitor names, or [] if unsure]',
    '}',
  ].join('\n');

  return completeJson<SmartDefaults>({
    system,
    prompt,
    maxTokens: 1024,
    effort: 'medium',
    tier: 'standard',
  });
}

/** Deterministic fallback so onboarding always yields a non-empty config. */
function heuristicDefaults(
  company: Pick<Company, 'name' | 'industry'>,
): SmartDefaults {
  const industry = (company.industry ?? '').trim();
  const keywords = [industry, company.name.trim(), 'marketing', 'AI']
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    keywords: Array.from(new Set(keywords)),
    subreddits: ['marketing', 'smallbusiness', 'Entrepreneur', 'SaaS'],
    competitorNames: [],
  };
}

function cleanSubreddit(s: string): string {
  return s.replace(/^\/?r\//i, '').trim();
}
function dedupeStrings(arr: string[]): string[] {
  return Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
}
