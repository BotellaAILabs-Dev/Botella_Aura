import type { Company, ContentDraft, Prisma } from '@prisma/client';
import { z } from 'zod';

import { db } from '@/lib/db';
import { recordAudit } from '@/server/services/audit.service';
import { completeStructured, getModel } from '@/server/ai/claude';
import { retrieve, chunksToContext } from '@/server/knowledge/retrieve';
import { politeFetchHtml } from '@/server/knowledge/robots';
import { htmlToText } from '@/server/knowledge/extract';
import { logger } from '@/lib/logger';
import { generateBrandVoiceProfile } from '@/server/content/brand-voice.service';
import {
  TONE_GUIDANCE,
  VARIATION_ANGLES,
  playbookFor,
} from '@/lib/content-playbook';
import { issuesAsFeedback, type QualityReport } from '@/lib/content-quality';
import { platformsForType, type SocialPlatformKey } from '@/lib/platforms';
import {
  bodySchemaFor,
  type ContentTone,
  type ContentTypeKey,
  type GenerationSource,
  type RefineAction,
} from '@/lib/validations/content';
import type { DigestPayload } from '@/server/trends/types';
import {
  chunkText,
  finalizeBody,
  loadWritingContext,
  qualityContextFor,
  writingPlatform,
  type WritingContext,
} from '@/server/content/quality.service';

/**
 * Content generator — Content Studio's copywriter.
 *
 * Every call: resolve the brief → retrieve grounding chunks → make sure a
 * brand voice exists → read the Business Context (business, products,
 * audience, goals, voice, learned patterns, recent content, and the campaign
 * when there is one) → write for the PLATFORM it will run on
 * (lib/content-playbook.ts) → validate the structure → check the copy
 * (lib/content-quality.ts): safe fixes, then one automatic repair if anything
 * blocking remains → store, with the quality report, the variations and an
 * undo history. A call that skips knowledge retrieval or brand voice is a bug
 * (NON-NEGOTIABLE #5).
 */
// Bumped when the prompt changes materially, so a draft's aiMetadata records
// which set of instructions produced it.
// s8 writes per platform playbook, in variations, and checks every draft.
const PROMPT_VERSION = 's8.playbook-quality';

/** Undo steps kept per draft. */
const HISTORY_LIMIT = 5;

interface TypeSpec {
  label: string;
  schemaText: string;
}

const TYPE_SPECS: Record<ContentTypeKey, TypeSpec> = {
  LINKEDIN_POST: {
    label: 'LinkedIn post',
    schemaText:
      '{ "hook": string, "paragraphs": string[3..5], "cta": string, "hashtags": string[] (without #) }',
  },
  IMAGE_POST: {
    label: 'Single image post',
    schemaText:
      '{ "caption": string, "cta": string, "hashtags": string[] (without #), "altText": string }',
  },
  CAROUSEL: {
    label: 'Carousel',
    schemaText:
      '{ "title": string, "slides": [{ "headline": string, "body": string }] (5..8), "cta": string, "hashtags": string[] (without #) }',
  },
  TWEET_THREAD: {
    label: 'X thread',
    schemaText:
      '{ "tweets": string[2..12] (each <= 280 chars), "hashtags": string[0..2] (without #) }',
  },
  BLOG: {
    label: 'Blog draft',
    schemaText:
      '{ "headline": string, "subtitle": string, "sections": [{ "heading": string, "body": string }] (2..10), "tags": string[0..10] }',
  },
  EMAIL: {
    label: 'Email',
    schemaText:
      '{ "subjectLine": string, "previewText": string, "greeting": string, "paragraphs": string[1..6], "cta": string, "signOff": string }',
  },
  AD: {
    label: 'Ad copy',
    schemaText:
      '{ "headline": string, "primaryText": string, "description": string, "cta": string }',
  },
};

