import Anthropic from '@anthropic-ai/sdk';
import type { z, ZodTypeAny } from 'zod';
import { logger } from '@/lib/logger';

/**
 * Shared Claude (Anthropic) service. This is the ONE place the app talks to the
 * model — Trend Intelligence uses it now; Content Studio (Sprint 3) and Outreach
 * (Sprint 4) will reuse it. Keeping model choice, prompting conventions, error
 * handling, and retry policy here means those sprints inherit a battle-tested
 * client instead of re-implementing it.
 *
 * Defaults: claude-opus-4-8 with adaptive thinking. Long generations stream
 * (avoids HTTP timeouts on large max_tokens). One automatic retry on transient
 * failure; a clear typed error otherwise so callers can fall back gracefully.
 */
export const DEFAULT_MODEL = 'claude-opus-4-8';
const STREAM_THRESHOLD_TOKENS = 8000;

export class ClaudeNotConfiguredError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not configured.');
    this.name = 'ClaudeNotConfiguredError';
  }
}

export function isClaudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function getModel(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!isClaudeConfigured()) throw new ClaudeNotConfiguredError();
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return client;
}

export interface CompleteOptions {
  system?: string;
  prompt: string;
  /** Output cap. Streams automatically when large. Default 2048. */
  maxTokens?: number;
  /** Thinking depth. Default 'high' for quality; 'low' for cheap calls. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** Run one prompt and return the concatenated text output. Retries once. */
export async function complete(options: CompleteOptions): Promise<string> {
  const { system, prompt, maxTokens = 2048, effort = 'high' } = options;
  const model = getModel();

  const run = async (): Promise<string> => {
    const c = getClient();
    const params = {
      model,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' as const },
      output_config: { effort },
      ...(system ? { system } : {}),
      messages: [{ role: 'user' as const, content: prompt }],
    };

    // Stream large outputs to avoid request timeouts; otherwise plain create.
    if (maxTokens >= STREAM_THRESHOLD_TOKENS) {
      const stream = getClient().messages.stream(params);
      const msg = await stream.finalMessage();
      return extractText(msg.content);
    }
    const msg = await c.messages.create(params);
    return extractText(msg.content);
  };

  try {
    return await run();
  } catch (err) {
    logger.warn('Claude: first attempt failed, retrying once', {
      error: err instanceof Error ? err.message : String(err),
    });
    return run();
  }
}

/**
 * Run a prompt expected to return JSON and parse it. The prompt/system should
 * instruct the model to output ONLY JSON; we defensively strip code fences and
 * isolate the outermost JSON value before parsing. Retries once on API failure;
 * a parse failure throws so the caller can fall back.
 */
export async function completeJson<T>(options: CompleteOptions): Promise<T> {
  const text = await complete(options);
  return parseJson<T>(text);
}

/**
 * Generate JSON and validate it against a Zod schema. On a parse/validation
 * failure, retry ONCE with a clarifying instruction that echoes the error and
 * the exact shape required; if the retry still fails, throw. This is the
 * guarantee behind "never save malformed content" (Content Studio, S3).
 */
export async function completeStructured<S extends ZodTypeAny>(
  options: CompleteOptions & { schema: S },
): Promise<z.infer<S>> {
  const { schema, ...rest } = options;

  const attempt = async (extra?: string): Promise<z.infer<S>> => {
    const prompt = extra ? `${rest.prompt}\n\n${extra}` : rest.prompt;
    const text = await complete({ ...rest, prompt });
    const parsed = schema.safeParse(parseJson<unknown>(text));
    if (!parsed.success) {
      throw new SchemaValidationError(parsed.error.message, text);
    }
    return parsed.data;
  };

  try {
    return await attempt();
  } catch (err) {
    const detail =
      err instanceof SchemaValidationError ? err.message : String(err);
    logger.warn('completeStructured: first attempt invalid, retrying once', {
      detail: detail.slice(0, 300),
    });
    return attempt(
      'Your previous response did not match the required JSON schema. ' +
        `Validation errors: ${detail.slice(0, 500)}. ` +
        'Respond again with ONLY valid JSON matching the exact schema described above — no prose, no markdown fences.',
    );
  }
}

export class SchemaValidationError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

function extractText(
  content: Array<{ type: string; text?: string }>,
): string {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
}

/** Tolerant JSON extraction — handles ```json fences and surrounding prose. */
export function parseJson<T>(raw: string): T {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) s = fence[1].trim();
  // Isolate the outermost array/object if the model added stray text.
  const firstBrace = s.search(/[[{]/);
  const lastBrace = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(s) as T;
}
