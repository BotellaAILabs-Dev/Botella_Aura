import { z } from 'zod';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import {
  completeStructured,
  isClaudeConfigured,
  DEFAULT_MODEL,
} from '@/server/ai/claude';
import {
  generateBrandVoiceProfile,
  brandVoiceToPrompt,
} from '@/server/content/brand-voice.service';
import { retrieve, chunksToContext } from '@/server/knowledge/retrieve';
import { getActiveMemories, memoriesToPrompt } from '@/server/memory/memory.service';
import { getLeadOrThrow } from '@/server/outreach/lead.service';

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
}): Promise<{ connectionNoteId: string; followupId: string; model: string }> {
  const { companyId, userId, leadId, requestMeta } = args;
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
  });

  const model = drafts.model;
  const created = await db.$transaction(async (tx) => {
    const note = await tx.outreachMessage.create({
      data: {
        leadId,
        companyId,
        type: 'CONNECTION_NOTE',
        status: 'DRAFT',
        draftText: drafts.connectionNote.slice(0, CONNECTION_NOTE_LIMIT),
        aiMetadata: { model, signalId: signal?.id ?? null, brandVoiceApplied: model !== 'none' },
      },
    });
    const followup = await tx.outreachMessage.create({
      data: {
        leadId,
        companyId,
        type: 'FOLLOWUP',
        status: 'DRAFT',
        draftText: drafts.followup,
        aiMetadata: { model, signalId: signal?.id ?? null, brandVoiceApplied: model !== 'none' },
      },
    });
    await tx.lead.update({ where: { id: leadId }, data: { status: 'DRAFTED' } });
    await recordAudit(
      {
        action: 'OUTREACH_DRAFTED',
        userId,
        companyId,
        metadata: { leadId, model },
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
    const voice = await generateBrandVoiceProfile({ company: company!, userId });
    // Sprint 5 — inject learned outreach patterns (empty when no data yet).
    const memoryBlock = memoriesToPrompt(await getActiveMemories(companyId), {
      types: ['OUTREACH_APPROACH', 'TIMING'],
    });

    const system = [
      `You write outreach on behalf of ${companyName}.`,
      brandVoiceToPrompt(voice),
      memoryBlock,
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
    ].join('\n\n');

    const result = await completeStructured({
      schema: draftSchema,
      system,
      prompt,
      maxTokens: 800,
      effort: 'medium',
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
