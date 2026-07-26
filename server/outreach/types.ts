import type { SignalType } from '@prisma/client';

/**
 * A normalized public signal produced by an outreach source before it is
 * persisted as a Lead + LeadSignal. Company-granularity — a person's identity
 * is added/confirmed by the user, never scraped.
 */
export interface RawSignal {
  signalType: SignalType;
  companyName: string;
  description: string;
  sourceUrl?: string;
  /** Config terms this signal matched (for transparency + scoring). */
  matchedTerms: string[];
}

/** Config shape used by matching + sources (subset of OutreachConfig). */
export interface OutreachCriteria {
  industries: string[];
  roleTitles: string[];
  companyStages: string[];
  enabledSources: {
    crunchbase: boolean;
    github: boolean;
    jobs: boolean;
    news: boolean;
  };
}
