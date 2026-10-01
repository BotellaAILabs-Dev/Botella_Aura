import { createHash } from 'node:crypto';

import {
  contextField,
  SOURCE_TYPE_INFO,
  type BusinessContext,
  type BusinessFact,
  type ContextFieldPath,
} from '@/lib/business-context';
import {
  SECTION_FIELDS,
  SNAPSHOT_LIMITS,
  SNAPSHOT_SECTIONS,
  SNAPSHOT_VERSION,
  SNAPSHOT_VIEWS,
  type BusinessContextSnapshot,
  type SnapshotSection,
  type SnapshotView,
} from '@/lib/business-context-snapshot';
import { MATERIAL_CATEGORIES } from '@/lib/materials';
import type { RetrievedChunk } from '@/server/knowledge/retrieve';

/**
 * Business Context → Snapshot, as pure functions.
 *
 * buildSnapshot makes the full, stored snapshot; viewSnapshot cuts it down to
 * one workflow's sections (and strict mode); snapshotToPrompt renders it for a
 * model. The service decides WHEN to build; this decides WHAT goes in.
 *
 * INCLUSION POLICY — the reason the snapshot can be passed to a model as-is:
 *
 *   trusted and not stale     → main section
 *   untrusted or stale         → `assumptions`, with the reason
 *                                (left out with a reason in strict mode)
 *   learned insights           → `learning` if not stale and not low-confidence
 *                                (or confirmed by the user); thin ones are
 *                                assumptions — historical learning is evidence,
 *                                labelled with its strength, never a fact
 *   product evidence           → only from the business's own uploaded
 *                                material; crawled pages are not quoted
 */

/** Material categories that describe what the business sells. */
const PRODUCT_CATEGORIES = new Set([
  'DIFFERENTIATORS',
  'PRODUCT_DOCS',
  'COMPANY_INFO',
  'PITCH_DECK',
]);

