import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';

import { signalInputSchema } from '@/lib/opportunities';
import { isWebUrl, safeExternalUrl } from '@/lib/safe-url';

/**
 * Data-access security guards that run with the unit tests.
 *
 * Postgres row-level security is not in use: the app connects as one role
 * and isolation is enforced in the application (docs/DATA-ACCESS-SECURITY.md).
 * So every route that touches business context, signals, opportunities or
 * recommendations must (1) resolve the caller's workspace from their own
 * memberships, (2) check their role before any write, and (3) scope every
 * query to that workspace. (1) and (2) are checked here statically for every
 * such route, including ones added later; (3) and the end-to-end behaviour are
 * proven against a running app by `pnpm verify:access`.
 */

const ROOT = join(__dirname, '..');
const SCOPED_DIRS = [
  'app/api/business-context',
  'app/api/opportunities',
  'app/api/recommendations',
  'app/api/signals',
  'app/api/advisor',
  'app/api/company',
];

function routes(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === 'route.ts') out.push(p);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

const ALL = SCOPED_DIRS.flatMap(routes);
const handlers = (src: string) =>
  [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map(
    (m) => m[1]!,
  );
/** The body of one exported handler, up to the next export. */
function body(src: string, method: string): string {
  const start = src.indexOf(`export async function ${method}`);
  const next = src.indexOf('export ', start + 10);
  return src.slice(start, next === -1 ? undefined : next);
}

describe('API authorization (static)', () => {
  it('finds the routes it guards', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(15);
  });

  for (const file of ALL) {
    const src = readFileSync(file, 'utf8');
    const name = relative(ROOT, file).replace(/\\/g, '/');
    for (const method of handlers(src)) {
      const fn = body(src, method);

      it(`${method} ${name} resolves the caller's own workspace`, () => {
        // requireActiveCompany picks the workspace from the user's own
        // memberships; requireCompanyRole checks membership of an explicit id.
        expect(fn).toMatch(/require(ActiveCompany|CompanyRole)\(/);
        // Never a workspace id taken from the request itself.
        expect(fn).not.toMatch(
          /companyId:\s*(body|input|params|searchParams)\./,
        );
      });

      if (method !== 'GET') {
        it(`${method} ${name} checks the caller's role before writing`, () => {
          expect(fn).toMatch(/can\(membership\.role,|requireCompanyRole\(/);
        });
      }
    }
  }
});

describe('service lookups by id are scoped to the workspace', () => {
  // Every lookup of a record by an id that came from a URL must also match the
  // caller's companyId, so another business's id behaves like a missing one.
  const files = [
    'server/opportunities/opportunity.service.ts',
    'server/recommendations/recommendation.service.ts',
  ];
  for (const f of files) {
    it(f, () => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const byId = [
        ...src.matchAll(
          /\.(opportunity|recommendation)\.findFirst\(\{\s*where:\s*\{([^}]*)\}/g,
        ),
      ];
      expect(byId.length).toBeGreaterThan(0);
      for (const m of byId) expect(m[2]).toMatch(/companyId/);
    });
  }
});

describe('third-party links', () => {
  it('only http(s) URLs reach an href', () => {
    expect(safeExternalUrl('https://news.example/a?b=1')).toBe(
      'https://news.example/a?b=1',
    );
    expect(safeExternalUrl(' http://x.example ')).toBe('http://x.example/');
    for (const bad of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '//evil.example',
      'not a url',
      '',
      null,
      undefined,
    ]) {
      expect(safeExternalUrl(bad)).toBeNull();
    }
    expect(isWebUrl('mailto:a@b.c')).toBe(false);
  });

  it('opportunity evidence cannot store a non-web link', () => {
    const base = { kind: 'EXTERNAL' as const, label: 'x', detail: 'y' };
    expect(
      signalInputSchema.safeParse({ ...base, url: 'https://ok.example' })
        .success,
    ).toBe(true);
    expect(
      signalInputSchema.safeParse({ ...base, url: 'javascript:alert(1)' })
        .success,
    ).toBe(false);
  });
});
