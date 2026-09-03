import type { MaterialCategory } from '@prisma/client';

import { db } from '@/lib/db';
import { MATERIAL_CATEGORIES, type MaterialCategoryDef } from '@/lib/materials';

/**
 * Which kinds of business material Aura has, and which it is missing.
 *
 * "Add more documents" is not an instruction anyone can act on — it does not
 * say what is missing or why it would matter. Naming the specific gap does:
 * "Aura has never seen what makes you different" tells a marketer both what to
 * find and what they get back for finding it.
 *
 * Counted from chunks rather than sources so the number reflects what is
 * actually retrievable. A source row that ingested zero readable chunks (a
 * JavaScript-rendered site, an image-only PDF) is not coverage, and reporting
 * it as such would be the worst kind of dishonest progress bar.
 */
export interface MaterialCoverage {
  category: MaterialCategoryDef;
  chunks: number;
  present: boolean;
}

export interface CoverageReport {
  items: MaterialCoverage[];
  /** Categories with nothing, worth prompting for — highest value first. */
  missing: MaterialCategoryDef[];
  covered: number;
  total: number;
  /**
   * Material ingested before categories existed, or crawled from a website.
   * Still used for generation; it just cannot be attributed to a kind.
   */
  uncategorisedChunks: number;
}

/** The kinds worth actively asking for. OTHER is a fallback, not a goal. */
const PROMPTED = MATERIAL_CATEGORIES.filter((c) => c.id !== 'OTHER');

export async function getMaterialCoverage(companyId: string): Promise<CoverageReport> {
  const groups = await db.knowledgeChunk.groupBy({
    by: ['category'],
    where: { companyId },
    _count: { _all: true },
  });

  const counts = new Map<MaterialCategory | null, number>();
  for (const g of groups) counts.set(g.category, g._count._all);

  const items = PROMPTED.map((category) => {
    const chunks = counts.get(category.id) ?? 0;
    return { category, chunks, present: chunks > 0 };
  });

  return {
    items,
    // Already ordered by weight in MATERIAL_CATEGORIES, so the first gap
    // suggested is the one that would improve the writing most.
    missing: items.filter((i) => !i.present).map((i) => i.category),
    covered: items.filter((i) => i.present).length,
    total: items.length,
    uncategorisedChunks: counts.get(null) ?? 0,
  };
}
