import { z } from 'zod';
import type { ContentDraft, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { ctaRequired, FORMAT_SPECS } from '@/lib/content-formats';
import { playbookFor, VARIATION_ANGLES } from '@/lib/content-playbook';
import type { QualityReport } from '@/lib/content-quality';
import {
  addVersion,
  extractFacts,
  findIntroducedFacts,
  MAX_VERSIONS,
  preserveInstructions,
  VERSION_HISTORY_LIMIT,
  withField,
  type DraftVersion,
} from '@/lib/content-variations';
import { redactSensitive } from '@/lib/generation-context';
import { platformSpec, type SocialPlatformKey } from '@/lib/platforms';
import { detailsOf, normaliseDetails, withDetails, type BusinessFacts } from '@/lib/post-details';
import { aiBodySchemaFor, bodySchemaFor, type ContentTypeKey } from '@/lib/validations/content';
import { completeStructured } from '@/server/ai/claude';
import { getBusinessFacts } from '@/server/company/profile.service';
import { updateDraftBody } from '@/server/content/content.service';
import { checkAndRepair, refineDraft } from '@/server/content/generator';
import { assessDraft, chunkText, loadWritingContext, writingPlatform } from '@/server/content/quality.service';
import { renderForManual } from '@/server/content/render';
import { preserveContextFor, VariationError } from '@/server/content/variations.service';
import { recordAudit } from '@/server/services/audit.service';

/**
 * Working with a draft's versions one at a time (Content Studio's
 * "Recommendations"): edit, rewrite or refine ONE version, add more
 * recommendations, and suggest calls to action — without touching any other
 * version.
 *
 * The version in use is the draft's body, so changing it goes through the
 * draft's own paths (updateDraftBody / refineDraft): re-approval, version
 * history and undo all apply. Every other version lives only in
 * `aiMetadata.variations[i]`; changing it never changes the draft's body or
 * status, and its earlier text is kept on that version (`previous`).
 *
 * Post details (website, address, phone, email) belong to each version and
 * are never written by the AI (lib/post-details.ts).
 */

interface Meta {
  variations?: DraftVersion[];
  activeVariation?: number;
  source?: { brief?: string | null };
  knowledgeChunkIds?: unknown;
  brief?: { cta?: { expected?: boolean } } | null;
  [key: string]: unknown;
}

const textOf = (type: ContentTypeKey, body: unknown) =>
  renderForManual({ type, body } as unknown as ContentDraft, { details: false });

/** The versions as stored, with the one in use reading as the draft does now. */
export function versionsOf(draft: ContentDraft): { versions: DraftVersion[]; active: number } {
  const meta = (draft.aiMetadata ?? {}) as Meta;
  const versions: DraftVersion[] =
    Array.isArray(meta.variations) && meta.variations.length
      ? meta.variations.map((v) => ({ ...v }))
      : [{ angle: 'Original', body: draft.body, kind: 'original' }];
  const active = Math.max(0, Math.min(meta.activeVariation ?? 0, versions.length - 1));
  versions[active] = { ...versions[active]!, body: draft.body };
  return { versions, active };
}

function guard(draft: ContentDraft) {
  if (draft.status === 'PUBLISHED') {
    throw new VariationError('Published content cannot be changed — duplicate it instead.');
  }
}

function stale(draft: ContentDraft, baseUpdatedAt?: string | null) {
  if (baseUpdatedAt && draft.updatedAt.toISOString() !== baseUpdatedAt) {
    throw Object.assign(
      new Error('This draft changed since you opened it. Reload to see the latest versions, then apply your change again.'),
      { status: 409, code: 'stale' },
    );
  }
}

/** Keep `body` as this version's earlier text (newest first, bounded). */
function remember(v: DraftVersion, note: string): DraftVersion['previous'] {
  return [{ body: v.body, at: new Date().toISOString(), note }, ...(v.previous ?? [])].slice(0, VERSION_HISTORY_LIMIT);
}

/** Write the versions back, only onto the draft as it was read. */
async function saveVersions(draft: ContentDraft, versions: DraftVersion[], active: number): Promise<ContentDraft> {
  const meta = (draft.aiMetadata ?? {}) as Meta;
  return db.contentDraft
    .update({
      where: { id: draft.id, updatedAt: draft.updatedAt },
      data: {
        aiMetadata: { ...meta, variations: versions, activeVariation: active } as unknown as Prisma.InputJsonValue,
      },
    })
    .catch((err: unknown) => {
      if ((err as { code?: string })?.code === 'P2025') {
        throw Object.assign(new Error('Someone changed this draft at the same moment. Reload, then try again.'), {
          status: 409,
          code: 'concurrent_change',
        });
      }
      throw err;
    });
}

function checkIndex(versions: DraftVersion[], index: number): DraftVersion {
  const v = versions[index];
  if (!v) throw new VariationError('That version does not exist.', 404);
  return v;
}

// ---------------------------------------------------------------------------
// Edit one version
// ---------------------------------------------------------------------------

export async function editVersion(args: {
  draft: ContentDraft;
  userId: string;
  index: number;
  body: unknown;
  baseUpdatedAt?: string | null;
}): Promise<{ draft: ContentDraft; index: number }> {
  const { draft, index } = args;
  guard(draft);
  const { versions, active } = versionsOf(draft);
  const current = checkIndex(versions, index);
  const type = draft.type as ContentTypeKey;
  // Checked here for both paths, so the person sees which field is wrong
  // ("Phone: that does not look like a phone number"), not "Validation failed".
  const parsed = bodySchemaFor(type).safeParse(args.body);
  if (!parsed.success) {
    throw Object.assign(new Error(parsed.error.issues[0]?.message ?? 'That version is not valid.'), { status: 422 });
  }

  if (index === active) {
    // The version in use: the draft's own edit path (re-approval, history).
    const updated = await updateDraftBody({
      companyId: draft.companyId,
      userId: args.userId,
      draftId: draft.id,
      body: args.body,
      baseUpdatedAt: args.baseUpdatedAt ?? null,
    });
    return { draft: updated, index };
  }

  stale(draft, args.baseUpdatedAt);
  const facts = await getBusinessFacts(draft.companyId);
  const body = withDetails(parsed.data, normaliseDetails(detailsOf(parsed.data), facts));
  const quality = await assessDraft({ ...draft, platform: current.platform ?? draft.platform }, body);
  versions[index] = { ...current, body, quality, previous: remember(current, 'edited') };

  const updated = await saveVersions(draft, versions, active);
  await recordAudit({
    action: 'CONTENT_CHANGES_REQUESTED',
    userId: args.userId,
    companyId: draft.companyId,
    metadata: { draftId: draft.id, version: index, edited: true },
  });
  return { draft: updated, index };
}

/** Bring back one version's previous text (that version only). */
export async function revertVersion(args: {
  draft: ContentDraft;
  userId: string;
  index: number;
  baseUpdatedAt?: string | null;
}): Promise<{ draft: ContentDraft; index: number }> {
  const { draft, index } = args;
  guard(draft);
  const { versions, active } = versionsOf(draft);
  const v = checkIndex(versions, index);
  const back = v.previous?.[0];
  if (!back) throw new VariationError('This version has no earlier text to go back to.', 400);

  if (index === active) {
    // The version in use: restored through the draft's edit path (history,
    // re-approval), then the entry is taken off this version's list.
    const updated = await updateDraftBody({
      companyId: draft.companyId,
      userId: args.userId,
      draftId: draft.id,
      body: back.body,
      baseUpdatedAt: args.baseUpdatedAt ?? null,
    });
    const after = versionsOf(updated);
    after.versions[index] = { ...after.versions[index]!, previous: (v.previous ?? []).slice(1) };
    return { draft: await saveVersions(updated, after.versions, after.active), index };
  }

  stale(draft, args.baseUpdatedAt);
  const quality = await assessDraft({ ...draft, platform: v.platform ?? draft.platform }, back.body);
  versions[index] = {
    ...v,
    body: back.body,
    quality,
    // The text being replaced takes the restored one's place, so a revert
    // can itself be reverted.
    previous: [{ body: v.body, at: new Date().toISOString(), note: 'before revert' }, ...(v.previous ?? []).slice(1)],
  };
  const updated = await saveVersions(draft, versions, active);
  await recordAudit({
    action: 'CONTENT_CHANGES_REQUESTED',
    userId: args.userId,
    companyId: draft.companyId,
    metadata: { draftId: draft.id, version: index, reverted: true },
  });
  return { draft: updated, index };
}

// ---------------------------------------------------------------------------
// Rewrite or refine one version
// ---------------------------------------------------------------------------

async function writingSetup(draft: ContentDraft) {
  const meta = (draft.aiMetadata ?? {}) as Meta;
  const w = await loadWritingContext(draft.companyId, { campaignId: draft.campaignId });
  const knowledge = redactSensitive(await chunkText(draft.companyId, meta.knowledgeChunkIds), { personal: true }).text;
  const keep = preserveContextFor(draft, meta as never, w.avoid);
  const sources = [meta.source?.brief ?? '', knowledge, ...keep.evidence, keep.ctaDestination ?? ''];
  const mustHaveCta = ctaRequired(draft.type as ContentTypeKey, meta.brief?.cta?.expected ?? null);
  return { meta, w, knowledge, keep, sources, mustHaveCta };
}

/**
 * Rewrite one version: a fresh take on the same angle, or the person's
 * instruction ("make it warmer, mention the tasting night"). Facts may not
 * change; details are kept as they are.
 */
export async function rewriteVersion(args: {
  draft: ContentDraft;
  userId: string;
  index: number;
  instruction?: string;
}): Promise<{ draft: ContentDraft; index: number; factsKept: boolean }> {
  const { draft, index } = args;
  guard(draft);
  const { versions, active } = versionsOf(draft);
  const current = checkIndex(versions, index);
  const instruction = args.instruction?.trim() || null;

  if (index === active) {
    // The version in use: the draft's own rewrite (history, undo, re-approval).
    const updated = await refineDraft({
      draft,
      userId: args.userId,
      action: instruction ? 'custom' : 'regenerate',
      ...(instruction ? { feedback: instruction } : {}),
    });
    return { draft: updated, index, factsKept: true };
  }

  const type = draft.type as ContentTypeKey;
  const platform: SocialPlatformKey | null = current.platform ?? writingPlatform(type, draft.platform);
  const playbook = playbookFor(type, platform);
  const { w, knowledge, keep, sources, mustHaveCta } = await writingSetup(draft);
  const originalText = textOf(type, current.body);
  const task = instruction
    ? `TASK: Revise this ${playbook.label} as the person asks: "${instruction}". Change only what that asks for; keep everything else.`
    : `TASK: Write a fresh take on this ${playbook.label}, keeping its angle (${current.angle || 'the same angle'}) but with a new hook and new wording.`;

  const write = async (fix?: string[]) =>
    completeStructured({
      schema: aiBodySchemaFor(type),
      system: w.system,
      prompt: [
        task,
        '',
        // This version's own facts are the ones to keep.
        preserveInstructions({ ...keep, facts: extractFacts(originalText) }),
        fix?.length
          ? `\nYOUR LAST VERSION CHANGED OR INVENTED THESE FACTS: ${fix.join(' · ')}. Use only the facts in the current version and the material above.`
          : '',
        'Never add a website, address, phone number, email, price, discount or date that is not already in the current version or the material above.',
        '',
        `HOW THIS FORMAT WORKS${platform ? ` ON ${platformSpec(platform).label.toUpperCase()}` : ''}:\n${playbook.rules.map((r) => `- ${r}`).join('\n')}`,
        '',
        `CURRENT VERSION (JSON):\n${JSON.stringify(withDetails(current.body, null))}`,
        knowledge ? `\nCOMPANY KNOWLEDGE (facts you may use):\n${knowledge.slice(0, 4000)}` : '',
        '',
        `Return JSON of this exact shape: ${FORMAT_SPECS[type].output.schemaText}`,
      ]
        .filter((l) => l !== '')
        .join('\n'),
      maxTokens: type === 'BLOG' ? 4000 : 1600,
      effort: 'medium',
    });

  let copy = await write();
  let introduced = findIntroducedFacts(originalText, textOf(type, copy), sources);
  let corrected = false;
  if (introduced.length) {
    copy = await write(introduced);
    corrected = true;
    introduced = findIntroducedFacts(originalText, textOf(type, copy), sources);
  }
  const checked = await checkAndRepair({
    type,
    body: withDetails(copy, detailsOf(current.body)),
    w,
    platform,
    sources: [originalText, ...sources].filter(Boolean),
    ctaRequired: mustHaveCta,
  });
  introduced = findIntroducedFacts(originalText, textOf(type, checked.body), sources);
  const quality = withFactsIssue(checked.quality, introduced);

  versions[index] = {
    ...current,
    body: checked.body,
    quality,
    facts: { introduced, corrected },
    previous: remember(current, instruction ? `refined: ${instruction.slice(0, 80)}` : 'regenerated'),
  };
  const updated = await saveVersions(draft, versions, active);
  await recordAudit({
    action: 'CONTENT_REGENERATED',
    userId: args.userId,
    companyId: draft.companyId,
    metadata: { draftId: draft.id, version: index, refined: Boolean(instruction), factsKept: introduced.length === 0 },
  });
  return { draft: updated, index, factsKept: introduced.length === 0 };
}

function withFactsIssue(quality: QualityReport, introduced: string[]): QualityReport {
  if (!introduced.length) return quality;
  return {
    ...quality,
    approvable: false,
    issues: [
      ...quality.issues,
      {
        code: 'facts-changed',
        severity: 'block',
        message: `This version adds facts that are not in the material: ${introduced.join(', ')}. Edit them out before using it.`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// More recommendations
// ---------------------------------------------------------------------------

export const MAX_MORE = 3;

/**
 * Write more versions in one call, each from an angle not used yet. Added
 * alongside the existing ones (the version in use is never dropped).
 */
export async function addRecommendations(args: {
  draft: ContentDraft;
  userId: string;
  count: number;
}): Promise<{ draft: ContentDraft; added: number[] }> {
  const { draft } = args;
  guard(draft);
  const type = draft.type as ContentTypeKey;
  if (type === 'BLOG') throw new VariationError('A blog is one long piece — use rewrite instead of more versions.', 400);
  const count = Math.max(1, Math.min(MAX_MORE, Math.floor(args.count)));
  const { versions, active } = versionsOf(draft);
  const base = versions[active]!;
  const platform = writingPlatform(type, draft.platform);
  const playbook = playbookFor(type, platform);
  const { w, knowledge, keep, sources, mustHaveCta } = await writingSetup(draft);

  const used = new Set(versions.map((v) => v.angle.toLowerCase()));
  const fresh = VARIATION_ANGLES.filter((a) => !used.has(a.toLowerCase()) && !used.has(angleLabel(a).toLowerCase()));
  const angles = (fresh.length >= count ? fresh : [...fresh, ...VARIATION_ANGLES]).slice(0, count);
  const existingHooks = versions.map((v) => textOf(type, v.body).split('\n')[0]?.slice(0, 160)).filter(Boolean);
  const originalText = textOf(type, base.body);

  const { variations } = await completeStructured({
    schema: z.object({
      variations: z.array(z.object({ angle: z.string().max(200).default(''), body: aiBodySchemaFor(type) })).min(1).max(count),
    }),
    system: w.system,
    prompt: [
      `TASK: Write ${count} NEW version${count > 1 ? 's' : ''} of this ${playbook.label}${platform ? ` for ${platformSpec(platform).label}` : ''}. Same goal, audience, message and facts — a genuinely different approach, hook and call to action each time.`,
      '',
      `Angles to take:\n${angles.map((a, i) => `${i + 1}. ${a}`).join('\n')}`,
      '',
      `Do NOT reuse these existing openings:\n${existingHooks.map((h) => `- ${h}`).join('\n')}`,
      '',
      preserveInstructions(keep),
      'Never add a website, address, phone number, email, price, discount or date that is not in the current version or the material.',
      '',
      `HOW THIS FORMAT WORKS:\n${playbook.rules.map((r) => `- ${r}`).join('\n')}`,
      '',
      `CURRENT VERSION (JSON, for the facts):\n${JSON.stringify(withDetails(base.body, null))}`,
      knowledge ? `\nCOMPANY KNOWLEDGE (facts you may use):\n${knowledge.slice(0, 4000)}` : '',
      '',
      `Return JSON: { "variations": [ { "angle": string (a few words), "body": ${FORMAT_SPECS[type].output.schemaText} } ] } with exactly ${count} items.`,
    ]
      .filter((l) => l !== '')
      .join('\n'),
    maxTokens: 1600 * count,
    effort: 'medium',
  });

  const checked = await Promise.all(
    variations.map(async (v, i) => {
      const result = await checkAndRepair({
        type,
        // A new recommendation starts with the details of the version in use;
        // from then on it keeps its own.
        body: withDetails(v.body, detailsOf(base.body)),
        w,
        platform,
        sources: [originalText, ...sources].filter(Boolean),
        ctaRequired: mustHaveCta,
      });
      const introduced = findIntroducedFacts(originalText, textOf(type, result.body), sources);
      return {
        angle: v.angle || angleLabel(angles[i] ?? '') || `Version ${versions.length + i + 1}`,
        body: result.body,
        quality: withFactsIssue(result.quality, introduced),
        kind: 'original' as const,
        basedOn: active,
        createdAt: new Date().toISOString(),
        facts: { introduced, corrected: false },
      } satisfies DraftVersion;
    }),
  );

  let list = versions;
  let cur = active;
  for (const v of checked) {
    const next = addVersion(list, cur, v);
    list = next.versions;
    cur = next.active;
  }
  // Where the new ones ended up (an old unused version may have been dropped
  // to stay within MAX_VERSIONS, shifting indexes).
  const added = checked.map((v) => list.indexOf(v)).filter((i) => i >= 0);
  const updated = await saveVersions(draft, list, cur);
  await recordAudit({
    action: 'CONTENT_REGENERATED',
    userId: args.userId,
    companyId: draft.companyId,
    metadata: { draftId: draft.id, moreVersions: checked.length, capped: list.length >= MAX_VERSIONS },
  });
  return { draft: updated, added };
}

const angleLabel = (a: string) => a.replace(/^Lead with (a |an |the )?/i, '').split(/[,.]/)[0]!.replace(/^./, (c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// Call-to-action suggestions
// ---------------------------------------------------------------------------

const CTA_MAX: Partial<Record<ContentTypeKey, number>> = { AD: 40 };
export const hasCta = (type: ContentTypeKey) => type !== 'TWEET_THREAD' && type !== 'BLOG';

/**
 * Alternative calls to action for one version. Nothing is saved: the person
 * picks one (or edits it) and saves the version. A suggestion that brings in
 * a link, number, price or date not already known is dropped.
 */
export async function ctaOptions(args: { draft: ContentDraft; index: number; goal?: string }): Promise<string[]> {
  const { draft } = args;
  const type = draft.type as ContentTypeKey;
  if (!hasCta(type)) throw new VariationError('This format has no call to action.', 400);
  const { versions } = versionsOf(draft);
  const v = checkIndex(versions, args.index);
  const platform = v.platform ?? writingPlatform(type, draft.platform);
  const facts = await getBusinessFacts(draft.companyId);
  const details = detailsOf(v.body);
  const known = knownFacts(facts, details);
  const { w, keep } = await writingSetup(draft);
  const postText = textOf(type, v.body);
  const max = CTA_MAX[type] ?? 120;

  const { options } = await completeStructured({
    schema: z.object({ options: z.array(z.string().trim().min(2).max(300)).min(1).max(6) }),
    system: w.system,
    prompt: [
      `TASK: Suggest 4 different calls to action for this ${playbookFor(type, platform).label}${platform ? ` on ${platformSpec(platform).label}` : ''}. Each at most ${max} characters, each a distinct next step (learn, visit, book, reply, call…) that fits the post and its goal.`,
      keep.goal || args.goal ? `GOAL: ${args.goal ?? keep.goal}` : '',
      `KNOWN FACTS YOU MAY MENTION (and nothing else factual): ${known.length ? known.join(' · ') : 'none — name the next step without any link, number or address'}`,
      'Never invent a website, phone number, address, price, discount, deadline or offer.',
      '',
      `THE POST:\n${postText.slice(0, 2500)}`,
      '',
      'Return JSON: { "options": string[] }',
    ]
      .filter(Boolean)
      .join('\n'),
    maxTokens: 500,
    effort: 'low',
    tier: 'cheap',
  });

  const current = String((v.body as { cta?: unknown }).cta ?? '').trim().toLowerCase();
  const seen = new Set<string>();
  return options
    .map((o) => o.trim().replace(/^["“]|["”]$/g, '').slice(0, max))
    .filter((o) => {
      const k = o.toLowerCase();
      if (!o || k === current || seen.has(k)) return false;
      seen.add(k);
      const introduced = findIntroducedFacts(postText, o, known);
      if (introduced.length) logger.info('cta options: dropped a suggestion with new facts', { introduced });
      return introduced.length === 0;
    })
    .slice(0, 5);
}

function knownFacts(facts: BusinessFacts, details: ReturnType<typeof detailsOf>): string[] {
  return [
    facts.website,
    facts.address,
    facts.phone,
    facts.email,
    details.website?.value,
    details.address?.value,
    details.phone?.value,
    details.email?.value,
  ].filter((x): x is string => Boolean(x));
}

/** Apply a CTA to one version (a convenience over editVersion). */
export async function setVersionCta(args: {
  draft: ContentDraft;
  userId: string;
  index: number;
  cta: string;
  baseUpdatedAt?: string | null;
}) {
  const type = args.draft.type as ContentTypeKey;
  if (!hasCta(type)) throw new VariationError('This format has no call to action.', 400);
  const { versions } = versionsOf(args.draft);
  const v = checkIndex(versions, args.index);
  return editVersion({ ...args, body: withField(v.body, 'cta', args.cta.slice(0, CTA_MAX[type] ?? 300)) });
}
