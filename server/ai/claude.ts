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
/**
 * Gemini models per tier.
 *
 * There used to be one: `gemini-flash-latest`, on the reasoning that "Gemini's
 * flash model is already the cheap end of that family, so the tier does not
 * change anything". That stopped being true. `gemini-flash-latest` is an
 * ALIAS, Google moved it, and it now takes longer than 45 seconds to answer a
 * small JSON request — measured, not inferred.
 *
 * Nothing errored. The WhatsApp assistant's router has a 15-second budget, so
 * it timed out, retried, timed out again, and fell back to its menu — which a
 * user experiences as "Sorry, I didn't catch that" to a perfectly clear
 * sentence. The assistant looked broken; the model was just slow.
 *
 * So the tier is honoured on this path too, and the defaults are models that
 * were timed rather than assumed. `-lite` everywhere looks surprising for the
 * premium tier, and it is the honest default on a free key: of the larger
 * models, 3.8-flash timed out at 60s, 3.6-flash answered 503 "high demand",
 * and pro-latest answered 429 "quota exceeded". A deployment with a paid key,
 * or any preference of its own, sets the three variables below.
 *
 * Anthropic stays the recommended provider for anything a customer reads;
 * these tiers are the fallback path, not the intended one.
 */
const GEMINI_TIER_DEFAULTS: Record<ModelTier, string> = {
  cheap: 'gemini-3.5-flash-lite',
  standard: 'gemini-3.5-flash-lite',
  premium: 'gemini-3.5-flash-lite',
};

const GEMINI_TIER_ENV: Record<ModelTier, string> = {
  cheap: 'GEMINI_MODEL_CHEAP',
  standard: 'GEMINI_MODEL_STANDARD',
  premium: 'GEMINI_MODEL_PREMIUM',
};

/**
 * The Gemini model for a tier.
 *
 * `GEMINI_MODEL` still overrides every tier, so a deployment that pinned a
 * model before this existed behaves exactly as it did — including one that
 * pinned the slow alias, which is its choice to make.
 */
function geminiModelFor(tier: ModelTier): string {
  return (
    process.env[GEMINI_TIER_ENV[tier]] ||
    process.env.GEMINI_MODEL ||
    GEMINI_TIER_DEFAULTS[tier]
  );
}
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
  return geminiModelFor(tier);
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
   * How many tries a transient failure gets. Default 3. Callers working to a
   * deadline (the monthly planner) pass 1 and decide themselves whether there
   * is time left for another go, rather than waiting out a backoff loop they
   * cannot afford.
   */
  maxAttempts?: number;
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
/**
 * A 429 from Gemini says which quota ran out and when to try again
 * (google.rpc.QuotaFailure / RetryInfo). Null when the body says neither.
 */
export function geminiQuota(body: string): { quotaId: string | null; retryAfterMs: number | null } | null {
  try {
    const details = ((JSON.parse(body) as { error?: { details?: unknown[] } }).error?.details ?? []) as {
      violations?: { quotaId?: string; quotaMetric?: string }[];
      retryDelay?: string;
    }[];
    const quotaId = details.flatMap((d) => d.violations ?? []).map((v) => v.quotaId ?? v.quotaMetric ?? '').find(Boolean) ?? null;
    const delay = details.map((d) => d.retryDelay).find(Boolean);
    const seconds = delay ? Number.parseFloat(delay) : NaN;
    const retryAfterMs = Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
    return quotaId || retryAfterMs !== null ? { quotaId, retryAfterMs } : null;
  } catch {
    return null;
  }
}

/** A provider wait longer than this is not worth retrying within a request. */
export const MAX_RETRY_WAIT_MS = 30_000;

