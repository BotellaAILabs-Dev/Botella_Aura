import type { Company, ContentDraft, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { recordAudit } from '@/server/services/audit.service';
import { completeStructured, getModel } from '@/server/ai/claude';
import { retrieve, chunksToContext } from '@/server/knowledge/retrieve';
import { politeFetchHtml } from '@/server/knowledge/robots';
import { htmlToText } from '@/server/knowledge/extract';
import { logger } from '@/lib/logger';
import {
  generateBrandVoiceProfile,
  brandVoiceToPrompt,
} from '@/server/content/brand-voice.service';
import {
  getAudienceProfile,
  audienceToPrompt,
  contentRulesFor,
} from '@/server/content/audience';
import { getActiveMemories, memoriesToPrompt } from '@/server/memory/memory.service';
import {
  bodySchemaFor,
  type ContentTypeKey,
  type GenerationSource,
} from '@/lib/validations/content';
import type { DigestPayload } from '@/server/trends/types';

/**
 * Content generator. Every call: resolve the brief → retrieve grounding chunks
 * → inject the brand voice profile → prompt Claude → validate structured output
 * against the per-type Zod schema → persist as a DRAFT ContentDraft. A call that
 * skips knowledge retrieval or brand voice is a bug (NON-NEGOTIABLE #5).
 */
// Bumped when the prompt changes materially, so a draft's aiMetadata records
// which set of instructions produced it. s4 added the audience block and the
// business-focus rules.
const PROMPT_VERSION = 's5.market-mode';

interface TypeSpec {
  label: string;
  schemaText: string;
  guidance: string;
}

const TYPE_SPECS: Record<ContentTypeKey, TypeSpec> = {
  LINKEDIN_POST: {
    label: 'LinkedIn post',
    schemaText:
      '{ "hook": string, "paragraphs": string[3..5], "hashtags": string[0..8] }',
    guidance:
      'A hook-first LinkedIn post. The hook is a scroll-stopping first line. ' +
      '3-5 SHORT paragraphs (1-3 sentences each), skimmable. End with a light CTA. ' +
      'Hashtags without the # symbol.',
  },
  CAROUSEL: {
    label: 'Carousel',
    schemaText:
      '{ "title": string, "slides": [{ "headline": string, "body": string }] (5..8), "hashtags": string[0..8] }',
    guidance:
      'A 5-8 slide carousel. Slide 1 is the cover (strong title). Each slide = ' +
      'one idea: a short headline + one supporting line. Last slide is a CTA.',
  },
  TWEET_THREAD: {
    label: 'X thread',
    schemaText: '{ "tweets": string[2..12] }',
    guidance:
      'A numbered X/Twitter thread. Tweet 1 is the hook. Each tweet <= 280 chars, ' +
      'punchy, one idea each. Do not prefix with numbers — the array order is the number.',
  },
  BLOG: {
    label: 'Blog draft',
    schemaText:
      '{ "headline": string, "subtitle": string, "sections": [{ "heading": string, "body": string }] (2..10), "tags": string[0..10] }',
    guidance:
      'A structured blog draft: compelling headline, one-line subtitle, and 2-10 ' +
      'sections each with a heading and 1-3 paragraphs of body.',
  },
};

interface GenerateArgs {
  companyId: string;
  /** Null when Autopilot wrote this unattended — createdById is nullable. */
  userId: string | null;
  type: ContentTypeKey;
  source: GenerationSource;
  campaignId?: string;
}

export async function generateDraft({
  companyId,
  userId,
  type,
  source,
  campaignId,
}: GenerateArgs): Promise<ContentDraft> {
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error('Company not found');

  const brief = await resolveBrief(company, source);
  const chunks = await retrieve(companyId, brief.query, { limit: 8 });
  // If the brief mentions a URL ("write about our flagship product: <url>"),
  // fetch that page LIVE and ground the post in its real content. This is what
  // makes "look at my website" actually work — the model can't browse on its own.
  const reference = await fetchReferenceContext(
    `${brief.text}\n${source.brief ?? ''}\n${company.website ?? ''}`,
  );
  const voice = await generateBrandVoiceProfile({ company, userId });
  // Who this is for. Reused from outreach targeting and discovery profiles —
  // the workspace already stated its buyers there.
  const audience = await getAudienceProfile(companyId);
  // Sprint 5 — inject learned performance patterns ("gets smarter every week").
  // Empty string when the company has no real insights yet, so fresh accounts
  // are unaffected (no fabricated guidance).
  const memoryBlock = memoriesToPrompt(await getActiveMemories(companyId), {
    types: ['CONTENT_FORMAT', 'CONTENT_LENGTH', 'TIMING', 'TOPIC', 'HASHTAG'],
  });

  const spec = TYPE_SPECS[type];
  const system = [
    `You are the content writer for ${company.name}.`,
    company.industry ? `They operate in: ${company.industry}.` : '',
    '',
    // The reader comes BEFORE the voice. Without it the model writes about the
    // subject rather than to a person, which is what "generic" actually is.
    audienceToPrompt(audience),
    '',
    brandVoiceToPrompt(voice),
    memoryBlock,
    '',
    contentRulesFor(audience?.mode),
    '',
    'Ground your writing in the company knowledge below — reflect their real ',
    'products, positioning, and facts. Do not invent product names or claims.',
    'Respond with ONLY valid JSON matching the schema. No markdown, no prose.',
  ]
    .filter(Boolean)
    .join('\n');

  const prompt = [
    `TASK: Write a ${spec.label}.`,
    spec.guidance,
    '',
    `TOPIC / BRIEF:\n${brief.text}`,
    reference
      ? `\nREFERENCE PAGE (fetched live from a link in your brief — use these REAL facts, product names, and positioning; do not go generic):\n${reference}`
      : '',
    '',
    `COMPANY KNOWLEDGE:\n${chunksToContext(chunks)}`,
    '',
    `Return JSON of this exact shape: ${spec.schemaText}`,
  ]
    .filter(Boolean)
    .join('\n');

  const body = await completeStructured({
    schema: bodySchemaFor(type),
    system,
    prompt,
    maxTokens: type === 'BLOG' ? 4000 : 2000,
    // Short posts don't need max reasoning — 'medium' is markedly faster with
    // no quality loss on hook-first posts; blogs keep 'high' for structure.
    effort: type === 'BLOG' ? 'high' : 'medium',
  });

  const aiMetadata: Prisma.InputJsonValue = {
    source: { kind: source.kind, ref: source.ref ?? null, brief: source.brief ?? null },
    // Recorded from the client rather than hardcoded, so the metadata stays
    // true when the model or its tier changes.
    model: getModel('premium'),
    promptVersion: PROMPT_VERSION,
    knowledgeChunkIds: chunks.map((c) => c.id),
    brandVoiceApplied: true,
    referenceUsed: reference.length > 0,
  };

  const draft = await db.contentDraft.create({
    data: {
      companyId,
      createdById: userId,
      campaignId: campaignId ?? null,
      type,
      status: 'DRAFT',
      title: briefTitle(brief.text, spec.label),
      body: body as object,
      aiMetadata,
    },
  });

  await recordAudit({
    action: 'CONTENT_DRAFT_CREATED',
    userId,
    companyId,
    metadata: { draftId: draft.id, type, source: source.kind },
  });
  return draft;
}

interface RefineArgs {
  draft: ContentDraft;
  userId: string;
  /** Optional feedback; when absent, a generic "regenerate a fresh take". */
  feedback?: string;
}

/** Regenerate/refine an existing draft with feedback, keeping the same type. */
export async function refineDraft({
  draft,
  userId,
  feedback,
}: RefineArgs): Promise<ContentDraft> {
  const company = await db.company.findUnique({ where: { id: draft.companyId } });
  if (!company) throw new Error('Company not found');

  const voice = await generateBrandVoiceProfile({ company, userId });
  // A revision is still content a customer publishes, so it gets the same
  // reader and the same rules. Without them, refining drifted back towards the
  // generic writing the first pass had been steered away from.
  const audience = await getAudienceProfile(draft.companyId);
  const spec = TYPE_SPECS[draft.type as ContentTypeKey];

  const system = [
    `You are the content writer for ${company.name}.`,
    '',
    audienceToPrompt(audience),
    '',
    brandVoiceToPrompt(voice),
    '',
    contentRulesFor(audience?.mode),
    '',
    'Revise the existing draft per the feedback. Keep what works.',
    'Respond with ONLY valid JSON matching the schema.',
  ].join('\n');

  const prompt = [
    `TASK: Revise this ${spec.label}.`,
    spec.guidance,
    '',
    `CURRENT DRAFT (JSON):\n${JSON.stringify(draft.body)}`,
    '',
    `FEEDBACK: ${feedback || 'Give a noticeably fresh take — different angle and hook, same topic and voice.'}`,
    '',
    `Return JSON of this exact shape: ${spec.schemaText}`,
  ].join('\n');

  const body = await completeStructured({
    schema: bodySchemaFor(draft.type as ContentTypeKey),
    system,
    prompt,
    maxTokens: draft.type === 'BLOG' ? 4000 : 2000,
    effort: 'high',
  });

  const updated = await db.contentDraft.update({
    where: { id: draft.id },
    // Regenerating returns a draft to DRAFT status (must be re-approved).
    data: { body: body as object, status: 'DRAFT' },
  });

  await recordAudit({
    action: 'CONTENT_REGENERATED',
    userId,
    companyId: draft.companyId,
    metadata: { draftId: draft.id, hadFeedback: Boolean(feedback) },
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
    const campaign = await db.campaign.findUnique({ where: { id: source.ref } });
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
  const fallback = source.brief?.trim() || `Write timely content for ${company.name}.`;
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
  const firstLine = text.replace(/^Trend:\s*/i, '').split('\n')[0]!.trim();
  return `${label}: ${firstLine.slice(0, 80)}`;
}
