import { z } from 'zod';
import { politeFetchHtml } from '@/server/knowledge/robots';
import { htmlToText } from '@/server/knowledge/extract';
import {
  completeStructured,
  isClaudeConfigured,
} from '@/server/ai/claude';
import { logger } from '@/lib/logger';
import type { DiscoveredLead } from '@/server/leads/discovery/types';

/**
 * Company-website people discovery (Sprint 5). Given a company + its public
 * website, does a robots.txt-respecting fetch of common Team/About/Leadership
 * pages (never behind login, never LinkedIn) and uses Claude to extract named
 * founders/execs. If Claude isn't configured we return the company-level lead
 * only — we never invent names.
 */
const TEAM_PATHS = ['/team', '/about', '/about-us', '/leadership', '/company', '/people'];
const MAX_TEXT = 8000;

const peopleSchema = z.object({
  people: z
    .array(z.object({ name: z.string(), title: z.string().optional() }))
    .max(12),
});

export async function discoverPeopleFromSite(
  companyName: string,
  website: string,
): Promise<DiscoveredLead[]> {
  let base: URL;
  try {
    base = new URL(website);
  } catch {
    return [];
  }

  // Fetch a couple of likely team pages (robots-gated, throttled).
  let text = '';
  let pageUrl = website;
  for (const path of TEAM_PATHS) {
    const url = new URL(path, base.origin).toString();
    const html = await politeFetchHtml(url);
    if (html) {
      const extracted = htmlToText(html).text.trim();
      if (extracted.length > 200) {
        text = extracted.slice(0, MAX_TEXT);
        pageUrl = url;
        break;
      }
    }
  }
  if (!text || !isClaudeConfigured()) return [];

  try {
    const result = await completeStructured({
      schema: peopleSchema,
      system:
        'Extract ONLY real named founders/executives/leaders explicitly listed ' +
        'on this company page, with their titles. Do NOT invent anyone. If none ' +
        'are clearly named, return an empty array. Respond with ONLY JSON: ' +
        '{"people":[{"name","title"}]}.',
      prompt: `Company: ${companyName}\nPage text:\n"""\n${text}\n"""`,
      maxTokens: 600,
      effort: 'low',
    });
    return result.people
      .filter((p) => p.name && p.name.trim().length > 1)
      .map((p) => ({
        name: p.name.trim(),
        title: p.title?.trim() || undefined,
        companyName,
        sourceUrl: pageUrl,
        evidence: `Listed on ${companyName}'s public team page`,
        via: 'company-site',
      }));
  } catch (err) {
    logger.info('discovery/company-site: extraction failed', {
      companyName,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
