import type { Company } from '@prisma/client';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { completeStructured, isClaudeConfigured } from '@/server/ai/claude';
import { retrieve, chunksToContext } from '@/server/knowledge/retrieve';
import {
  brandVoiceProfileSchema,
  type BrandVoiceProfile,
} from '@/lib/validations/content';

/**
 * Brand Voice Profile — the single most important quality lever in Content
 * Studio. Generated once from the company's ingested content + onboarding
 * notes, then human-editable. EVERY generation prompt injects it (see
 * server/content/generator.ts) so output sounds like *their* company.
 */

export function getBrandVoiceProfile(
  company: Pick<Company, 'brandVoiceProfile'>,
): BrandVoiceProfile | null {
  if (!company.brandVoiceProfile) return null;
  const parsed = brandVoiceProfileSchema.safeParse(company.brandVoiceProfile);
  return parsed.success ? parsed.data : null;
}

interface GenerateArgs {
  company: Pick<Company, 'id' | 'name' | 'industry' | 'brandVoiceNotes' | 'brandVoiceProfile'>;
  userId?: string | null;
  force?: boolean;
}

/**
 * Generate (or return existing) brand voice profile. Uses Claude when
 * configured — grounded in retrieved knowledge chunks — otherwise a heuristic
 * built from the onboarding brand-voice notes so the product still works.
 */
export async function generateBrandVoiceProfile({
  company,
  userId,
  force = false,
}: GenerateArgs): Promise<BrandVoiceProfile> {
  const existing = getBrandVoiceProfile(company);
  if (existing && !force) return existing;

  let profile: BrandVoiceProfile;
  let source = 'heuristic';

  if (isClaudeConfigured()) {
    try {
      const chunks = await retrieve(company.id, `${company.name} ${company.industry ?? ''}`, {
        limit: 8,
      });
      profile = await completeStructured({
        schema: brandVoiceProfileSchema,
        system:
          'You are a brand strategist. Analyze a company\'s existing content ' +
          'and notes, then produce a structured brand voice profile that a ' +
          'writer could follow to sound exactly like this company. Respond with ' +
          'ONLY JSON matching the schema.',
        prompt: buildPrompt(company, chunksToContext(chunks)),
        maxTokens: 1500,
        effort: 'medium',
        tier: 'standard',
      });
      source = 'claude';
    } catch (err) {
      logger.warn('brand-voice: Claude generation failed, using heuristic', {
        error: err instanceof Error ? err.message : String(err),
      });
      profile = heuristicProfile(company);
    }
  } else {
    profile = heuristicProfile(company);
  }

  await db.company.update({
    where: { id: company.id },
    data: { brandVoiceProfile: profile },
  });
  await recordAudit({
    action: 'BRAND_VOICE_GENERATED',
    userId: userId ?? null,
    companyId: company.id,
    metadata: { source },
  });
  return profile;
}

export async function updateBrandVoiceProfile(
  companyId: string,
  userId: string,
  input: unknown,
): Promise<BrandVoiceProfile> {
  const profile = brandVoiceProfileSchema.parse(input);
  await db.company.update({
    where: { id: companyId },
    data: { brandVoiceProfile: profile },
  });
  await recordAudit({
    action: 'BRAND_VOICE_UPDATED',
    userId,
    companyId,
    metadata: {},
  });
  return profile;
}

function buildPrompt(
  company: Pick<Company, 'name' | 'industry' | 'brandVoiceNotes'>,
  knowledge: string,
): string {
  return [
    `Company: ${company.name}`,
    `Industry: ${company.industry ?? 'unknown'}`,
    `Onboarding brand-voice notes: ${company.brandVoiceNotes || '(none)'}`,
    '',
    'Samples of their existing content:',
    knowledge,
    '',
    'Produce JSON of shape: {',
    '  toneDescriptors: string[] (e.g. "confident","warm","practical"),',
    '  sentenceLength: "short"|"medium"|"long"|"varied",',
    '  vocabulary: string[] (signature words/terms they use),',
    '  commonPhrases: string[] (recurring phrases),',
    '  topicsToAvoid: string[] (things off-brand or that they never say),',
    '  formatting: { emojiUsage: string, hashtagStyle: string, notes: string },',
    '  summary: string (2-3 sentences a writer could follow)',
    '}',
  ].join('\n');
}

/** Deterministic fallback derived from the onboarding notes. */
function heuristicProfile(
  company: Pick<Company, 'brandVoiceNotes' | 'industry'>,
): BrandVoiceProfile {
  const notes = (company.brandVoiceNotes ?? '').trim();
  return brandVoiceProfileSchema.parse({
    toneDescriptors: notes ? ['on-brand', 'professional', 'practical'] : ['professional', 'clear'],
    sentenceLength: 'varied',
    vocabulary: [],
    commonPhrases: [],
    topicsToAvoid: [],
    formatting: { emojiUsage: 'minimal', hashtagStyle: 'a few relevant hashtags', notes: '' },
    summary:
      notes ||
      `Clear, professional ${company.industry ?? 'B2B'} voice. Practical and specific, no hype.`,
  });
}

/** Render the profile as a compact instruction block for generation prompts. */
export function brandVoiceToPrompt(profile: BrandVoiceProfile): string {
  const f = profile.formatting;
  return [
    'BRAND VOICE — write exactly in this voice:',
    `- Tone: ${profile.toneDescriptors.join(', ') || 'professional'}`,
    `- Sentence length: ${profile.sentenceLength}`,
    profile.vocabulary.length ? `- Preferred vocabulary: ${profile.vocabulary.join(', ')}` : '',
    profile.commonPhrases.length ? `- Signature phrases: ${profile.commonPhrases.join('; ')}` : '',
    profile.topicsToAvoid.length ? `- NEVER mention / avoid: ${profile.topicsToAvoid.join(', ')}` : '',
    `- Emoji: ${f.emojiUsage}. Hashtags: ${f.hashtagStyle}.`,
    f.notes ? `- Formatting notes: ${f.notes}` : '',
    profile.summary ? `- Summary: ${profile.summary}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
