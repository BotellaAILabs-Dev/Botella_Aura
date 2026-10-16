import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import {
  completeStructured,
  isClaudeConfigured,
  DEFAULT_MODEL,
} from '@/server/ai/claude';
import { generateBrandVoiceProfile } from '@/server/content/brand-voice.service';
import { retrieve, chunksToContext } from '@/server/knowledge/retrieve';
import {
  businessContextToPrompt,
  getBusinessContext,
  WORKFLOW_PRESETS,
} from '@/server/business-context/business-context.service';
import { getLeadOrThrow } from '@/server/outreach/lead.service';
import { outreachMetaAfter } from '@/server/approval/approval.service';
import { firstVersion, withMessageVersion } from '@/server/versions/version.service';
import { creationContextPrompt, readCreationContext, type CreationContext } from '@/lib/creation-handoff';

/**
 * AI outreach drafting (Sprint 4, Module 3). For a lead + its most recent
 * signal, generate a personalized connection note (LinkedIn's 300-char limit)
 * and a tasteful follow-up, grounded in the SAME brand-voice + knowledge-base
 * pattern as Content Studio (Sprint 3). Drafts land as OutreachMessage(DRAFT) —
 * nothing is sent until a human approves AND clicks send in the extension.
 * Degrades to a deterministic template when no ANTHROPIC_API_KEY is set.
 */
const CONNECTION_NOTE_LIMIT = 300;

const draftSchema = z.object({
  connectionNote: z.string().max(600),
  followup: z.string().max(1500),
});

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function draftForLead(args: {
  companyId: string;
  userId: string;
  leadId: string;
  requestMeta?: Meta;
  /**
   * Drafted from an Aura recommendation (lib/creation-handoff.ts): the
   * drafter follows its context, and each message keeps it — which also
   * holds its sending until execution arrives (lib/execution-gate.ts).
   */
  creation?: { context: CreationContext } | null;
}): Promise<{ connectionNoteId: string; followupId: string; model: string }> {
  const { companyId, userId, leadId, requestMeta, creation } = args;
  const lead = await getLeadOrThrow(companyId, leadId);
  const signal = await db.leadSignal.findFirst({
    where: { leadId },
    orderBy: { detectedAt: 'desc' },
  });
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error('Company not found.');

  const signalText = signal?.description ?? `recent activity at ${lead.companyName}`;
  const drafts = await buildDrafts({
    companyId,
    userId,
    companyName: company.name,
    leadName: lead.name,
    leadCompany: lead.companyName,
    signalText,
    contextPrompt: creation ? creationContextPrompt(creation.context) : null,
  });

  const model = drafts.model;
  // Kept on each message, like a draft's aiMetadata.recommendation.
  const fromSuggestion = creation
    ? { recommendation: creation.context.recommendation, creationContext: creation.context }
    : {};
  const created = await db.$transaction(async (tx) => {
    const note = await tx.outreachMessage.create({
      data: {
        leadId,
        companyId,
        type: 'CONNECTION_NOTE',
        status: 'DRAFT',
        draftText: drafts.connectionNote.slice(0, CONNECTION_NOTE_LIMIT),
        aiMetadata: {
          model,
          signalId: signal?.id ?? null,
          brandVoiceApplied: model !== 'none',
          versions: firstVersion(drafts.connectionNote.slice(0, CONNECTION_NOTE_LIMIT)),
          ...fromSuggestion,
        } as unknown as Prisma.InputJsonObject,
      },
    });
    const followup = await tx.outreachMessage.create({
      data: {
        leadId,
        companyId,
        type: 'FOLLOWUP',
        status: 'DRAFT',
        draftText: drafts.followup,
        aiMetadata: {
          model,
          signalId: signal?.id ?? null,
          brandVoiceApplied: model !== 'none',
          versions: firstVersion(drafts.followup),
          ...fromSuggestion,
        } as unknown as Prisma.InputJsonObject,
      },
    });
    await tx.lead.update({ where: { id: leadId }, data: { status: 'DRAFTED' } });
    await recordAudit(
      {
        action: 'OUTREACH_DRAFTED',
        userId,
        companyId,
        metadata: {
          leadId,
          model,
          ...(creation ? { recommendationId: creation.context.recommendation.recommendationId } : {}),
        },
        ...requestMeta,
      },
      tx,
    );
    return { note, followup };
  });

  return {
    connectionNoteId: created.note.id,
    followupId: created.followup.id,
    model,
  };
}

