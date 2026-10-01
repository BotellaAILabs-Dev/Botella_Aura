/**
 * Proves no business information is lost on the way into the Business Context
 * layer, against a real database.
 *
 * For every workspace, each stored business value that has data is checked
 * against the resolved context: reachable, superseded by a higher-precedence
 * source (and recorded as a conflict), intentionally unmapped (with the
 * reason), or LOST. Any LOST value fails the run.
 *
 * Run: pnpm verify:context-sources
 *
 * Read-only: it writes nothing.
 */
import { db } from '@/lib/db';
import {
  auditContextCoverage,
  INTENTIONALLY_UNMAPPED_TABLES,
} from '@/server/business-context/coverage';

async function main() {
  const companies = await db.company.findMany({
    select: { id: true, name: true },
  });
  let lost = 0;

  for (const company of companies) {
    const report = await auditContextCoverage(company.id);
    if (!report) continue;
    console.log(`\n${company.name} (${company.id})`);
    for (const c of report.checks) {
      const tag = c.status === 'lost' ? 'LOST       ' : c.status.padEnd(11);
      console.log(`  ${tag} ${c.source}.${c.field} → ${c.detail}`);
    }
    lost += report.lost.length;
  }

  console.log('\nTables intentionally not mapped into business context:');
  for (const [table, why] of Object.entries(INTENTIONALLY_UNMAPPED_TABLES)) {
    console.log(`  ${table}: ${why}`);
  }

  console.log(
    `\n${companies.length} workspace(s) checked — ${lost === 0 ? 'no business information lost.' : `${lost} value(s) LOST.`}`,
  );
  if (lost > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