const maxTokensFor = (type: ContentTypeKey, n: number) =>
  (type === 'BLOG' ? 4000 : 1600) * Math.max(1, n);

/** Everything the copy may draw facts from, beyond the system prompt. */
function groundingSources(
  brief: string,
  reference: string,
  chunks: string,
): string[] {
  return [brief, reference, chunks].filter(Boolean);
}

/**
 * Check a body and, if anything blocking remains, ask the writer once to fix
 * exactly those problems. One repair — not a loop — so a stubborn model costs
 * one extra call, and whatever is still wrong is reported, never hidden.
 */
async function checkAndRepair(args: {
  type: ContentTypeKey;
  body: unknown;
  w: WritingContext;
  platform: SocialPlatformKey | null;
  sources: string[];
}): Promise<{ body: unknown; quality: QualityReport; repaired: boolean }> {
  const qc = qualityContextFor(args.type, args.platform, args.w, args.sources);
  const first = finalizeBody(args.type, args.body, qc);
  const blocking = first.quality.issues.filter((i) => i.severity === 'block');
  if (!blocking.length) return { ...first, repaired: false };

  try {
    const playbook = playbookFor(args.type, args.platform);
    const fixed = await completeStructured({
      schema: bodySchemaFor(args.type),
      system: args.w.system,
      prompt: [
        `TASK: Fix this ${playbook.label}. Keep everything that works; change only what the problems below require.`,
        '',
        `CURRENT DRAFT (JSON):\n${JSON.stringify(first.body)}`,
        '',
        `PROBLEMS TO FIX:\n${issuesAsFeedback(blocking)}`,
        '',
        `Return JSON of this exact shape: ${TYPE_SPECS[args.type].schemaText}`,
      ].join('\n'),
      maxTokens: maxTokensFor(args.type, 1),
      effort: 'medium',
    });
    const second = finalizeBody(args.type, fixed, qc);
    return { ...second, repaired: true };
  } catch (err) {
    logger.warn(
      'generator: repair pass failed; keeping the first draft with its issues',
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return { ...first, repaired: false };
  }
}

interface GenerateArgs {
  companyId: string;
  /** Null when Autopilot wrote this unattended — createdById is nullable. */
  userId: string | null;
  type: ContentTypeKey;
  source: GenerationSource;
  campaignId?: string;
  /** Where it will run; the type's default when absent. */
  platform?: SocialPlatformKey;
  /** 1–3 creative variations; the first becomes the draft. */
  variations?: number;
  tone?: ContentTone;
  /** The Aura recommendation it was written for (already checked as this workspace's). */
  recommendation?: { id: string; title: string } | null;
}

export async function generateDraft({
  companyId,
  userId,
  type,
  source,
  campaignId,
  platform: requested,
  variations = 1,
  tone,
  recommendation,
}: GenerateArgs): Promise<ContentDraft> {
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error('Company not found');
  if (requested && !platformsForType(type).includes(requested)) {
    throw Object.assign(
      new Error(
        `A ${TYPE_SPECS[type].label} can’t be written for ${requested}.`,
      ),
      { status: 422 },
    );
  }

  const brief = await resolveBrief(company, source);
  const chunks = await retrieve(companyId, brief.query, { limit: 8 });
  // If the brief mentions a URL ("write about our flagship product: <url>"),
  // fetch that page LIVE and ground the post in its real content. This is what
  // makes "look at my website" actually work — the model can't browse on its own.
  const reference = await fetchReferenceContext(
    `${brief.text}\n${source.brief ?? ''}\n${company.website ?? ''}`,
  );
  // Make sure a voice profile exists before the context is read, so a first
  // draft is never written without one (NON-NEGOTIABLE #5).
  await generateBrandVoiceProfile({ company, userId });
  const campaignRef =
    campaignId ?? (source.kind === 'CAMPAIGN' ? source.ref : undefined);
  const w = await loadWritingContext(companyId, { campaignId: campaignRef });

  const platform = writingPlatform(type, requested);
  const playbook = playbookFor(type, platform);
  // A blog is one long piece; variations of it are not a useful choice.
  const n = type === 'BLOG' ? 1 : Math.max(1, Math.min(3, variations));
  const knowledge = chunksToContext(chunks);

  const prompt = [
    `TASK: Write ${n > 1 ? `${n} different versions of ` : ''}a ${playbook.label} for ${company.name}.`,
    '',
    `HOW THIS FORMAT WORKS:\n${playbook.rules.map((r) => `- ${r}`).join('\n')}`,
    tone
      ? `\nTONE FOR THIS PIECE (within the brand voice): ${TONE_GUIDANCE[tone]}`
      : '',
    n > 1
      ? `\nEach version must take a genuinely different angle and hook — not the same text reworded:\n${VARIATION_ANGLES.slice(
          0,
          n,
        )
          .map((a, i) => `${i + 1}. ${a}`)
          .join('\n')}`
      : '',
    '',
    `TOPIC / BRIEF:\n${brief.text}`,
    reference
      ? `\nREFERENCE PAGE (fetched live from a link in your brief — use these REAL facts, product names, and positioning; do not go generic):\n${reference}`
      : '',
    '',
    `COMPANY KNOWLEDGE:\n${knowledge}`,
    '',
    n > 1
      ? `Return JSON: { "variations": [ { "angle": string (a few words), "body": ${TYPE_SPECS[type].schemaText} } ] } with exactly ${n} items.`
      : `Return JSON of this exact shape: ${TYPE_SPECS[type].schemaText}`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  const bodySchema = bodySchemaFor(type);
  const written: { angle: string; body: unknown }[] =
    n > 1
      ? (
          await completeStructured({
            schema: z.object({
              variations: z
                .array(
                  z.object({
                    angle: z.string().max(200).default(''),
                    body: bodySchema,
                  }),
                )
                .min(1)
                .max(n),
            }),
            system: w.system,
            prompt,
            maxTokens: maxTokensFor(type, n),
            effort: 'medium',
          })
        ).variations
      : [
          {
            angle: '',
            body: await completeStructured({
              schema: bodySchema,
              system: w.system,
              prompt,
              maxTokens: maxTokensFor(type, 1),
              // Short posts don't need max reasoning — 'medium' is markedly faster with
              // no quality loss on hook-first posts; blogs keep 'high' for structure.
              effort: type === 'BLOG' ? 'high' : 'medium',
            }),
          },
        ];

  const sources = groundingSources(brief.text, reference, knowledge);
  // Each version checked (and repaired if needed) on its own, in parallel.
  const checked = await Promise.all(
    written.map(async (v, i) => ({
      angle:
        v.angle ||
        VARIATION_ANGLES[i]?.split(' with ')[0] ||
        `Version ${i + 1}`,
      ...(await checkAndRepair({ type, body: v.body, w, platform, sources })),
    })),
  );
  const first = checked[0]!;

  const aiMetadata: Prisma.InputJsonValue = {
    source: {
      kind: source.kind,
      ref: source.ref ?? null,
      brief: source.brief ?? null,
    },
    // So the draft leads back to the suggestion it was written for.
    ...(recommendation
      ? { recommendation: { id: recommendation.id, title: recommendation.title } }
      : {}),
    // Recorded from the client rather than hardcoded, so the metadata stays
    // true when the model or its tier changes.
    model: getModel('premium'),
    promptVersion: PROMPT_VERSION,
    // Which state of the business this draft was written from.
    contextRevision: w.context?.meta.revision ?? null,
    knowledgeChunkIds: chunks.map((c) => c.id),
    brandVoiceApplied: true,
    referenceUsed: reference.length > 0,
    writtenFor: platform,
    tone: tone ?? null,
    campaignId: w.campaign?.id ?? null,
    quality: first.quality as unknown as Prisma.InputJsonValue,
    variations: checked.map((v) => ({
      angle: v.angle,
      body: v.body,
      quality: v.quality,
    })) as unknown as Prisma.InputJsonValue,
    activeVariation: 0,
    history: [],
  };

  const draft = await db.contentDraft.create({
    data: {
      companyId,
      createdById: userId,
      campaignId: campaignId ?? w.campaign?.id ?? null,
      type,
      status: 'DRAFT',
      title: briefTitle(brief.text, TYPE_SPECS[type].label),
      body: first.body as object,
      // The platform it was written for is where it goes, unless changed.
      platform: type === 'EMAIL' ? null : platform,
      aiMetadata,
    },
  });

  await recordAudit({
    action: 'CONTENT_DRAFT_CREATED',
    userId,
    companyId,
    metadata: {
      draftId: draft.id,
      type,
      source: source.kind,
      platform,
      variations: checked.length,
      approvable: first.quality.approvable,
      repaired: checked.some((c) => c.repaired),
    },
  });
  return draft;
}

/** What each one-click action asks of the writer. */
function instructionFor(
  action: RefineAction,
  options: { tone?: ContentTone; feedback?: string; issues: string },
): string {
  switch (action) {
    case 'regenerate':
      return 'Write a noticeably fresh take — a different angle and hook — on the same topic, with the same facts and voice.';
    case 'shorten':
      return 'Make it about 40% shorter. Keep the hook, the one key point and the call to action; cut everything else.';
    case 'expand':
      return 'Make it richer: add one concrete detail, example or reason drawn from the business context or knowledge. Stay within the format’s length limits.';
    case 'tone':
      return `Rewrite it in this tone, keeping the facts, structure and call to action: ${TONE_GUIDANCE[options.tone ?? 'professional']}`;
    case 'improve':
      return [
        'Improve it: sharpen the hook so it is specific, make the call to action concrete, cut filler and repetition, and remove anything that sounds machine-written.',
        options.issues ? `Also fix these issues:\n${options.issues}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    case 'custom':
      return (
        options.feedback ||
        'Give a noticeably fresh take — different angle and hook, same topic and voice.'
      );
  }
}

interface RefineArgs {
  draft: ContentDraft;
  userId: string;
  /** Defaults to a custom instruction (`feedback`), as before. */
  action?: RefineAction;
  tone?: ContentTone;
  feedback?: string;
}

/**
 * Rewrite an existing draft — regenerate, shorten, expand, change tone,
 * improve, or follow a custom note — keeping the same type and platform.
 * The previous version goes into the draft's history, so any rewrite can be
 * undone.
 */
export async function refineDraft({
  draft,
  userId,
  action = 'custom',
  tone,
  feedback,
}: RefineArgs): Promise<ContentDraft> {
  const company = await db.company.findUnique({
    where: { id: draft.companyId },
  });
  if (!company) throw new Error('Company not found');
  const type = draft.type as ContentTypeKey;

  await generateBrandVoiceProfile({ company, userId });
  // A revision is still content a customer publishes, so it gets the same
  // business context, rules and checks as the first pass.
  const w = await loadWritingContext(draft.companyId, {
    campaignId: draft.campaignId,
  });
  const meta = (draft.aiMetadata ?? {}) as Record<string, unknown>;
  const platform = writingPlatform(type, draft.platform);
  const playbook = playbookFor(type, platform);
  const knowledge = await chunkText(draft.companyId, meta.knowledgeChunkIds);
  const brief = ((meta.source ?? {}) as { brief?: string | null }).brief ?? '';
  const currentIssues = (((meta.quality ?? {}) as QualityReport).issues ?? [])
    .map((i) => `- ${i.message}`)
    .join('\n');

  const prompt = [
    `TASK: Revise this ${playbook.label}.`,
    '',
    `HOW THIS FORMAT WORKS:\n${playbook.rules.map((r) => `- ${r}`).join('\n')}`,
    '',
    `CURRENT DRAFT (JSON):\n${JSON.stringify(draft.body)}`,
    '',
    `WHAT TO CHANGE: ${instructionFor(action, { tone, feedback, issues: currentIssues })}`,
    knowledge
      ? `\nCOMPANY KNOWLEDGE (facts you may use):\n${knowledge.slice(0, 6000)}`
      : '',
    '',
    `Return JSON of this exact shape: ${TYPE_SPECS[type].schemaText}`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  const raw = await completeStructured({
    schema: bodySchemaFor(type),
    system: w.system,
    prompt,
    maxTokens: maxTokensFor(type, 1),
    effort: type === 'BLOG' ? 'high' : 'medium',
  });
  const result = await checkAndRepair({
    type,
    body: raw,
    w,
    platform,
    sources: groundingSources(brief, '', knowledge),
  });

  const history = [
    { body: draft.body, at: new Date().toISOString(), before: action },
    ...((Array.isArray(meta.history) ? meta.history : []) as unknown[]),
  ].slice(0, HISTORY_LIMIT);

  const updated = await db.contentDraft.update({
    where: { id: draft.id },
    // Regenerating returns a draft to DRAFT status (must be re-approved).
    data: {
      body: result.body as object,
      status: 'DRAFT',
      aiMetadata: {
        ...meta,
        quality: result.quality,
        history,
        lastAction: action,
        ...(action === 'tone' && tone ? { tone } : {}),
      } as unknown as Prisma.InputJsonValue,
    },
  });

  await recordAudit({
    action: 'CONTENT_REGENERATED',
    userId,
    companyId: draft.companyId,
    metadata: {
      draftId: draft.id,
      action,
      hadFeedback: Boolean(feedback),
      approvable: result.quality.approvable,
      repaired: result.repaired,
    },
  });
  return updated;
}

/**
 * Switch the draft to another of its generated variations. The current body
 * goes into the history, so this can be undone too.
 */
export async function switchVariation(args: {
  draft: ContentDraft;
  userId: string;
  index: number;
}): Promise<ContentDraft> {
  const meta = (args.draft.aiMetadata ?? {}) as Record<string, unknown>;
  const variations = Array.isArray(meta.variations) ? meta.variations : [];
  const chosen = variations[args.index] as
    { body?: unknown; quality?: unknown } | undefined;
  if (!chosen) {
    throw Object.assign(new Error('That version does not exist.'), {
      status: 404,
    });
  }
  const body = bodySchemaFor(args.draft.type as ContentTypeKey).parse(
    chosen.body,
  );
  const history = [
    {
      body: args.draft.body,
      at: new Date().toISOString(),
      before: 'variation',
    },
    ...((Array.isArray(meta.history) ? meta.history : []) as unknown[]),
  ].slice(0, HISTORY_LIMIT);
  const updated = await db.contentDraft.update({
    where: { id: args.draft.id },
    data: {
      body: body as object,
      status: args.draft.status === 'APPROVED' ? 'DRAFT' : args.draft.status,
      aiMetadata: {
        ...meta,
        activeVariation: args.index,
        quality: chosen.quality ?? meta.quality ?? null,
        history,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  await recordAudit({
    action: 'CONTENT_CHANGES_REQUESTED',
    userId: args.userId,
    companyId: args.draft.companyId,
    metadata: { draftId: args.draft.id, variation: args.index },
  });
  return updated;
}

/** Restore the previous version of a draft. */
export async function undoDraft(args: {
  draft: ContentDraft;
  userId: string;
}): Promise<ContentDraft> {
  const meta = (args.draft.aiMetadata ?? {}) as Record<string, unknown>;
  const history = (Array.isArray(meta.history) ? meta.history : []) as {
    body: unknown;
  }[];
  const previous = history[0];
  if (!previous) {
    throw Object.assign(new Error('There is nothing to undo.'), {
      status: 409,
    });
  }
  const type = args.draft.type as ContentTypeKey;
  const body = bodySchemaFor(type).parse(previous.body);
  const updated = await db.contentDraft.update({
    where: { id: args.draft.id },
    data: {
      body: body as object,
      status: args.draft.status === 'APPROVED' ? 'DRAFT' : args.draft.status,
      aiMetadata: {
        ...meta,
        history: history.slice(1),
        // The restored version's quality is re-checked by the caller.
        lastAction: 'undo',
      } as unknown as Prisma.InputJsonValue,
    },
  });
  await recordAudit({
    action: 'CONTENT_CHANGES_REQUESTED',
    userId: args.userId,
    companyId: args.draft.companyId,
    metadata: { draftId: args.draft.id, undo: true },
  });
  return updated;
}

// ---- Live reference fetching ----------------------------------------------

const URL_RE = /https?:\/\/[^\s)\]}"'<>]+/gi;

/**
 * Find URLs in the brief, fetch them live (robots-polite, JS not executed), and
 * return extracted page text as extra grounding. Best-effort — returns '' on
 * failure so generation still proceeds. Bounded to 2 pages / ~4k chars each.
 */
async function fetchReferenceContext(text: string): Promise<string> {
  const urls = Array.from(
    new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;)]+$/, ''))),
  ).slice(0, 2);
  if (urls.length === 0) return '';

  const parts: string[] = [];
  for (const url of urls) {
    try {
      const html = await politeFetchHtml(url);
      if (!html) continue;
      const { title, text: body } = htmlToText(html);
      const snippet = `${title}\n${body}`.trim().slice(0, 4000);
      if (snippet.length > 40) parts.push(`Source: ${url}\n${snippet}`);
    } catch (err) {
      logger.info('generator: reference fetch failed (non-fatal)', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return parts.join('\n\n');
}

// ---- Brief resolution ------------------------------------------------------

interface ResolvedBrief {
  text: string;
  query: string;
}

async function resolveBrief(
  company: Company,
  source: GenerationSource,
): Promise<ResolvedBrief> {
  if (source.kind === 'BRIEF') {
    const text = source.brief?.trim() || `Write about ${company.name}.`;
    return { text, query: text };
  }

  if (source.kind === 'CAMPAIGN' && source.ref) {
    const campaign = await db.campaign.findUnique({
      where: { id: source.ref },
    });
    const base = campaign
      ? `Campaign: ${campaign.name}. Goal: ${campaign.goal ?? 'n/a'}.`
      : 'Campaign content.';
    const text = source.brief ? `${base}\n${source.brief}` : base;
    return { text, query: `${campaign?.name ?? ''} ${source.brief ?? ''}` };
  }

  // TREND — look the item up in a recent digest.
  if (source.kind === 'TREND' && source.ref) {
    const item = await findTrendItem(company.id, source.ref);
    if (item) {
      const text = `Trend: "${item.title}" (${item.sourceLabel}).\n${item.aiSummary}\nSuggested angle: ${item.suggestedAngle}\nSource URL: ${item.url}`;
      return { text, query: item.title };
    }
  }
  const fallback =
    source.brief?.trim() || `Write timely content for ${company.name}.`;
  return { text: fallback, query: fallback };
}

async function findTrendItem(companyId: string, itemId: string) {
  const digests = await db.trendDigest.findMany({
    where: { companyId },
    orderBy: { date: 'desc' },
    take: 7,
  });
  for (const d of digests) {
    const payload = d.payload as unknown as DigestPayload;
    const found = payload.items?.find((i) => i.id === itemId);
    if (found) return found;
  }
  return null;
}

function briefTitle(text: string, label: string): string {
  const firstLine = text
    .replace(/^Trend:\s*/i, '')
    .split('\n')[0]!
    .trim();
  return `${label}: ${firstLine.slice(0, 80)}`;
}
