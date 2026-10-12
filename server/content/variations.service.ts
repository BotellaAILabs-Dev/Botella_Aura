import { z } from 'zod';
import type { ContentDraft, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { ctaRequired, FORMAT_SPECS } from '@/lib/content-formats';
import { playbookFor, TONE_GUIDANCE } from '@/lib/content-playbook';
import type { QualityReport } from '@/lib/content-quality';
import {
  addVersion,
  availableVariations,
  extractFacts,
  FIELD_LIMIT,
  findIntroducedFacts,
  HEADLINE_FIELD,
  preserveInstructions,
  VARIATION_LABELS,
  variationInstruction,
  withField,
  type DraftVersion,
  type PreserveContext,
  type VariationKind,
} from '@/lib/content-variations';
import { redactSensitive } from '@/lib/generation-context';
import { platformSpec, type SocialPlatformKey } from '@/lib/platforms';
import {
  bodySchemaFor,
  type ContentTone,
  type ContentTypeKey,
} from '@/lib/validations/content';
import { completeStructured } from '@/server/ai/claude';
import { checkAndRepair } from '@/server/content/generator';
import {
  chunkText,
  loadWritingContext,
  writingPlatform,
} from '@/server/content/quality.service';
import { renderForManual } from '@/server/content/render';
import { recordAudit } from '@/server/services/audit.service';

/**
 * Making a variation of a draft (lib/content-variations.ts holds the rules).
 *
 * The draft itself is not touched: the variation is added to its versions,
 * to be read on its own and chosen (or not) — choosing is switchVariation,
 * which is undoable. Before anything is added, the version in use is saved as
 * it currently reads, so a hand edit is never lost to a switch.
 */

export class VariationError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'VariationError';
  }
}

interface DraftMeta {
  variations?: DraftVersion[];
  activeVariation?: number;
  source?: { brief?: string | null };
  knowledgeChunkIds?: unknown;
  brief?: {
    marketingGoal?: { value?: string } | null;
    targetAudience?: { value?: string } | null;
    keyMessage?: { value?: string } | null;
    evidence?: { label?: string }[];
    cta?: { expected?: boolean; destination?: { value?: string } | null };
    brandVoice?: { summary?: string | null; avoid?: string[] } | null;
  } | null;
  recommendation?: {
    goal?: string | null;
    audience?: string | null;
    evidence?: { label?: string }[];
  } | null;
  [key: string]: unknown;
}

const textOf = (type: ContentTypeKey, body: unknown) =>
  renderForManual({ type, body } as unknown as ContentDraft);

/** What the variation must keep, from the brief the draft was written from. */
function preserveContextFor(
  draft: ContentDraft,
  meta: DraftMeta,
  avoid: string[],
): PreserveContext {
  const b = meta.brief ?? null;
  const r = meta.recommendation ?? null;
  const type = draft.type as ContentTypeKey;
  return {
    goal: b?.marketingGoal?.value ?? r?.goal ?? null,
    audience: b?.targetAudience?.value ?? r?.audience ?? null,
    keyMessage: b?.keyMessage?.value ?? null,
    evidence: (b?.evidence ?? r?.evidence ?? [])
      .map((e) => e.label ?? '')
      .filter(Boolean),
    ctaDestination: b?.cta?.destination?.value ?? null,
    avoid: [...new Set([...(b?.brandVoice?.avoid ?? []), ...avoid])],
    voice: b?.brandVoice?.summary ?? null,
    facts: extractFacts(textOf(type, draft.body)),
  };
}

