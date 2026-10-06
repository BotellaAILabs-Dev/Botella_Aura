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

/**
 * Which model class a task deserves.
 *
 * Every call used to run on the same flagship model regardless of what it was
 * doing — summarising a text diff cost exactly as much per token as writing the
 * post a customer publishes. Tiering is the single biggest cost lever available
 * here, because most calls in this codebase are short structural work.
 *
 * Prices per million tokens (input / output), Anthropic first-party:
 *   cheap    Haiku 4.5   $1 / $5    — 5x cheaper than premium
 *   standard Sonnet 5    $2 / $10   — 2.5x cheaper than premium
 *   premium  Opus        $5 / $25
 *
 * The rule for choosing: does a human read this output as the product? Post
 * copy, the monthly plan and strategic recommendations do — they stay premium.
 * Extraction, scoring, classification and internal summaries do not.
 */
export type ModelTier = 'cheap' | 'standard' | 'premium';

interface ModelSpec {
  id: string;
  /**
   * Haiku 4.5 REJECTS `output_config.effort` with a 400, and uses the older
   * `budget_tokens` thinking API rather than adaptive. Sending the newer
   * parameters to it fails the request outright, so capability travels with
   * the model rather than being assumed.
   */
  supportsEffort: boolean;
  supportsAdaptiveThinking: boolean;
}

const TIER_DEFAULTS: Record<ModelTier, ModelSpec> = {
  cheap: {
    id: 'claude-haiku-4-5',
    supportsEffort: false,
    supportsAdaptiveThinking: false,
  },
  standard: {
    id: 'claude-sonnet-5',
    supportsEffort: true,
    supportsAdaptiveThinking: true,
  },
  premium: {
    id: DEFAULT_MODEL,
    supportsEffort: true,
    supportsAdaptiveThinking: true,
  },
};

const TIER_ENV: Record<ModelTier, string> = {
  cheap: 'ANTHROPIC_MODEL_CHEAP',
  standard: 'ANTHROPIC_MODEL_STANDARD',
  premium: 'ANTHROPIC_MODEL_PREMIUM',
};

/**
 * Resolve the model for a tier.
 *
 * `ANTHROPIC_MODEL` still overrides everything, so a deployment that pinned a
 * model before tiering existed keeps behaving exactly as it did. Per-tier
 * variables allow finer control.
 *
 * Capabilities for an overridden model are inferred from its id, because we
 * cannot know them otherwise — and inferring wrongly for Haiku is the one
 * mistake that turns into a hard 400 rather than a quality difference.
 */
function modelFor(tier: ModelTier): ModelSpec {
  const override = process.env[TIER_ENV[tier]] || process.env.ANTHROPIC_MODEL;
  if (!override) return TIER_DEFAULTS[tier];

  const isHaiku = /haiku/i.test(override);
  return {
    id: override,
    supportsEffort: !isHaiku,
    supportsAdaptiveThinking: !isHaiku,
  };
}

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

export function getModel(tier: ModelTier = 'premium'): string {
  if (hasAnthropic()) return modelFor(tier).id;
  // Gemini's flash model is already the cheap end of that family, so the tier
  // does not change anything on the fallback path.
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
  /**
   * Which model class this task deserves. Defaults to 'premium' so any call
   * that has not been classified keeps its previous behaviour exactly.
   */
  tier?: ModelTier;
  /** Hard per-attempt ceiling in ms. Default 120s. */
  timeoutMs?: number;
  /**
   * The answer must be JSON. Set by completeJson / completeStructured. Gemini
   * then returns bare JSON (no fences, no prose) — Anthropic follows the
   * prompt, and parseJson() tolerates either.
   */
  json?: boolean;
}

/**
 * The model answered, but with no text.
 *
 * This is the failure behind "Could not generate a preview". Extended thinking
 * draws from the SAME max_tokens budget as the reply, so a small cap (the
 * onboarding preview asked for 400) could be spent entirely on thinking,
 * returning a well-formed response containing only a thinking block and no
 * text. The old code read that as an empty string and handed "" to the caller,
 * which surfaced as a generic failure with nothing to retry.
 *
 * Treating it as an error means the retry path below actually fires, and
 * `shouldThink()` stops us requesting thinking we cannot afford in the first
 * place.
 */
export class EmptyCompletionError extends Error {
  constructor(readonly stopReason?: string | null) {
    super(
      `The model returned no text${stopReason ? ` (stop reason: ${stopReason})` : ''}.`,
    );
    this.name = 'EmptyCompletionError';
  }
}

/** Nothing about a bad key or a malformed request improves by trying again. */
function isRetryable(err: unknown): boolean {
  if (err instanceof ClaudeNotConfiguredError) return false;
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === 'number') {
    // 429 and 5xx are transient; 400/401/403/404 are not.
    return status === 429 || status >= 500;
  }
  return true;
}

/**
 * Reserve room for thinking, or skip it entirely.
 *
 * Thinking shares the output budget, so we only ask for it when there is enough
 * headroom left for a real answer afterwards. Short, cheap calls (the
 * onboarding sample post, lead scoring) get a straight completion — they gain
 * nothing from deliberation and were the ones starving.
 */
