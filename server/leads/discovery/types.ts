/**
 * Shared types for the Lead Discovery Engine (Sprint 5, Module 1).
 * Discovery is proactive: given criteria, actively query LEGITIMATE public
 * sources to build a lead list. No LinkedIn scraping — any LinkedIn URL is
 * either returned by an official API or left for the user to fill manually.
 */
import type { DiscoveryCriteriaInput } from '@/lib/validations/discovery';

export type DiscoveryCriteria = DiscoveryCriteriaInput;

/** A candidate lead produced by a source, before dedup + persistence. */
export interface DiscoveredLead {
  /** Person name, when a source legitimately provides it (else undefined). */
  name?: string;
  title?: string;
  companyName: string;
  sourceUrl?: string;
  /** The public page/URL that evidences this lead (for the rationale + audit). */
  evidence?: string;
  /** Which source produced it (for the run summary). */
  via: string;
}

/** A source's result, including honest "unavailable" reporting. */
export interface SourceResult {
  leads: DiscoveredLead[];
  /** Non-empty when the source was skipped/unavailable (transparency). */
  skipped?: string;
}
