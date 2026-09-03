/**
 * Load every dashboard page and report the ones that break.
 *
 * This exists because two pages were returning 500s in production and nothing
 * caught it — unit tests do not render pages, and the type checker cannot see
 * through a cast over a JSON column. The only thing that finds that class of
 * bug is actually loading the page against real data.
 *
 * Routes are DISCOVERED from the filesystem rather than listed here, so a page
 * added next month is covered without anyone remembering to add it. Dynamic
 * segments are filled from real rows in the database; a segment with no row to
 * use is reported as skipped rather than silently passing.
 *
 * Needs the app running (pnpm dev, or pnpm build && pnpm start).
 *
 * Run with:  pnpm verify:pages
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

try {
  process.loadEnvFile();
} catch {
  // .env is optional — vars may already be set in the shell.
}

import { db } from '@/lib/db';

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000';
const EMAIL = process.env.VERIFY_EMAIL ?? 'demo@botella.ai';
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'Password123';

/** The error boundary's copy — the tell that a server render blew up. */
const ERROR_MARKER = 'Something failed while building this view';

/** Every `page.tsx` under app/dashboard, as a route path. */
function discoverRoutes(dir: string, root: string): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      routes.push(...discoverRoutes(full, root));
    } else if (entry === 'page.tsx') {
      const rel = relative(root, dir).split(sep).filter(Boolean);
      routes.push(`/dashboard${rel.length ? `/${rel.join('/')}` : ''}`);
    }
  }
  return routes;
}

/**
 * Real ids for the `[param]` segments.
 *
 * Substituting a made-up id would exercise the not-found path rather than the
 * page, which is the opposite of useful.
 */
async function resolveParams(): Promise<Record<string, string | null>> {
  const [draft, lead, campaign] = await Promise.all([
    db.contentDraft.findFirst({ select: { id: true } }),
    db.lead.findFirst({ select: { id: true } }),
    db.campaign.findFirst({ select: { id: true } }),
  ]);
  return {
    // Which model a `[id]` means depends on the route, so it is keyed by route
    // prefix below rather than by the segment name alone.
    '/dashboard/content/[id]': draft?.id ?? null,
    '/dashboard/leads/[id]': lead?.id ?? null,
    '/dashboard/campaigns/[id]': campaign?.id ?? null,
  };
}

async function login(): Promise<string> {
  const cookies: string[] = [];
  const grab = (res: Response) => {
    for (const c of res.headers.getSetCookie?.() ?? []) cookies.push(c.split(';')[0]!);
  };

  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  if (!csrfRes.ok) {
    throw new Error(`Cannot reach ${BASE} — is the app running?`);
  }
  grab(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  grab(
    await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookies.join('; '),
      },
      body: new URLSearchParams({
        csrfToken,
        email: EMAIL,
        password: PASSWORD,
        callbackUrl: `${BASE}/dashboard`,
        json: 'true',
      }),
    }),
  );

  const cookie = cookies.join('; ');
  const session = (await (
    await fetch(`${BASE}/api/auth/session`, { headers: { cookie } })
  ).json()) as { user?: { email?: string } };
  if (!session.user?.email) {
    throw new Error(`Could not sign in as ${EMAIL}. Run pnpm db:seed:demo first.`);
  }
  return cookie;
}

async function main() {
  const root = join(process.cwd(), 'app', 'dashboard');
  const discovered = discoverRoutes(root, root).sort();
  const params = await resolveParams();

  const cookie = await login();
  console.log(`\nsigned in as ${EMAIL} · ${discovered.length} routes found\n`);

  let broken = 0;
  let skipped = 0;

  for (const route of discovered) {
    // Fill dynamic segments, or skip when there is no real row to use.
    let url = route;
    if (route.includes('[')) {
      const id = params[route];
      if (!id) {
        console.log(`  SKIP    ${route} — no row in the database to load`);
        skipped++;
        continue;
      }
      url = route.replace(/\[[^\]]+\]/, id);
    }

    try {
      const res = await fetch(`${BASE}${url}`, { headers: { cookie } });
      const body = await res.text();

      if (!res.ok) {
        console.error(`  FAIL    ${route} — HTTP ${res.status}`);
        broken++;
      } else if (body.includes(ERROR_MARKER)) {
        // A 200 that rendered the error boundary is still a broken page.
        console.error(`  FAIL    ${route} — rendered the error boundary`);
        broken++;
      } else {
        console.log(`  ok      ${route}`);
      }
    } catch (err) {
      console.error(
        `  FAIL    ${route} — ${err instanceof Error ? err.message : String(err)}`,
      );
      broken++;
    }
  }

  console.log(
    `\n${discovered.length - broken - skipped} ok · ${broken} broken · ${skipped} skipped`,
  );
  if (broken > 0) {
    console.error(
      '\nA broken page usually means a server render threw. Check the app log for\n' +
        'the stack trace — the production error page hides it behind a digest.',
    );
    process.exitCode = 1;
  }
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    await db.$disconnect();
  });
