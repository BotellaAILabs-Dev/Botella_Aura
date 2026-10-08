import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Recommendation security, statically — the application-level equivalent of
 * row-level security (docs/DATA-ACCESS-SECURITY.md §1):
 *
 *   ROW SCOPING   every database call on Recommendation, RecommendationEvent
 *                 and RecommendationEvidence is confined to one workspace:
 *                 filtered by companyId (directly, or through its
 *                 recommendation or opportunity), or aimed at the `.id` of a
 *                 row already loaded under that filter, or creating a row
 *                 whose data carries the workspace / a verified parent. An id
 *                 taken from a request is never used on its own.
 *   ROUTES        every recommendation route resolves the caller's own
 *                 workspace; every write checks the role, and the stronger
 *                 one for decisions (company:update — owners and admins).
 *
 * Runs over the real source, so a new query or route that forgets either
 * fails here. The HTTP-level proof is scripts/verify-recommendation-security.ts.
 */

const ROOT = process.cwd();

function files(dir: string, ext = '.ts'): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(ext)) out.push(p);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

/** The argument text of the call starting at `open` (index of "("). */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

interface Call {
  file: string;
  line: number;
  model: string;
  op: string;
  args: string;
}

const CALL =
  /\b(db|tx)\.(recommendation|recommendationEvent|recommendationEvidence)\.(\w+)\(/g;

const calls: Call[] = [
  ...files('server'),
  ...files('lib'),
  ...files('app'),
].flatMap((file) => {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(CALL)].map((m) => ({
    file: relative(ROOT, file).replace(/\\/g, '/'),
    line: src.slice(0, m.index).split('\n').length,
    model: m[2]!,
    op: m[3]!,
    args: callArgs(src, m.index! + m[0].length - 1),
  }));
});

/** Why a call is confined to one workspace, or null if it is not. */
function scopedBy(c: Call): string | null {
  const a = c.args;
  // Filtered by the workspace, directly or through a parent row.
  if (/\bcompanyId\b/.test(a)) return 'companyId';
  if (/recommendation:\s*\{[^}]*companyId/.test(a))
    return 'recommendation.companyId';
  if (/opportunity:\s*\{[^}]*companyId/.test(a)) return 'opportunity.companyId';
  // Aimed at a row already loaded under a workspace filter: `id: current.id`,
  // `recommendationId: r.id`, `id: { in: ranked.map((r) => r.id) }`. A raw
  // request id (`params.id`, `input.x`, `args.recommendationId`) is not this.
  const target =
    /\b(id|recommendationId|opportunityId)\s*:\s*(\{[^}]*\}|[^,}\n]+)/.exec(a);
  if (
    target &&
    /\b[a-z]\w*\.id\b/.test(target[2]!) &&
    !/\b(params|input|body|args|req)\.id\b/.test(target[2]!)
  ) {
    return 'loaded row';
  }
  return null;
}

/**
 * Calls whose id is verified by the caller before they run, with where that
 * happens — reviewed by hand; listed here so a new one cannot slip in.
 */
const REVIEWED: Record<string, string> = {
  // Mirrors an opportunity's decision: transitionOpportunity has already
  // loaded the opportunity under `companyId` (opportunity.service.ts).
  'server/opportunities/opportunity.service.ts:recommendation.findMany':
    'opportunity verified by transitionOpportunity',
};

describe('the scoping detector itself', () => {
  const call = (args: string): Call => ({
    file: 'x.ts',
    line: 1,
    model: 'recommendation',
    op: 'findFirst',
    args,
  });
  it('rejects a query on an id straight from the request', () => {
    expect(scopedBy(call('{ where: { id: params.id } }'))).toBeNull();
    expect(
      scopedBy(call('{ where: { id: args.recommendationId } }')),
    ).toBeNull();
    expect(scopedBy(call('{ where: { id: input.id } }'))).toBeNull();
  });
  it('rejects an unfiltered query', () => {
    expect(scopedBy(call("{ where: { status: 'GENERATED' } }"))).toBeNull();
    expect(scopedBy(call('{}'))).toBeNull();
  });
  it('accepts workspace filters and rows already loaded under one', () => {
    expect(scopedBy(call('{ where: { id, companyId } }'))).toBe('companyId');
    // Accepted (the plain companyId rule catches it first).
    expect(
      scopedBy(call('{ where: { recommendation: { companyId } } }')),
    ).not.toBeNull();
    expect(scopedBy(call('{ where: { id: current.id } }'))).toBe('loaded row');
  });
});

describe('row scoping: every recommendation query stays in one workspace', () => {
  it('finds the calls it guards', () => {
    expect(calls.length).toBeGreaterThan(30);
  });

  for (const c of calls) {
    it(`${c.file}:${c.line} ${c.model}.${c.op}`, () => {
      const why =
        scopedBy(c) ?? REVIEWED[`${c.file}:${c.model}.${c.op}`] ?? null;
      expect(
        why,
        `not confined to a workspace:\n${c.args.slice(0, 300)}`,
      ).not.toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const ROUTES = [
  ...files('app/api/recommendations'),
  ...files('app/api/opportunities').filter((f) =>
    /recommendations|handoff/.test(f),
  ),
].filter((f) => f.endsWith('route.ts'));

function handler(src: string, method: string): string | null {
  const start = src.indexOf(`export async function ${method}`);
  if (start === -1) return null;
  const next = src.indexOf('export ', start + 10);
  return src.slice(start, next === -1 ? undefined : next);
}

/** Writes anyone in the workspace who can create content may make. */
const CONTENT_CREATE_WRITES = new Set([
  'app/api/recommendations/presented/route.ts',
]);

describe('routes: own workspace, and the right role to change anything', () => {
  it('covers every recommendation route', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(15);
  });

  for (const file of ROUTES) {
    const name = relative(ROOT, file).replace(/\\/g, '/');
    const src = readFileSync(file, 'utf8');
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const fn = handler(src, method);
      if (!fn) continue;

      it(`${method} ${name} resolves the caller's own workspace, never one from the request`, () => {
        expect(fn).toMatch(/requireActiveCompany\(\)|requireCompanyRole\(/);
        expect(fn).not.toMatch(
          /companyId:\s*(body|input|params|searchParams|query)\./,
        );
      });

      if (method !== 'GET') {
        const need = CONTENT_CREATE_WRITES.has(name)
          ? 'content:create'
          : 'company:update';
        it(`${method} ${name} requires ${need}`, () => {
          expect(fn).toContain(`can(membership.role, '${need}')`);
        });
      }
    }
  }

  it('an id from the URL reaches services only next to the caller’s workspace', () => {
    for (const file of ROUTES) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\b(\w+)\(([^()]*params\.id[^()]*)\)/g)) {
        expect(m[2], `${relative(ROOT, file)}: ${m[0]}`).toMatch(/company\.id/);
      }
    }
  });
});