async function buildDrafts(args: {
  companyId: string;
  userId: string;
  companyName: string;
  leadName: string | null;
  leadCompany: string;
  signalText: string;
  /** Drafted from a recommendation: its context (creationContextPrompt). */
  contextPrompt?: string | null;
}): Promise<{ connectionNote: string; followup: string; model: string }> {
  const { companyId, userId, companyName, leadName, leadCompany, signalText } = args;

  if (!isClaudeConfigured()) {
    return { ...deterministicDrafts(companyName, leadName, leadCompany, signalText), model: 'none' };
  }

  try {
    const [company, chunks] = await Promise.all([
      db.company.findUnique({ where: { id: companyId } }),
      retrieve(companyId, `${leadCompany} ${signalText}`, { limit: 4 }),
    ]);
    await generateBrandVoiceProfile({ company: company!, userId });
    /**
     * What we do, how we sound, and what has worked in outreach — from the
     * Business Context layer's `outreach` preset.
     *
     * Deliberately no audience block: outreach is addressed to one named
     * lead, and the workspace's general buyer persona would fight the
     * specific person in the prompt below. Knowledge passages stay in the
     * user prompt, retrieved against this lead's signal.
     */
    const context = await getBusinessContext(companyId, { sections: ['memory'] });

    const system = [
      `You write outreach on behalf of ${companyName}.`,
      businessContextToPrompt(context, { ...WORKFLOW_PRESETS.outreach, knowledge: false }),
      'Rules: reference the ACTUAL signal naturally; be specific and human, not ' +
        'salesy or generic; no flattery cliches. The connectionNote MUST be under ' +
        '300 characters (LinkedIn limit). The followup is a short message to send ' +
        'ONLY after the connection is accepted. Respond with ONLY JSON: ' +
        '{"connectionNote": string, "followup": string}.',
    ].join('\n');

    const prompt = [
      `Lead: ${leadName ? `${leadName} at ` : ''}${leadCompany}`,
      `Detected signal: ${signalText}`,
      `Your company context:\n${chunksToContext(chunks)}`,
      // Drafted for Aura's suggestion: the angle, goal, CTA and rules it carries.
      // The lead's own signal still opens the message.
      args.contextPrompt ? `This outreach carries out Aura's suggestion:\n${args.contextPrompt}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const result = await completeStructured({
      schema: draftSchema,
      system,
      prompt,
      maxTokens: 800,
      effort: 'medium',
      tier: 'standard',
    });
    return {
      connectionNote: result.connectionNote.trim(),
      followup: result.followup.trim(),
      model: DEFAULT_MODEL,
    };
  } catch (err) {
    logger.warn('outreach: AI draft failed, using deterministic template', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...deterministicDrafts(companyName, leadName, leadCompany, signalText), model: 'none' };
  }
}

function deterministicDrafts(
  companyName: string,
  leadName: string | null,
  leadCompany: string,
  signalText: string,
): { connectionNote: string; followup: string } {
  const hi = leadName ? `Hi ${leadName.split(' ')[0]}` : 'Hi there';
  const note =
    `${hi} — noticed ${leadCompany}: ${signalText}. I'm with ${companyName} and ` +
    `thought it'd be worth connecting.`.slice(0, CONNECTION_NOTE_LIMIT);
  const followup =
    `Thanks for connecting! I reached out because of ${signalText}. ` +
    `At ${companyName} we work with teams like ${leadCompany} on exactly this — ` +
    `happy to share a couple of relevant ideas if useful. No pressure either way.`;
  return { connectionNote: note, followup };
}

/**
 * Regenerate ONE message in place (the unified review's Regenerate): a fresh
 * draft of the same type for the same lead and signal. The previous text is
 * kept in aiMetadata.history, and the message returns to DRAFT — it must be
 * approved again.
 */
export async function regenerateMessage(args: {
  companyId: string;
  userId: string;
  messageId: string;
  requestMeta?: Meta;
}) {
  const { companyId, userId, messageId, requestMeta } = args;
  const msg = await db.outreachMessage.findFirst({
    where: { id: messageId, companyId },
    include: { lead: true },
  });
  if (!msg) throw Object.assign(new Error('Message not found.'), { status: 404 });
  if (msg.status === 'SENT') {
    throw Object.assign(new Error('A sent message cannot be regenerated.'), { status: 409 });
  }
  const meta = (msg.aiMetadata ?? {}) as Record<string, unknown>;
  const signal =
    (typeof meta.signalId === 'string'
      ? await db.leadSignal.findFirst({ where: { id: meta.signalId, leadId: msg.leadId } })
      : null) ??
    (await db.leadSignal.findFirst({ where: { leadId: msg.leadId }, orderBy: { detectedAt: 'desc' } }));
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error('Company not found.');

  const stored = readCreationContext(meta.creationContext);
  const drafts = await buildDrafts({
    companyId,
    userId,
    companyName: company.name,
    leadName: msg.lead.name,
    leadCompany: msg.lead.companyName,
    signalText: signal?.description ?? `recent activity at ${msg.lead.companyName}`,
    contextPrompt: stored ? creationContextPrompt(stored) : null,
  });
  const draftText =
    msg.type === 'CONNECTION_NOTE'
      ? drafts.connectionNote.slice(0, CONNECTION_NOTE_LIMIT)
      : drafts.followup;
  const history = [
    { text: msg.draftText, at: new Date().toISOString(), status: msg.status },
    ...((Array.isArray(meta.history) ? meta.history : []) as unknown[]),
  ].slice(0, 5);

  return db.$transaction(async (tx) => {
    const updated = await tx.outreachMessage.update({
      where: { id: msg.id },
      data: {
        draftText,
        status: 'DRAFT',
        rejectionReason: null,
        // Regeneration history on the approval record, too.
        aiMetadata: withMessageVersion(msg, outreachMetaAfter(
          {
            ...msg,
            aiMetadata: {
              ...meta,
              model: drafts.model,
              signalId: signal?.id ?? null,
              brandVoiceApplied: drafts.model !== 'none',
              history,
              regeneratedAt: new Date().toISOString(),
            } as unknown as Prisma.JsonValue,
          },
          { action: 'regenerated', by: userId, nextStatus: 'DRAFT', nextText: draftText },
        ), { text: draftText, source: 'regenerated', by: userId }),
      },
    });
    await recordAudit(
      {
        action: 'OUTREACH_DRAFTED',
        userId,
        companyId,
        metadata: { messageId: msg.id, regenerated: true, model: drafts.model },
        ...requestMeta,
      },
      tx,
    );
    return updated;
  });
}
