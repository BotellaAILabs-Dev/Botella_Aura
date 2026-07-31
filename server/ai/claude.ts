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
const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
const STREAM_THRESHOLD_TOKENS = 8000;

export class ClaudeNotConfiguredError extends Error {
  constructor() {
    super('No AI provider configured (set ANTHROPIC_API_KEY or GEMINI_API_KEY).');
    this.name = 'ClaudeNotConfiguredError';
  }
}

function hasAnthropic(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY);
}

/**
 * "Is an AI provider available?" — kept under the original name so every call
 * site that gates AI-vs-fallback keeps working. True if EITHER Anthropic
 * (preferred) or Gemini is configured.
 */
export function isClaudeConfigured(): boolean {
  return hasAnthropic() || isGeminiConfigured();
}

export function getModel(): string {
  if (hasAnthropic()) return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  return process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

function geminiKey(): string {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY)!;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!hasAnthropic()) throw new ClaudeNotConfiguredError();
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

/**
 * Run one prompt and return the concatenated text output. Retries once.
 * Provider-agnostic: uses Anthropic when configured, otherwise Google Gemini.
 */
export async function complete(options: CompleteOptions): Promise<string> {
  const { system, prompt, maxTokens = 2048, effort = 'high' } = options;

  const run = async (): Promise<string> => {
    if (hasAnthropic()) return callAnthropic(system, prompt, maxTokens, effort);
    if (isGeminiConfigured()) return callGemini(system, prompt, maxTokens);
    throw new ClaudeNotConfiguredError();
  };

  try {
    return await run();
  } catch (err) {
    logger.warn('AI: first attempt failed, retrying once', {
      error: err instanceof Error ? err.message : String(err),
    });
    return run();
  }
}

async function callAnthropic(
  system: string | undefined,
  prompt: string,
  maxTokens: number,
  effort: NonNullable<CompleteOptions['effort']>,
): Promise<string> {
  const c = getClient();
  const params = {
    model: getModel(),
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' as const },
    output_config: { effort },
    ...(system ? { system } : {}),
    messages: [{ role: 'user' as const, content: prompt }],
  };
  if (maxTokens >= STREAM_THRESHOLD_TOKENS) {
    const stream = c.messages.stream(params);
    const msg = await stream.finalMessage();
    return extractText(msg.content);
  }
  const msg = await c.messages.create(params);
  return extractText(msg.content);
}

/**
 * Google Gemini via the Generative Language REST API. No SDK — a single fetch
 * keeps the app lean. `effort`/streaming are Anthropic-only concepts and are
 * ignored here. For JSON-shaped calls the caller's prompt already asks for JSON;
 * parseJson() tolerates fences.
 */
async function callGemini(
  system: string | undefined,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': geminiKey(),
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini API error (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text ?? '')
    .join('')
    .trim();
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
