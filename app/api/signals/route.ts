import { z } from 'zod';

import { requireActiveCompany } from '@/lib/auth-helpers';
import { handleRouteError, jsonOk } from '@/lib/api';
import { SIGNAL_RELIABILITIES, SIGNAL_SOURCES } from '@/lib/signals';
import { listSignals } from '@/server/signals/signal.service';

/**
 * GET /api/signals?source=TRENDS,COMPETITORS&min=MEDIUM&relevant=1&limit=100
 *
 * Normalised signals from every Aura source, newest first. Expired ones are
 * left out unless `expired=1`.
 */
export const dynamic = 'force-dynamic';

const flag = z
  .enum(['1', '0', 'true', 'false'])
  .optional()
  .transform((v) => v === '1' || v === 'true');

const querySchema = z.object({
  source: z
    .string()
    .optional()
    .transform((v) =>
      v ? v.split(',').map((s) => s.trim().toUpperCase()) : undefined,
    )
    .pipe(z.array(z.enum(SIGNAL_SOURCES)).optional()),
  min: z.enum(SIGNAL_RELIABILITIES).optional(),
  relevant: flag,
  expired: flag,
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export async function GET(req: Request) {
  try {
    const { company } = await requireActiveCompany();
    const q = querySchema.parse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    const signals = await listSignals(company.id, {
      sources: q.source,
      minReliability: q.min,
      relevantOnly: q.relevant,
      includeExpired: q.expired,
      limit: q.limit,
    });
    return jsonOk({ signals });
  } catch (error) {
    return handleRouteError(error);
  }
}