function trim(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

type Verdict = 'include' | 'assume' | 'absent';

function verdict(fact: BusinessFact | undefined): Verdict {
  if (!fact) return 'absent';
  return fact.trusted && fact.freshness !== 'stale' ? 'include' : 'assume';
}

function reasonFor(fact: BusinessFact): string {
  const parts: string[] = [];
  if (!fact.trusted) {
    parts.push(
      fact.sourceType === 'ai_derived'
        ? 'suggested by AI, not confirmed'
        : (fact.note ??
            `from ${SOURCE_TYPE_INFO[fact.sourceType].label.toLowerCase()}, not confirmed`),
    );
  }
  if (fact.freshness === 'stale') {
    parts.push(
      fact.ageDays !== null
        ? `last updated ${fact.ageDays} days ago`
        : 'may be out of date',
    );
  }
  return parts.join('; ');
}

const list = (xs: string[], n: number) => xs.slice(0, n);

const same = (a: string, b: string) =>
  a.replace(/\s+/g, ' ').trim().toLowerCase() ===
  b.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The full snapshot: every section, assumptions listed. Stored as-is; views
 * are cut from it on read so one stored row serves every workflow.
 */
export function buildSnapshot(
  ctx: BusinessContext,
  passages: RetrievedChunk[],
  now: Date = new Date(),
): BusinessContextSnapshot {
  const facts = ctx.meta.facts;
  const trust: BusinessContextSnapshot['trust'] = {};
  const assumptions: BusinessContextSnapshot['assumptions'] = [];
  const omitted: BusinessContextSnapshot['omitted'] = [];

  /**
   * Decide one field. Returns true when it belongs in a main section; records
   * an assumption or trust entry as a side effect.
   */
  const admit = (path: ContextFieldPath, display: string | null): boolean => {
    const fact = facts[path];
    const v = verdict(fact);
    if (v === 'absent' || !fact) return false;
    if (v === 'include') {
      trust[path] = {
        sourceType: fact.sourceType,
        confidence: fact.confidence,
        capturedAt: fact.capturedAt,
        freshness: fact.freshness,
      };
      return true;
    }
    if (display) {
      assumptions.push({
        field: path,
        label: contextField(path).label,
        value: display,
        reason: reasonFor(fact),
      });
    }
    return false;
  };

  const {
    identity,
    audience: aud,
    objectives,
    channels,
    voice,
    market,
    memory,
  } = ctx;

  // --- business --------------------------------------------------------------
  const business = {
    name: identity.name,
    description: admit('identity.description', identity.description)
      ? identity.description
      : null,
    industry: admit('identity.industry', identity.industry)
      ? identity.industry
      : null,
    website: admit('identity.website', identity.website)
      ? identity.website
      : null,
  };
  admit('identity.name', identity.name);

  // --- products --------------------------------------------------------------
  const offerings = admit('identity.offerings', identity.offerings)
    ? identity.offerings
    : null;
  const highlights = passages
    .filter(
      (p) =>
        p.sourceType === 'UPLOAD' &&
        p.category &&
        PRODUCT_CATEGORIES.has(p.category),
    )
    .slice(0, SNAPSHOT_LIMITS.highlights)
    .map((p) => ({
      title: p.title,
      category: p.category,
      excerpt: trim(p.content, SNAPSHOT_LIMITS.excerptChars),
    }));
  const crawled = passages.filter((p) => p.sourceType !== 'UPLOAD').length;
  if (crawled && highlights.length === 0) {
    omitted.push({
      field: 'products.highlights',
      reason:
        'Only crawled web pages matched; product evidence is quoted from uploaded material only.',
    });
  }

  // --- audience --------------------------------------------------------------
  const marketMode = admit('audience.marketMode', aud.marketMode)
    ? aud.marketMode
    : null;
  const description = admit('audience.stated', aud.stated) ? aud.stated : null;
  const roles = admit('audience.roleTitles', aud.roleTitles.join(', ') || null)
    ? list(aud.roleTitles, SNAPSHOT_LIMITS.tags)
    : [];
  const industries = admit(
    'audience.industries',
    aud.industries.join(', ') || null,
  )
    ? list(aud.industries, SNAPSHOT_LIMITS.tags)
    : [];
  const stages = admit(
    'audience.companyStages',
    aud.companyStages.join(', ') || null,
  )
    ? list(aud.companyStages, SNAPSHOT_LIMITS.stages)
    : [];

  // --- goals -----------------------------------------------------------------
  const goal = admit('objectives.goals', objectives.goals)
    ? objectives.goals
    : null;

  // --- voice -----------------------------------------------------------------
  // The business's own notes are always its words; the structured profile is
  // included only once trusted (a person saved or confirmed it).
  const profileTrusted = admit('voice.summary', voice.summary);
  const p = profileTrusted ? voice.profile : null;
  const voiceSection =
    p || voice.notes || (profileTrusted && voice.summary)
      ? {
          summary: profileTrusted ? voice.summary : null,
          tone: list(p?.toneDescriptors ?? [], SNAPSHOT_LIMITS.voiceList),
          avoid: list(p?.topicsToAvoid ?? [], SNAPSHOT_LIMITS.voiceList),
          vocabulary: list(p?.vocabulary ?? [], SNAPSHOT_LIMITS.voiceList),
          emoji: p?.formatting.emojiUsage ?? null,
          hashtags: p?.formatting.hashtagStyle ?? null,
          // A profile generated without much material copies the notes into
          // its summary; repeating the same sentence only costs tokens.
          notes:
            voice.notes &&
            !(
              profileTrusted &&
              voice.summary &&
              same(voice.notes, voice.summary)
            )
              ? voice.notes
              : null,
        }
      : null;

  // --- channels --------------------------------------------------------------
  const publishesOn = admit(
    'channels.preferred',
    channels.preferred.join(', ') || null,
  )
    ? channels.preferred
    : [];
  const connected = admit(
    'channels.connected',
    channels.connected.join(', ') || null,
  )
    ? channels.connected
    : [];

  // --- learning --------------------------------------------------------------
  const insights: NonNullable<BusinessContextSnapshot['learning']>['insights'] =
    [];
  for (const m of memory.insights) {
    if (m.freshness === 'stale') {
      omitted.push({
        field: `memory:${m.id}`,
        reason: 'Learned pattern is older than 60 days.',
      });
      continue;
    }
    if (m.confidence === 'LOW' && !m.editedByUser) {
      assumptions.push({
        field: 'memory.insights',
        label: 'Tentative pattern',
        value: m.insight,
        reason: `small sample (${m.sampleSize})`,
      });
      continue;
    }
    if (insights.length < SNAPSHOT_LIMITS.insights) {
      insights.push({
        type: m.type,
        insight: m.insight,
        confidence: m.confidence,
        sampleSize: m.sampleSize,
        confirmedByUser: m.editedByUser,
        capturedAt: m.capturedAt,
      });
    }
  }
  if (insights.length && facts['memory.insights']) {
    const f = facts['memory.insights'];
    trust['memory.insights'] = {
      sourceType: f.sourceType,
      confidence: f.confidence,
      capturedAt: f.capturedAt,
      freshness: f.freshness,
    };
  }

  // --- market ----------------------------------------------------------------
  // Per competitor, because one list can mix a tracked rival with an AI guess.
  const known = market.competitors.filter((c) => c.confidence !== 'unverified');
  const guessed = market.competitors.filter(
    (c) => c.confidence === 'unverified',
  );
  if (known.length) {
    trust['market.competitors'] = {
      sourceType: known[0]!.sourceType,
      confidence: known[0]!.confidence,
      capturedAt: known[0]!.capturedAt,
      freshness: facts['market.competitors']?.freshness ?? 'unknown',
    };
  }
  if (guessed.length) {
    assumptions.push({
      field: 'market.competitors',
      label: 'Possible competitors',
      value: guessed.map((c) => c.name).join(', '),
      reason: 'suggested by AI, not confirmed',
    });
  }
  const keywords = admit('market.keywords', market.keywords.join(', ') || null)
    ? list(market.keywords, SNAPSHOT_LIMITS.keywords)
    : [];

  if (
    facts['knowledge.coverage'] &&
    verdict(facts['knowledge.coverage']) === 'include'
  ) {
    admit('knowledge.coverage', null);
  }

  const gaps = ctx.meta.completeness.missingRequired.map((path) => {
    const def = contextField(path as ContextFieldPath);
    return {
      field: path,
      label: def.label,
      ...(def.href ? { href: def.href } : {}),
    };
  });

  const snapshot: BusinessContextSnapshot = {
    version: SNAPSHOT_VERSION,
    companyId: identity.companyId,
    fingerprint: '',
    revision: ctx.meta.revision,
    generatedAt: now.toISOString(),
    view: 'full',
    strict: false,
    business,
    products: offerings || highlights.length ? { offerings, highlights } : null,
    audience:
      marketMode ||
      description ||
      roles.length ||
      industries.length ||
      stages.length
        ? { marketMode, description, roles, industries, stages }
        : null,
    goals: goal ? { current: goal } : null,
    voice: voiceSection,
    channels:
      publishesOn.length || connected.length
        ? { publishesOn, connected }
        : null,
    learning: insights.length ? { insights } : null,
    market:
      known.length || keywords.length
        ? {
            competitors: list(
              known.map((c) => c.name),
              SNAPSHOT_LIMITS.competitors,
            ),
            keywords,
          }
        : null,
    trust,
    assumptions,
    omitted,
    gaps,
    meta: { sections: [...SNAPSHOT_SECTIONS], estimatedTokens: 0 },
  };
  snapshot.fingerprint = fingerprintOf(snapshot);
  snapshot.meta.estimatedTokens = estimateTokens(snapshot);
  return snapshot;
}

/**
 * A stable hash of what the snapshot SAYS — not when it was made — so two
 * builds of an unchanged business produce the same fingerprint.
 */
export function fingerprintOf(snapshot: BusinessContextSnapshot): string {
  const {
    fingerprint: _f,
    generatedAt: _g,
    meta: _m,
    view: _v,
    strict: _s,
    ...content
  } = snapshot;
  // Ages change daily without the business changing; leave them out.
  const stable = JSON.stringify(content, (key, value) =>
    key === 'ageDays' ? undefined : value,
  );
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

function sectionField(field: string): SnapshotSection | undefined {
  if (field.startsWith('memory')) return 'learning';
  return SNAPSHOT_SECTIONS.find((s) => SECTION_FIELDS[s].includes(field));
}

/**
 * One workflow's cut of a snapshot: only its sections, and in strict mode no
 * assumptions at all. The fingerprint is the full snapshot's, so every view
 * of the same business state traces back to the same snapshot.
 */
export function viewSnapshot(
  full: BusinessContextSnapshot,
  view: SnapshotView,
  strict = false,
): BusinessContextSnapshot {
  const sections = SNAPSHOT_VIEWS[view] as readonly SnapshotSection[];
  const inView = (field: string) => {
    if (field === 'identity.name' || field.startsWith('products.')) {
      return sections.includes(
        field === 'identity.name' ? 'business' : 'products',
      );
    }
    const section = sectionField(field);
    return section ? sections.includes(section) : false;
  };

  const assumptions = full.assumptions.filter((a) => inView(a.field));
  const out: BusinessContextSnapshot = {
    ...full,
    view,
    strict,
    business: sections.includes('business') ? full.business : null,
    products: sections.includes('products') ? full.products : null,
    audience: sections.includes('audience') ? full.audience : null,
    goals: sections.includes('goals') ? full.goals : null,
    voice: sections.includes('voice') ? full.voice : null,
    channels: sections.includes('channels') ? full.channels : null,
    learning: sections.includes('learning') ? full.learning : null,
    market: sections.includes('market') ? full.market : null,
    trust: Object.fromEntries(
      Object.entries(full.trust).filter(([k]) => inView(k)),
    ),
    assumptions: strict ? [] : assumptions,
    omitted: [
      ...full.omitted.filter((o) => inView(o.field)),
      ...(strict
        ? assumptions.map((a) => ({
            field: a.field,
            reason: `Strict snapshot: ${a.label.toLowerCase()} is ${a.reason}.`,
          }))
        : []),
    ],
    gaps: full.gaps.filter((g) => inView(g.field)),
    meta: { sections: [...sections], estimatedTokens: 0 },
  };
  out.meta.estimatedTokens = estimateTokens(out);
  return out;
}

function estimateTokens(snapshot: BusinessContextSnapshot): number {
  return Math.ceil(snapshotToPrompt(snapshot).length / 4);
}

const CATEGORY_LABEL = new Map<string, string>(
  MATERIAL_CATEGORIES.map((c) => [c.id, c.label]),
);

/**
 * The snapshot as a compact fact sheet for a model.
 *
 * Facts only, no writing instructions: each workflow adds its own task and
 * rules. Assumptions and gaps are stated as such, so the model is told in the
 * same place what it may rely on and what it must not invent.
 */
export function snapshotToPrompt(s: BusinessContextSnapshot): string {
  const lines: string[] = [
    `BUSINESS CONTEXT (snapshot ${s.fingerprint.slice(0, 8)}, ${s.generatedAt.slice(0, 10)}) — confirmed, current facts:`,
  ];
  const push = (line: string | false | null | undefined) => {
    if (line) lines.push(line);
  };

  if (s.business) {
    push(
      `Company: ${s.business.name}${s.business.industry ? ` (${s.business.industry})` : ''}`,
    );
    push(s.business.description && `What it does: ${s.business.description}`);
    push(s.business.website && `Website: ${s.business.website}`);
  }
  if (s.products) {
    push(s.products.offerings && `What it sells: ${s.products.offerings}`);
    if (s.products.highlights.length) {
      push('From its own documents:');
      for (const h of s.products.highlights) {
        const label = h.category ? CATEGORY_LABEL.get(h.category) : null;
        push(
          `- ${label ? `[${label}] ` : ''}${h.title ? `${h.title}: ` : ''}${h.excerpt}`,
        );
      }
    }
  }
  if (s.audience) {
    const mode =
      s.audience.marketMode === 'B2C'
        ? 'consumers'
        : s.audience.marketMode === 'B2B'
          ? 'businesses'
          : null;
    push(mode && `Sells to: ${mode}`);
    push(s.audience.description && `Buyer: ${s.audience.description}`);
    push(
      s.audience.roles.length > 0 &&
        `Buyer roles: ${s.audience.roles.join(', ')}`,
    );
    push(
      s.audience.industries.length > 0 &&
        `Buyer industries: ${s.audience.industries.join(', ')}`,
    );
    push(
      s.audience.stages.length > 0 &&
        `Buyer company stages: ${s.audience.stages.join(', ')}`,
    );
  }
  if (s.goals) push(`Current goal: ${s.goals.current}`);
  if (s.voice) {
    push(s.voice.summary && `Voice: ${s.voice.summary}`);
    push(s.voice.tone.length > 0 && `Tone: ${s.voice.tone.join(', ')}`);
    push(
      s.voice.avoid.length > 0 && `Never mention: ${s.voice.avoid.join(', ')}`,
    );
    push(
      s.voice.vocabulary.length > 0 &&
        `Their vocabulary: ${s.voice.vocabulary.join(', ')}`,
    );
    push(
      (s.voice.emoji || s.voice.hashtags) &&
        `Emoji: ${s.voice.emoji ?? 'unspecified'}. Hashtags: ${s.voice.hashtags ?? 'unspecified'}.`,
    );
    push(s.voice.notes && `Voice, in their own words: ${s.voice.notes}`);
  }
  if (s.channels) {
    push(
      s.channels.publishesOn.length > 0 &&
        `Publishes on: ${s.channels.publishesOn.join(', ')}`,
    );
    push(
      s.channels.connected.length > 0 &&
        `Connected to Aura: ${s.channels.connected.join(', ')}`,
    );
  }
  if (s.learning) {
    push('Learned from past performance:');
    for (const i of s.learning.insights) {
      push(
        `- [${i.type}] ${i.insight} (${i.confidence}, n=${i.sampleSize}${i.confirmedByUser ? ', confirmed' : ''})`,
      );
    }
  }
  if (s.market) {
    push(
      s.market.competitors.length > 0 &&
        `Competitors: ${s.market.competitors.join(', ')}`,
    );
    push(
      s.market.keywords.length > 0 &&
        `Market topics: ${s.market.keywords.join(', ')}`,
    );
  }

  if (s.assumptions.length) {
    lines.push(
      '',
      'ASSUMPTIONS — unconfirmed or possibly out of date. Use only as background; never state them as facts:',
    );
    for (const a of s.assumptions)
      lines.push(`- ${a.label}: ${a.value} (${a.reason})`);
  }
  if (s.gaps.length) {
    lines.push(
      '',
      `NOT PROVIDED: ${s.gaps.map((g) => g.label.toLowerCase()).join('; ')}. Do not invent these.`,
    );
  }
  return lines.join('\n');
}
