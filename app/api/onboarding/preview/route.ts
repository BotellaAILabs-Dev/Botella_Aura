import { z } from 'zod';
import { requireUser } from '@/lib/auth-helpers';
import { complete, isClaudeConfigured } from '@/server/ai/claude';
import { handleRouteError, jsonOk } from '@/lib/api';

export const maxDuration = 30;

/**
 * POST /api/onboarding/preview — generate a SHORT sample post so a user can
 * *hear* their brand voice during onboarding before committing. Nothing is
 * saved; this is a throwaway preview. Degrades to a friendly note when the AI
 * key isn't configured (never fabricates a "your voice" sample without it).
 */
const previewSchema = z.object({
  name: z.string().trim().min(1).max(80),
  industry: z.string().trim().max(80).optional().or(z.literal('')),
  brandVoiceNotes: z.string().trim().max(2000).optional().or(z.literal('')),
});

export async function POST(req: Request) {
  try {
    await requireUser();
    const input = previewSchema.parse(await req.json());

    if (!isClaudeConfigured()) {
      return jsonOk({
        sample: null,
        note: 'Add your AI key to preview a real sample in your voice.',
      });
    }

    const sample = await complete({
      system:
        `You are the social writer for ${input.name}` +
        (input.industry ? ` (${input.industry})` : '') +
        `. Brand voice: ${input.brandVoiceNotes || 'professional, practical, no hype'}. ` +
        'Write ONE short LinkedIn post (a punchy hook + 2 short lines) that sounds ' +
        'exactly like this brand. No hashtags, no preamble, no quotes — just the post.',
      prompt:
        'Write a sample LinkedIn post about a recent win or insight, in our voice.',
      maxTokens: 400,
      effort: 'low',
    });

    return jsonOk({ sample: sample.trim(), note: null });
  } catch (error) {
    return handleRouteError(error);
  }
}
