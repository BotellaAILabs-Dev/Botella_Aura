import { getJson, HttpError } from '@/lib/http';
import { logger } from '@/lib/logger';
import type { GitHubSignal } from '@/server/competitors/types';

/**
 * GitHub public-activity source — a legitimate proxy for product movement of
 * AI/dev-tool competitors. Uses ONLY the official GitHub REST API. Works
 * unauthenticated (60 req/hr); set GITHUB_TOKEN to raise the limit to 5000/hr.
 */
const API = 'https://api.github.com';

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'BotellaAuraBot/0.1 (+https://botella.ai/bot)',
  };
  if (process.env.GITHUB_TOKEN) {
    h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return h;
}

interface GhUser {
  public_repos?: number;
  followers?: number;
}
interface GhRepo {
  name: string;
  html_url: string;
  pushed_at: string;
  stargazers_count: number;
}
interface GhRelease {
  name: string | null;
  tag_name: string;
  html_url: string;
  published_at: string;
}

/** Fetch a bounded snapshot of an org's public GitHub activity. Never throws. */
export async function fetchGitHubSignal(
  org: string,
): Promise<GitHubSignal | null> {
  try {
    const [user, repos] = await Promise.all([
      getJson<GhUser>(`${API}/users/${encodeURIComponent(org)}`, {
        headers: headers(),
        timeoutMs: 8000,
      }).catch(() => ({}) as GhUser),
      getJson<GhRepo[]>(
        `${API}/users/${encodeURIComponent(org)}/repos?sort=pushed&direction=desc&per_page=8`,
        { headers: headers(), timeoutMs: 8000 },
      ).catch(() => [] as GhRepo[]),
    ]);

    const recentlyPushed = repos.slice(0, 5).map((r) => ({
      repo: r.name,
      url: r.html_url,
      pushedAt: r.pushed_at,
      stars: r.stargazers_count,
    }));

    // Latest release of the most-recently-pushed repo (best product-movement signal).
    let latestRelease: GitHubSignal['latestRelease'] = null;
    const top = repos[0];
    if (top) {
      try {
        const rel = await getJson<GhRelease>(
          `${API}/repos/${encodeURIComponent(org)}/${encodeURIComponent(top.name)}/releases/latest`,
          { headers: headers(), timeoutMs: 8000 },
        );
        latestRelease = {
          repo: top.name,
          name: rel.name || rel.tag_name,
          tagName: rel.tag_name,
          url: rel.html_url,
          publishedAt: rel.published_at,
        };
      } catch (err) {
        // 404 = repo has no releases; ignore quietly.
        if (!(err instanceof HttpError && err.status === 404)) {
          logger.info('competitors/github: release lookup failed', {
            org,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (
      user.public_repos == null &&
      user.followers == null &&
      recentlyPushed.length === 0
    ) {
      return null; // org not found / nothing public
    }

    return {
      org,
      publicRepos: user.public_repos,
      followers: user.followers,
      latestRelease,
      recentlyPushed,
    };
  } catch (err) {
    logger.warn('competitors/github: fetch failed', {
      org,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
