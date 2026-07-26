import { getJson } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { DiscoveryCriteria } from '@/server/leads/discovery/types';

/**
 * GitHub company discovery (Sprint 5). Uses the official Search API to find
 * ORGANIZATIONS matching the target keywords/industries (a strong proxy for
 * dev-tool/AI companies), and reads each org's public website so the
 * company-site source can then find named founders/execs. Keyless (10 req/min)
 * or GITHUB_TOKEN for more.
 */
export interface DiscoveredCompany {
  name: string;
  website?: string;
  sourceUrl: string;
  description?: string;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'BotellaAuraBot/0.1 (+https://botella.ai/bot)',
  };
  if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

interface GhOrgHit {
  login: string;
  html_url: string;
}
interface GhOrg {
  name: string | null;
  blog: string | null;
  bio: string | null;
  html_url: string;
}

export async function discoverGitHubCompanies(
  criteria: DiscoveryCriteria,
): Promise<{ companies: DiscoveredCompany[]; skipped?: string }> {
  const terms = [...criteria.keywords, ...criteria.industries].slice(0, 3);
  if (terms.length === 0) {
    return { companies: [], skipped: 'github: no keywords/industries to search' };
  }

  const seen = new Set<string>();
  const companies: DiscoveredCompany[] = [];

  for (const term of terms) {
    try {
      const search = await getJson<{ items?: GhOrgHit[] }>(
        `https://api.github.com/search/users?q=${encodeURIComponent(`${term} type:org`)}&per_page=5`,
        { headers: headers(), timeoutMs: 8000 },
      );
      for (const hit of search.items ?? []) {
        if (seen.has(hit.login) || companies.length >= 8) continue;
        seen.add(hit.login);
        try {
          const org = await getJson<GhOrg>(
            `https://api.github.com/users/${encodeURIComponent(hit.login)}`,
            { headers: headers(), timeoutMs: 8000 },
          );
          const website = normalizeWebsite(org.blog);
          companies.push({
            name: org.name || hit.login,
            website,
            sourceUrl: org.html_url,
            description: org.bio ?? undefined,
          });
        } catch {
          companies.push({ name: hit.login, sourceUrl: hit.html_url });
        }
      }
    } catch (err) {
      logger.info('discovery/github: search failed', {
        term,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { companies };
}

function normalizeWebsite(blog: string | null): string | undefined {
  if (!blog) return undefined;
  const v = blog.trim();
  if (!v) return undefined;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}