/** A spent quota that will not come back within a request (a daily limit, or a long wait). */
export function isQuotaExhausted(err: unknown): boolean {
  const e = err as { status?: number; quotaId?: string | null; retryAfterMs?: number | null } | null;
  if (e?.status !== 429) return false;
  return /PerDay/i.test(e.quotaId ?? '') || (typeof e.retryAfterMs === 'number' && e.retryAfterMs > MAX_RETRY_WAIT_MS);
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof ClaudeNotConfiguredError) return false;
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === 'number') {
    // A spent daily quota (or a long wait) won't clear in a second: fail now.
    if (isQuotaExhausted(err)) return false;
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
    maxAttempts = MAX_ATTEMPTS,
  } = options;

  const run = async (): Promise<string> => {
    if (hasAnthropic())
      return callAnthropic(system, prompt, maxTokens, effort, tier, timeoutMs);
    if (isGeminiConfigured())
      return callGemini(system, prompt, maxTokens, timeoutMs, { json, effort, tier });
    throw new ClaudeNotConfiguredError();
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await run();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt >= maxAttempts) break;
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
  options: {
    json: boolean;
    effort: NonNullable<CompleteOptions['effort']>;
    /** Which model class the caller asked for; the tier picks the model. */
    tier: ModelTier;
  },
): Promise<string> {
  const model = geminiModelFor(options.tier);
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
    const quota = res.status === 429 ? geminiQuota(detail) : null;
    const error = new Error(
      `Gemini API error (${res.status}): ${
        quota?.quotaId
          ? `quota ${quota.quotaId} exhausted${quota.retryAfterMs !== null ? `, resets in about ${Math.ceil(quota.retryAfterMs / 60_000)} min` : ''}`
          : detail.slice(0, 200)
      }`,
    );
    // Carry the status (and, for a quota, when it resets) so isRetryable()
    // can tell a bad key from a brief rate limit from a spent daily quota.
    Object.assign(error, { status: res.status, ...(quota ?? {}) });
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
    // The re-ask is for a reply that didn't match the schema. A provider that
    // refused the call (quota, key, outage — already retried by complete())
    // is not fixed by rephrasing; asking again only spends more quota.
    if (err instanceof ClaudeNotConfiguredError || typeof (err as { status?: unknown } | null)?.status === 'number') throw err;
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

/**
 * A provider failure, in words a person can act on — or null when the error
 * is not a provider failure. The raw provider text (JSON, quota links) is
 * for the log, not the page.
 */
export function aiFailureMessage(err: unknown): string | null {
  const status = (err as { status?: unknown } | null)?.status;
  const message = err instanceof Error ? err.message : '';
  const fromProvider =
    /^(Gemini API error|Gemini did not respond)/.test(message) ||
    err instanceof EmptyCompletionError ||
    (typeof status === 'number' && /anthropic|claude/i.test(String((err as { name?: string }).name ?? '')));
  if (!fromProvider) return null;
  if (status === 429) {
    if (isQuotaExhausted(err)) {
      const ms = (err as { retryAfterMs?: number | null }).retryAfterMs;
      const when = typeof ms === 'number' && ms > 0 ? (ms >= 90 * 60_000 ? `in about ${Math.round(ms / 3_600_000)} hour(s)` : `in about ${Math.ceil(ms / 60_000)} minutes`) : 'later';
      return `Aura’s writer is at its limit right now — the AI provider’s usage quota is used up. Nothing was changed — try again ${when}.`;
    }
    return 'Aura’s writer is at its limit right now (rate limit or quota). Nothing was changed — try again in a few minutes.';
  }
  return 'Aura’s writer did not answer. Nothing was changed — try again.';
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

/**
 * Repair the two ways a model writes JSON that is not JSON: a comma before the
 * closing brace, and a property name without quotes. Both are valid
 * JavaScript, which is presumably why they turn up.
 *
 * Done as a character scan rather than a regex because the same characters
 * inside a string value must be left exactly as they are — a caption that ends
 * `..., }` is content, not a syntax error.
 */
function repairModelJson(s: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  /** The last character written that was not whitespace. */
  let prev = '';
  /** Index of the next non-space character, without slicing the remainder. */
  const peek = (from: number): number => {
    let j = from;
    while (j < s.length && /\s/.test(s[j]!)) j += 1;
    return j;
  };
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (inString) {
      out.push(ch);
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out.push(ch);
      prev = ch;
      continue;
    }
    // A comma whose next non-space character closes the structure.
    if (ch === ',') {
      const j = peek(i + 1);
      if (s[j] === '}' || s[j] === ']') continue;
      out.push(ch);
      prev = ch;
      continue;
    }
    // A bare property name, in a position where a name is expected.
    if ((prev === '{' || prev === ',') && /[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < s.length && /[\w$]/.test(s[j]!)) j += 1;
      if (s[peek(j)] === ':') {
        out.push(`"${s.slice(i, j)}"`);
        prev = '"';
        i = j - 1;
        continue;
      }
    }
    out.push(ch);
    if (!/\s/.test(ch)) prev = ch;
  }
  return out.join('');
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
  try {
    return JSON.parse(s) as T;
  } catch (err) {
    // Only ever a second chance: valid JSON never reaches the repair, so a
    // document that parses is never rewritten. The original error is what is
    // thrown if the repair does not help, because it is the one that says
    // where the real problem was.
    const repaired = repairModelJson(s);
    if (repaired !== s) {
      try {
        return JSON.parse(repaired) as T;
      } catch {
        // fall through to the original error
      }
    }
    throw err;
  }
}
