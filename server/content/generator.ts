import type { Company, ContentDraft, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { recordAudit } from '@/server/services/audit.service';
import { completeStructured } from '@/server/ai/claude';
import { retrieve, chunksToContext } from '@/server/knowledge/retrieve';
import {
  generateBrandVoiceProfile,
  brandVoiceToPrompt,
} from '@/server/content/brand-voice.service';
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
const PROMPT_VERSION = 's3.1';

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
  userId: string;
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
  const chunks = await retrieve(companyId, brief.query, { limit: 6 });
  const voice = await generateBrandVoiceProfile({ company, userId });

  const spec = TYPE_SPECS[type];
  const system = [
    `You are the content writer for ${company.name}.`,
    brandVoiceToPrompt(voice),
    '',
    'Ground your writing in the company knowledge below — reflect their real ',
    'products, positioning, and facts. Do not invent product names or claims.',
    'Respond with ONLY valid JSON matching the schema. No markdown, no prose.',
  ].join('\n');

  const prompt = [
    `TASK: Write a ${spec.label}.`,
    spec.guidance,
    '',
    `TOPIC / BRIEF:\n${brief.text}`,
    '',
    `COMPANY KNOWLEDGE:\n${chunksToContext(chunks)}`,
    '',
    `Return JSON of this exact shape: ${spec.schemaText}`,
  ].join('\n');

  const body = await completeStructured({
    schema: bodySchemaFor(type),
    system,
    prompt,
    maxTokens: type === 'BLOG' ? 4000 : 2000,
    effort: 'high',
  });

  const aiMetadata: Prisma.InputJsonValue = {
    source: { kind: source.kind, ref: source.ref ?? null, brief: source.brief ?? null },
    model: 'claude-opus-4-8',
    promptVersion: PROMPT_VERSION,
    knowledgeChunkIds: chunks.map((c) => c.id),
    brandVoiceApplied: true,
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
  const spec = TYPE_SPECS[draft.type as ContentTypeKey];

  const system = [
    `You are the content writer for ${company.name}.`,
    brandVoiceToPrompt(voice),
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
