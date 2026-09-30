import {
  capConfidence,
  CONFIDENCE_RANK,
  CONTEXT_FIELDS,
  contextField,
  freshnessOf,
  FRESHNESS_RULES,
  SOURCE_TYPE_INFO,
  storedFactMetaSchema,
  type BusinessContext,
  type BusinessFact,
  type ConfidenceLevel,
  type ContextFieldPath,
  type ContextIssue,
  type ContextSource,
  type SourceType,
  type StoredFactMeta,
} from '@/lib/business-context';
import type { BusinessContextSources } from './build';

/**
 * Source, confidence and freshness for every business fact.
 *
 * Pure. Runs after the builder has resolved every field, and answers three
 * questions about each value that won:
 *
 *   WHERE FROM  — which table (`source`) and what kind of origin
 *                 (`sourceType`): typed by a person, read from a connected
 *                 account, learned from data, or suggested by a model.
 *   HOW SURE    — `confidence`, and `trusted`: whether Aura may state it as a
 *                 fact about the business. AI-derived values are never
 *                 trusted until a person confirms them, and a value borrowed
 *                 from a fallback source is capped at medium.
 *   HOW CURRENT — `capturedAt`, `ageDays` and `freshness` against the field's
 *                 rule in FRESHNESS_RULES.
 *
 * Dates come from `preferences.factMeta` (written by the Business Context
 * write service) for workspace fields, and from each source table's own
 * timestamps for everything else.
 */

