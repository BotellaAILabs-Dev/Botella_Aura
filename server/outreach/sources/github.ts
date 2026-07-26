import { getJson } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { RawSignal } from '@/server/outreach/types';

/**
 * GitHub signal source — surfaces orgs with recent public repo activity that
 * matches the target keywords (a proxy for technical companies worth reaching).
 * Official GitHub Search API only; keyless (10 req/min) or GITHUB_TOKEN for more.
 */
interface GhSearchRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  owner: { login: string; type: string };
  pushed_at: string;
  stargazers_count: number;
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

export async function githubSignals(terms: string[]): Promise<RawSignal[]> {
  const queries = terms.slice(0, 3);
  const out: RawSignal[] = [];
  for (const term of queries) {
    try {
      const data = await getJson<{ items?: GhSearchRepo[] }>(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(
          `${term} in:name,description,topics`,
        )}&sort=updated&order=desc&per_page=5`,
        { headers: headers(), timeoutMs: 8000 },
      );
      for (const repo of data.items ?? []) {
        // Prefer organizations (real companies) over individual users.
        if (repo.owner.type !== 'Organization') continue;
        out.push({
          signalType: 'GITHUB_ACTIVITY',
          companyName: repo.owner.login,
          description: `${repo.full_name} — ${repo.description ?? 'active public repo'} (${repo.stargazers_count}★)`,
          sourceUrl: repo.html_url,
          matchedTerms: [],
        });
      }
    } catch (err) {
      logger.info('outreach/github: search failed', {
        term,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
