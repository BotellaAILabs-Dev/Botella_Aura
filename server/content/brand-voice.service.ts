import type { Company } from '@prisma/client';
import { logger } from '@/lib/logger';
import { updateBusinessContext } from '@/server/business-context/business-context-write.service';
import { completeStructured, isClaudeConfigured } from '@/server/ai/claude';
import { retrieve, chunksToContext } from '@/server/knowledge/retrieve';
import {
  brandVoiceProfileSchema,
  type BrandVoiceProfile,
} from '@/lib/validations/content';
import { redactSensitive } from '@/lib/generation-context';

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
        // The business's own material, with personal and secret data removed
        // before a model sees it (lib/generation-context.ts).
        prompt: buildPrompt(
          company,
          redactSensitive(chunksToContext(chunks), { personal: true }).text,
        ),
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

  // Written as an AI-originated change, which the update rules limit to the
  // voice profile: generation can never overwrite what the business stated.
  await updateBusinessContext({
    companyId: company.id,
    userId: userId ?? null,
    patch: { voice: { profile } },
    origin: 'ai',
    auditAction: 'BRAND_VOICE_GENERATED',
    auditMetadata: { source },
  });
  return profile;
}

export async function updateBrandVoiceProfile(
  companyId: string,
  userId: string,
  input: unknown,
): Promise<BrandVoiceProfile> {
  const profile = brandVoiceProfileSchema.parse(input);
  await updateBusinessContext({
    companyId,
    userId,
    patch: { voice: { profile } },
    origin: 'settings',
    // Saving the card is a person reviewing the voice, so it is confirmed even
    // when nothing was edited — the AI draft becomes the business's own voice.
    confirm: ['voice.profile'],
    aliases: { 'voice.profile': 'profile' },
    auditAction: 'BRAND_VOICE_UPDATED',
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