export async function createVariation(args: {
  draft: ContentDraft;
  userId: string;
  kind: Exclude<VariationKind, 'image'>;
  tone?: ContentTone;
  platform?: SocialPlatformKey;
}): Promise<{ index: number; version: DraftVersion }> {
  const { draft, userId, kind } = args;
  const type = draft.type as ContentTypeKey;
  if (draft.status === 'PUBLISHED') {
    throw new VariationError(
      'Published content cannot be varied — duplicate it instead.',
    );
  }
  const currentPlatform = writingPlatform(type, draft.platform);
  const option = availableVariations(type, currentPlatform).find(
    (o) => o.kind === kind,
  );
  if (!option?.available) {
    throw new VariationError(
      option?.reason ?? 'That variation is not available for this format.',
      400,
    );
  }
  if (kind === 'tone' && !args.tone)
    throw new VariationError('Pick a tone.', 400);
  if (
    kind === 'channel' &&
    (!args.platform || !option.platforms?.includes(args.platform))
  ) {
    throw new VariationError('Pick a channel this format runs on.', 400);
  }

  const meta = (draft.aiMetadata ?? {}) as DraftMeta;
  const w = await loadWritingContext(draft.companyId, {
    campaignId: draft.campaignId,
  });
  const keep = preserveContextFor(draft, meta, w.avoid);
  const targetPlatform = kind === 'channel' ? args.platform! : currentPlatform;
  const playbook = playbookFor(type, targetPlatform);
  const knowledge = redactSensitive(
    await chunkText(draft.companyId, meta.knowledgeChunkIds),
    {
      personal: true,
    },
  ).text;
  const sources = [
    meta.source?.brief ?? '',
    knowledge,
    ...keep.evidence,
    keep.ctaDestination ?? '',
  ];
  const originalText = textOf(type, draft.body);
  const field =
    kind === 'cta' ? 'cta' : kind === 'headline' ? HEADLINE_FIELD[type] : null;

  const instruction = variationInstruction(kind, {
    ...(args.tone ? { toneGuidance: TONE_GUIDANCE[args.tone] } : {}),
    platform: targetPlatform,
    field,
  });

  /** One writing pass; `fix` names facts to restore on the second. */
  const write = async (fix?: string[]): Promise<unknown> => {
    const prompt = [
      `TASK: Make a variation of this ${playbook.label}. ${instruction}`,
      '',
      preserveInstructions(keep),
      fix?.length
        ? `\nYOUR LAST VERSION CHANGED OR INVENTED THESE FACTS: ${fix.join(' · ')}. Use only the facts in the current version and the evidence above.`
        : '',
      '',
      `HOW THIS FORMAT WORKS${targetPlatform ? ` ON ${platformSpec(targetPlatform).label.toUpperCase()}` : ''}:\n${playbook.rules.map((r) => `- ${r}`).join('\n')}`,
      '',
      `CURRENT VERSION (JSON):\n${JSON.stringify(draft.body)}`,
      knowledge
        ? `\nCOMPANY KNOWLEDGE (facts you may use):\n${knowledge.slice(0, 4000)}`
        : '',
      '',
      field
        ? `Return JSON of this exact shape: { "value": string } — the new \`${field}\` text only, at most ${FIELD_LIMIT(field)} characters.`
        : `Return JSON of this exact shape: ${FORMAT_SPECS[type].output.schemaText}`,
    ]
      .filter((l) => l !== '')
      .join('\n');
    if (field) {
      const { value } = await completeStructured({
        schema: z.object({
          value: z.string().trim().min(1).max(FIELD_LIMIT(field)),
        }),
        system: w.system,
        prompt,
        maxTokens: 600,
        effort: 'low',
      });
      // Only that field changes — the rest is the current version, as it is.
      return withField(draft.body, field, value);
    }
    return completeStructured({
      schema: bodySchemaFor(type),
      system: w.system,
      prompt,
      maxTokens: type === 'BLOG' ? 4000 : 1600,
      effort: type === 'BLOG' ? 'high' : 'medium',
    });
  };

  let body = await write();
  let introduced = findIntroducedFacts(
    originalText,
    textOf(type, body),
    sources,
  );
  let corrected = false;
  if (introduced.length) {
    // Facts are never changed to make a version different: one correction pass.
    logger.info('variation: facts changed, asking for a correction', {
      draftId: draft.id,
      kind,
      introduced,
    });
    body = await write(introduced);
    corrected = true;
    introduced = findIntroducedFacts(originalText, textOf(type, body), sources);
  }

  const checked = await checkAndRepair({
    type,
    body,
    w,
    platform: targetPlatform,
    sources: [originalText, ...sources].filter(Boolean),
    ctaRequired: ctaRequired(type, meta.brief?.cta?.expected ?? null),
  });
  // Re-check after the quality repair, which may have rewritten copy too.
  introduced = findIntroducedFacts(
    originalText,
    textOf(type, checked.body),
    sources,
  );
  const quality: QualityReport = introduced.length
    ? {
        ...checked.quality,
        approvable: false,
        issues: [
          ...checked.quality.issues,
          {
            code: 'facts-changed',
            severity: 'block',
            message: `This version changes facts from the original: ${introduced.join(', ')}. Edit them back, or keep the original.`,
          },
        ],
      }
    : checked.quality;

  // Save the version in use as it reads now (a hand edit is kept), then add.
  const versions: DraftVersion[] =
    Array.isArray(meta.variations) && meta.variations.length
      ? [...meta.variations]
      : [{ angle: 'Original', body: draft.body, kind: 'original' }];
  const active = Math.min(meta.activeVariation ?? 0, versions.length - 1);
  versions[active] = { ...versions[active]!, body: draft.body };

  const label =
    kind === 'tone' && args.tone
      ? `${args.tone[0]!.toUpperCase()}${args.tone.slice(1)} tone`
      : kind === 'channel'
        ? `For ${platformSpec(targetPlatform!).label}`
        : VARIATION_LABELS[kind];
  const version: DraftVersion = {
    angle: label,
    body: checked.body,
    quality,
    kind,
    basedOn: active,
    createdAt: new Date().toISOString(),
    ...(kind === 'channel' ? { platform: targetPlatform! } : {}),
    ...(args.tone ? { tone: args.tone } : {}),
    facts: { introduced, corrected },
  };
  const next = addVersion(versions, active, version);

  await db.contentDraft.update({
    where: { id: draft.id },
    data: {
      aiMetadata: {
        ...meta,
        variations: next.versions,
        activeVariation: next.active,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  await recordAudit({
    action: 'CONTENT_REGENERATED',
    userId,
    companyId: draft.companyId,
    metadata: {
      draftId: draft.id,
      variation: kind,
      ...(args.tone ? { tone: args.tone } : {}),
      ...(kind === 'channel' ? { platform: targetPlatform } : {}),
      factsKept: introduced.length === 0,
      corrected,
      approvable: quality.approvable,
    },
  });
  return { index: next.index, version };
}

/**
 * What "Another image" sends to the graphics workflow: the prompt of the
 * latest image for this draft (so the new one is a sibling of it), else a
 * prompt written from the visual brief. Generation itself goes through the
 * graphics route, which applies the plan's allowance and rate limits.
 */
export async function imageVariationRequest(draft: ContentDraft): Promise<{
  prompt: string;
  negativePrompt?: string;
  style: string;
  aspectRatio?: string;
  from: 'latest_image' | 'visual_brief';
}> {
  const latest = await db.generatedAsset.findFirst({
    where: {
      companyId: draft.companyId,
      contentDraftId: draft.id,
      kind: 'IMAGE',
    },
    orderBy: { createdAt: 'desc' },
    select: {
      prompt: true,
      negativePrompt: true,
      style: true,
      aspectRatio: true,
    },
  });
  if (latest?.prompt && latest.prompt.length >= 20) {
    return {
      prompt: (latest.prompt.split('\n\nStyle:')[0] ?? latest.prompt).slice(
        0,
        1500,
      ),
      ...(latest.negativePrompt
        ? { negativePrompt: latest.negativePrompt }
        : {}),
      style: latest.style ?? 'professional',
      ...(latest.aspectRatio ? { aspectRatio: latest.aspectRatio } : {}),
      from: 'latest_image',
    };
  }
  const { generateImagePrompt } =
    await import('@/server/media/image-prompt.service');
  const platform =
    writingPlatform(draft.type as ContentTypeKey, draft.platform) ?? 'LINKEDIN';
  const p = await generateImagePrompt({
    draft,
    userId: null,
    platform,
    style: 'professional',
  });
  return {
    prompt: p.prompt,
    ...(p.negativePrompt ? { negativePrompt: p.negativePrompt } : {}),
    style: 'professional',
    ...(p.visual ? { aspectRatio: p.visual.format.aspectRatio } : {}),
    from: 'visual_brief',
  };
}