const DAY_MS = 86_400_000;

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function newest(dates: (string | Date | null | undefined)[]): string | null {
  let best: number | null = null;
  for (const d of dates) {
    if (!d) continue;
    const t = typeof d === 'string' ? Date.parse(d) : d.getTime();
    if (!Number.isNaN(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

/** The capture metadata the write service stored, dropping anything unreadable. */
export function readStoredFactMeta(
  preferences: unknown,
): Record<string, StoredFactMeta> {
  const bag =
    preferences &&
    typeof preferences === 'object' &&
    !Array.isArray(preferences)
      ? (preferences as Record<string, unknown>).factMeta
      : undefined;
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return {};
  const out: Record<string, StoredFactMeta> = {};
  for (const [key, value] of Object.entries(bag)) {
    const parsed = storedFactMetaSchema.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

/**
 * Whether the trend settings were written by a person.
 *
 * Seeding fills keywords and competitor names from a model's guess; only a
 * TREND_CONFIG_UPDATED by a user turns them into the business's own list.
 */
export function trendSourceType(
  market: BusinessContextSources['market'],
): SourceType {
  if (market?.trendEditedByUser) return 'user_provided';
  if (market?.trendConfig?.defaultsSeeded) return 'ai_derived';
  return 'user_provided';
}

interface Origin {
  sourceType: SourceType;
  capturedAt: string | null;
  /** Hard ceiling on confidence, e.g. from the source's own evidence strength. */
  cap?: ConfidenceLevel;
  note?: string;
  /** The value's scope has ended, whatever its age (a past month's plan). */
  expired?: boolean;
}

/** Stored metadata for a workspace field; legacy values default to user-provided. */
function fromStored(
  stored: Record<string, StoredFactMeta>,
  keys: string[],
  fallback: SourceType = 'user_provided',
): Origin {
  const found = keys
    .map((k) => stored[k])
    .filter((m): m is StoredFactMeta => Boolean(m));
  if (found.length === 0) {
    return {
      sourceType: fallback,
      capturedAt: null,
      note: 'Saved before capture dates were recorded.',
    };
  }
  // Several keys (brand colours): the least trusted wins, the newest date wins.
  const weakest = found.reduce((a, b) =>
    CONFIDENCE_RANK[SOURCE_TYPE_INFO[a.sourceType].confidence] <=
    CONFIDENCE_RANK[SOURCE_TYPE_INFO[b.sourceType].confidence]
      ? a
      : b,
  );
  return {
    sourceType: weakest.sourceType,
    capturedAt: newest(found.map((m) => m.confirmedAt ?? m.capturedAt)),
  };
}

/** The origin of a field's winning value. */
function originOf(
  path: ContextFieldPath,
  winner: ContextSource,
  ctx: BusinessContext,
  src: BusinessContextSources,
  stored: Record<string, StoredFactMeta>,
  now: Date,
): Origin {
  switch (winner) {
    case 'workspace_profile':
      return path === 'identity.visual'
        ? fromStored(
            stored,
            Object.keys(stored).filter((k) => k.startsWith('identity.visual.')),
          )
        : fromStored(stored, [path]);

    case 'brand_voice_profile':
      // Every profile starts as a model's draft. It becomes the business's
      // own voice only once a person saves or confirms it.
      return fromStored(stored, ['voice.profile'], 'ai_derived');

    case 'onboarding_notes':
      return fromStored(stored, ['voice.notes']);

    case 'marketing_plan': {
      const month = src.plan?.month;
      const ended = month
        ? new Date(
            Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1),
          ) <= now
        : false;
      return {
        sourceType: 'user_provided',
        capturedAt: iso(src.plan?.updatedAt),
        cap: 'medium',
        note: ended
          ? "Taken from a past month's plan because settings are empty."
          : "Taken from this month's plan because settings are empty.",
        expired: ended,
      };
    }

    case 'outreach_targeting':
    case 'discovery_profiles':
      return {
        sourceType: 'user_provided',
        capturedAt: newest([
          src.targeting?.outreach?.updatedAt,
          ...(src.targeting?.discoveryProfiles ?? []).map((p) => p.updatedAt),
        ]),
      };

    case 'competitor_profiles':
      return {
        sourceType: 'user_provided',
        capturedAt: newest(
          (src.market?.competitors ?? []).map((c) => c.updatedAt),
        ),
      };

    case 'trend_config': {
      // The AI seeder only fills keywords, subreddits and competitor names;
      // location and language are only ever set by a person.
      const type =
        path === 'market.geo' ? 'user_provided' : trendSourceType(src.market);
      return {
        sourceType: type,
        capturedAt: iso(src.market?.trendConfig?.updatedAt),
        note:
          type === 'ai_derived'
            ? 'Suggested by AI when trends were set up; nobody has reviewed it since.'
            : undefined,
      };
    }

    case 'connections':
      return {
        sourceType: 'connected_platform',
        capturedAt: iso(src.connections?.lastSyncedAt),
      };

    case 'knowledge_base': {
      if (path === 'identity.website') {
        return {
          sourceType: 'knowledge_base',
          capturedAt: null,
          cap: 'medium',
          note: 'Taken from the synced website because settings have none.',
        };
      }
      const rows = src.knowledge?.chunkCounts ?? [];
      const uploaded = rows.some(
        (r) => r.sourceType === 'UPLOAD' && r.chunks > 0,
      );
      return {
        sourceType: uploaded ? 'uploaded_document' : 'knowledge_base',
        capturedAt: newest(rows.map((r) => r.newestAt)),
      };
    }

    case 'marketing_memory': {
      // The field is as strong as its best insight; user-edited ones count as
      // confirmed. Each insight also carries its own confidence and freshness.
      const insights = ctx.memory.insights;
      const best: ConfidenceLevel = insights.some((i) => i.editedByUser)
        ? 'confirmed'
        : insights.some((i) => i.confidence === 'HIGH')
          ? 'high'
          : insights.some((i) => i.confidence === 'MEDIUM')
            ? 'medium'
            : 'low';
      return {
        sourceType: 'marketing_memory',
        capturedAt: newest(insights.map((i) => i.capturedAt)),
        cap: best,
      };
    }
  }
}

/** Build the fact record for every field that has a value. */
export function deriveFacts(
  ctx: BusinessContext,
  src: BusinessContextSources,
  now: Date,
): Record<string, BusinessFact> {
  const stored = readStoredFactMeta(src.company.preferences);
  const conflicted = new Set(
    ctx.meta.issues
      .filter((i) => i.kind === 'value_conflict')
      .map((i) => i.field),
  );
  const facts: Record<string, BusinessFact> = {};

  for (const field of CONTEXT_FIELDS) {
    const prov = ctx.meta.provenance[field.path];
    const winner = prov?.sources[0];
    if (!prov || !winner) continue;

    const origin = originOf(field.path, winner, ctx, src, stored, now);
    const info = SOURCE_TYPE_INFO[origin.sourceType];
    let confidence = info.confidence;
    if (origin.cap) confidence = capConfidence(confidence, origin.cap);
    // A value borrowed from a fallback source is evidence, not a statement.
    if (prov.inferred) confidence = capConfidence(confidence, 'medium');

    const ageDays = origin.capturedAt
      ? Math.max(
          0,
          Math.floor((now.getTime() - Date.parse(origin.capturedAt)) / DAY_MS),
        )
      : null;
    const freshness = origin.expired
      ? 'stale'
      : freshnessOf(ageDays, FRESHNESS_RULES[field.path].maxAgeDays);

    facts[field.path] = {
      source: winner,
      sourceType: origin.sourceType,
      confidence,
      trusted: info.trusted && !prov.inferred && confidence !== 'unverified',
      inferred: prov.inferred,
      capturedAt: origin.capturedAt,
      ageDays,
      freshness,
      conflicted: conflicted.has(field.path),
      ...(origin.note ? { note: origin.note } : {}),
    };
  }
  return facts;
}

/**
 * Issues for facts that are stale or unverified.
 *
 * Only fields that matter enough to be asked for (required or recommended),
 * plus AI-derived ones at any level — an unconfirmed guess should always be
 * visible, because it is exactly what must not be passed off as fact.
 */
export function factIssues(ctx: BusinessContext): ContextIssue[] {
  const issues: ContextIssue[] = [];
  for (const [path, fact] of Object.entries(ctx.meta.facts)) {
    const def = contextField(path as ContextFieldPath);
    const important = def.requirement !== 'optional';

    if (
      fact.freshness === 'stale' &&
      (important ||
        fact.sourceType === 'ai_derived' ||
        path === 'memory.insights')
    ) {
      const conflictNote = fact.conflicted
        ? ' Another source has a different value — check which is current.'
        : '';
      issues.push({
        field: path,
        kind: 'stale',
        severity: def.requirement === 'required' ? 'warning' : 'info',
        message: `${def.label} ${
          fact.note && fact.note.includes('past month')
            ? "comes from a past month's plan"
            : `was last updated ${fact.ageDays} days ago`
        } — ${FRESHNESS_RULES[path as ContextFieldPath].why.toLowerCase()}${conflictNote}`,
      });
    }

    if (!fact.trusted && (important || fact.sourceType === 'ai_derived')) {
      issues.push({
        field: path,
        kind: 'unverified',
        severity: 'info',
        message:
          fact.sourceType === 'ai_derived'
            ? `${def.label} was suggested by AI and has not been confirmed. Aura treats it as an assumption until someone reviews it.`
            : `${def.label} comes from ${SOURCE_TYPE_INFO[fact.sourceType].label.toLowerCase()}${fact.inferred ? ' as a fallback' : ''}, not from the business directly.`,
      });
    }
  }
  return issues;
}
