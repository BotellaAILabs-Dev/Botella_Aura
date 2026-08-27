import { z } from 'zod';
import { requireUser } from '@/lib/auth-helpers';
import {
  complete,
  ClaudeNotConfiguredError,
  isClaudeConfigured,
} from '@/server/ai/claude';
import { logger } from '@/lib/logger';
import { handleRouteError, jsonOk } from '@/lib/api';

/**
 * A sample post is short, but it needs room: the model budget covers thinking
 * as well as the reply. Asking for 400 tokens is what starved the original
 * call and returned an empty completion, which the UI reported as "Could not
 * generate a preview". server/ai/claude.ts now skips thinking for low-effort
 * calls; this ceiling is the belt to that braces.
 */
const MAX_TOKENS = 1200;
const ATTEMPTS = 2;

// A first AI call on a cold provider connection can be slow; 30s was tight.
export const maxDuration = 60;

/**
 * POST /api/onboarding/preview — generate a SHORT sample post so a user can
 * *hear* their brand voice during onboarding before committing. Nothing is
 * saved; this is a throwaway preview.
 *
 * This is the first AI action a new user ever sees, so it never returns a bare
 * 500: on failure it answers 200 with `sample: null` and a specific,
 * retryable note. Onboarding must not be blocked by a preview.
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
        retryable: false,
      });
    }

    const system =
      `You are the social writer for ${input.name}` +
      (input.industry ? ` (${input.industry})` : '') +
      `. Brand voice: ${input.brandVoiceNotes || 'professional, practical, no hype'}. ` +
      'Write ONE short LinkedIn post (a punchy hook + 2 short lines) that sounds ' +
      'exactly like this brand. No hashtags, no preamble, no quotes — just the post.';

    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const sample = await complete({
          system,
          prompt:
            'Write a sample LinkedIn post about a recent win or insight, in our voice.',
          maxTokens: MAX_TOKENS,
          effort: 'low',
          timeoutMs: 45_000,
        });
        return jsonOk({ sample: sample.trim(), note: null, retryable: false });
      } catch (err) {
        lastError = err;
        if (err instanceof ClaudeNotConfiguredError) break;
      }
    }

    // Engineering sees every failure here without waiting for a user report —
    // this call failing is a genuine incident, not a routine empty state.
    const detail =
      lastError instanceof Error ? lastError.message : String(lastError);
    logger.error('onboarding/preview: sample generation failed', {
      company: input.name,
      attempts: ATTEMPTS,
      error: detail,
    });

    return jsonOk({
      sample: null,
      note:
        'We could not reach the AI service just now, so the sample is unavailable. ' +
        'Your brand voice is still saved — you can continue and preview it later from Content Studio.',
      retryable: true,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