function shouldThink(
  maxTokens: number,
  effort: NonNullable<CompleteOptions['effort']>,
): boolean {
  return effort !== 'low' && maxTokens >= THINKING_MIN_TOKENS;
}

const THINKING_MIN_TOKENS = 2000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;

/**
 * Run one prompt and return the concatenated text output.
 * Provider-agnostic: uses Anthropic when configured, otherwise Google Gemini.
 *
 * Retries transient failures (and empty completions) up to MAX_ATTEMPTS with
 * backoff. Permanent failures — no key, bad request — throw immediately so the
 * caller can fall back without waiting out a pointless retry loop.
 */
export async function complete(options: CompleteOptions): Promise<string> {
  const {
    system,
    prompt,
    maxTokens = 2048,
    effort = 'high',
    tier = 'premium',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    json = false,
  } = options;

  const run = async (): Promise<string> => {
    if (hasAnthropic())
      return callAnthropic(system, prompt, maxTokens, effort, tier, timeoutMs);
    if (isGeminiConfigured())
      return callGemini(system, prompt, maxTokens, timeoutMs, { json, effort });
    throw new ClaudeNotConfiguredError();
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await run();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS) break;
      logger.warn(`AI: attempt ${attempt} failed, retrying`, {
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastError;
}

async function callAnthropic(
  system: string | undefined,
  prompt: string,
  maxTokens: number,
  effort: NonNullable<CompleteOptions['effort']>,
  tier: ModelTier,
  timeoutMs: number,
): Promise<string> {
  const c = getClient();
  const model = modelFor(tier);
  const think = model.supportsAdaptiveThinking && shouldThink(maxTokens, effort);

  const params = {
    model: model.id,
    max_tokens: maxTokens,
    ...(think ? { thinking: { type: 'adaptive' as const } } : {}),
    // Omitted entirely for models that reject it — Haiku 4.5 returns a 400 for
    // `output_config.effort`, so sending it would fail the request rather than
    // merely being ignored. Effort still shapes `shouldThink` above.
    ...(model.supportsEffort ? { output_config: { effort } } : {}),
    ...(system ? { system } : {}),
    messages: [{ role: 'user' as const, content: prompt }],
  };
  // The SDK retries on its own too; ours adds the empty-completion case.
  const requestOptions = { timeout: timeoutMs, maxRetries: 1 };

  const msg =
    maxTokens >= STREAM_THRESHOLD_TOKENS
      ? await c.messages.stream(params, requestOptions).finalMessage()
      : await c.messages.create(params, requestOptions);

  const text = extractText(msg.content);
  if (!text) throw new EmptyCompletionError(msg.stop_reason);
  return text;
}

/**
 * How much a Gemini model may "think" before answering, from the caller's
 * effort.
 *
 * Current Gemini models think by default, and those thinking tokens come out
 * of the same maxOutputTokens budget as the answer. Measured on a two-caption
 * JSON request: 946 thinking tokens for a 213-token answer, nearly 12s — and
 * on a longer piece the answer was cut off mid-JSON, failed to parse and
 * forced a full retry. Routine work (effort low/medium) thinks lightly; work
 * that asked for depth (high and above) keeps it. Gemini 2.5 takes a token
 * budget; later models take a level.
 */
export function geminiThinking(
  model: string,
  effort: NonNullable<CompleteOptions['effort']>,
): Record<string, unknown> {
  const deep = effort === 'high' || effort === 'xhigh' || effort === 'max';
  if (/gemini-2\.5/.test(model)) {
    return { thinkingBudget: deep ? -1 : /flash-lite/.test(model) ? 0 : 512 };
  }
  return { thinkingLevel: deep ? 'high' : 'low' };
}

/**
 * Google Gemini via the Generative Language REST API. No SDK — a single fetch
 * keeps the app lean. Streaming is Anthropic-only; effort maps to Gemini's
 * thinking (geminiThinking). JSON calls ask for JSON output directly, so no
 * fences or prose come back to strip.
 */
async function callGemini(
  system: string | undefined,
  prompt: string,
  maxTokens: number,
  timeoutMs: number,
  options: { json: boolean; effort: NonNullable<CompleteOptions['effort']> },
): Promise<string> {
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  let res: Response;
  try {
    res = await fetch(
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
          generationConfig: {
            maxOutputTokens: maxTokens,
            temperature: 0.7,
            ...(options.json ? { responseMimeType: 'application/json' } : {}),
            thinkingConfig: geminiThinking(model, options.effort),
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`Gemini did not respond within ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw err;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const error = new Error(
      `Gemini API error (${res.status}): ${detail.slice(0, 200)}`,
    );
    // Carry the status so isRetryable() can tell a bad key from a rate limit.
    Object.assign(error, { status: res.status });
    throw error;
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  };
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  if (!text) throw new EmptyCompletionError(candidate?.finishReason ?? null);
  return text;
}

/**
 * Run a prompt expected to return JSON and parse it. The prompt/system should
 * instruct the model to output ONLY JSON; we defensively strip code fences and
 * isolate the outermost JSON value before parsing. Retries once on API failure;
 * a parse failure throws so the caller can fall back.
 */
export async function completeJson<T>(options: CompleteOptions): Promise<T> {
  const text = await complete({ ...options, json: true });
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
    const text = await complete({ ...rest, prompt, json: true });
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
