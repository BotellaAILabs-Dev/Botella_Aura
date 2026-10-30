# AI Layer (Claude / Gemini Client)

> The AI layer is the one module through which Botella Aura talks to a large language model. `server/ai/claude.ts` wraps Anthropic (preferred) and Google Gemini (fallback) behind one small API: `complete`, `completeJson` and `completeStructured`. It also owns model choice per cost tier, thinking/effort settings, streaming, timeouts, retries, tolerant JSON parsing and Zod validation, and it turns provider failures into plain messages a user can act on. Every feature that writes, scores, extracts or summarises with AI (trends, content, planner, recommendations, opportunities, memory, analytics, outreach, engagement, WhatsApp and more) calls this module rather than a provider SDK. Model policy and failure handling therefore live in one place, and each feature only decides what to ask and what to do when no AI is available.

## 1. Overview

| Concern | Where it lives in `server/ai/claude.ts` |
|---|---|
| Provider selection | `complete()` uses Anthropic when `ANTHROPIC_API_KEY` is set, otherwise Gemini when `GEMINI_API_KEY` / `GOOGLE_GEMINI_API_KEY` is set, otherwise throws `ClaudeNotConfiguredError` |
| "Is AI available?" gate | `isClaudeConfigured()` (true if either provider is configured), `isGeminiConfigured()` |
| Model per task class | `ModelTier` = `cheap` / `standard` / `premium`, resolved by `modelFor()` (Anthropic) and `geminiModelFor()` (Gemini); `getModel(tier)` reports the id |
| Plain text completion | `complete(options)` |
| JSON completion | `completeJson<T>(options)` = `complete({ json: true })` + `parseJson` |
| Schema-validated JSON | `completeStructured({ ...options, schema })`: Zod validation with one corrective re-ask |
| Error types | `ClaudeNotConfiguredError`, `EmptyCompletionError`, `SchemaValidationError` |
| Retry policy | `isRetryable()`, `isQuotaExhausted()`, `geminiQuota()`, `MAX_RETRY_WAIT_MS` |
| User-facing failure text | `aiFailureMessage(err)`, used by `lib/api.ts` (`handleRouteError`) and some routes |
| JSON repair | `parseJson()` + internal `repairModelJson()` |

The name `claude.ts` is historical. The module was created for Anthropic only (commit `bea3b50`, "reusable Claude service"), and Gemini was added later as an alternate provider (`43ff16e`). Function names such as `isClaudeConfigured` were kept so that existing call sites did not change.

History (from `git log -- server/ai/`):

| Commit | Change |
|---|---|
| `bea3b50` | Reusable Claude service + shared HTTP client |
| `48afe94` | `completeStructured` (schema-validated structured generation) |
| `43ff16e` | Google Gemini as an alternate AI provider |
| `ac4d45e` | Screens-review fixes for P0 generation failures (empty completions / thinking budget) |
| `366b881` | Per-task model tiers |
| `b973e45` | Stop Gemini truncating JSON answers (`geminiThinking`, JSON mime type) |
| `89cf8a2` | Bounded, fast monthly calendar generation (`maxAttempts` used by the planner) |
| `d78aace` | Content variations with a facts guardrail |
| `183a772` | Content Studio control and production readiness |
| `38083a5` | Honour the model tier on the Gemini path (`GEMINI_TIER_DEFAULTS`, `GEMINI_MODEL_*`) |
| `6cff62e` | Fixes from the full verifier sweep |

## 2. User-facing behaviour

The AI layer has no screens or routes of its own. Users see it in two ways:

1. **AI output inside other features**, such as post copy, plans, digests, recommendations, insights and WhatsApp replies. Which model wrote it is often recorded on the record (for example `model: getModel('premium')` in `server/content/generator.ts`, `getModel('standard')` in `server/recommendations/engine.service.ts`, `'fallback'` in `server/trends/digest.service.ts` when no provider is configured).
2. **Failure messages.** When a provider fails, `lib/api.ts` returns HTTP **503** with one of these messages from `aiFailureMessage()`. Raw provider text is never shown:
   - quota exhausted (daily quota or a reset longer than 30 s): "Aura’s writer is at its limit right now — the AI provider’s usage quota is used up. Nothing was changed — try again in about N minutes" (or "in about N hour(s)" when the wait is 90 minutes or more, or "later" when no reset time is known);
   - other 429: "Aura’s writer is at its limit right now (rate limit or quota). Nothing was changed — try again in a few minutes.";
   - anything else from the provider (timeout, 5xx, empty answer): "Aura’s writer did not answer. Nothing was changed — try again."

When no provider key is set at all, features check `isClaudeConfigured()` and fall back to their own deterministic path (for example template outreach drafts, non-AI digests, or the Autopilot message "No AI provider configured (ANTHROPIC_API_KEY or GEMINI_API_KEY), so no posts were written.").

Roles: not applicable. Access control is enforced by the calling routes and services.

## 3. How it works

### 3.1 Provider selection

`complete()` checks each attempt in this order:

1. `ANTHROPIC_API_KEY` set → `callAnthropic()` (official `@anthropic-ai/sdk`, one lazily created client).
2. Else `GEMINI_API_KEY` or `GOOGLE_GEMINI_API_KEY` set → `callGemini()` (a single `fetch` to `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`, header `x-goog-api-key`, no SDK).
3. Else → throw `ClaudeNotConfiguredError` ("No AI provider configured (set ANTHROPIC_API_KEY or GEMINI_API_KEY).").

If both keys are set, Anthropic always wins. There is no automatic failover from Anthropic to Gemini on error.

### 3.2 Model tiers

`CompleteOptions.tier` defaults to `'premium'`, so a call that has not been classified keeps the flagship model.

| Tier | Anthropic default (`TIER_DEFAULTS`) | Effort param | Adaptive thinking | Gemini default (`GEMINI_TIER_DEFAULTS`) |
|---|---|---|---|---|
| `cheap` | `claude-haiku-4-5` | not sent | no | `gemini-3.5-flash-lite` |
| `standard` | `claude-sonnet-5` | sent | yes | `gemini-3.5-flash-lite` |
| `premium` | `claude-opus-4-8` (`DEFAULT_MODEL`) | sent | yes | `gemini-3.5-flash-lite` |

The code states the rule for choosing a tier: does a human read the output as the product? Post copy, the monthly plan and strategic recommendations stay premium. Extraction, scoring, classification and internal summaries go to cheaper tiers.

Resolution order:

- Anthropic (`modelFor`): `ANTHROPIC_MODEL_<TIER>` → `ANTHROPIC_MODEL` → tier default. For an overridden id, capabilities are inferred: any id matching `/haiku/i` gets `supportsEffort = false` and `supportsAdaptiveThinking = false`, because Haiku 4.5 rejects `output_config.effort` with a 400.
- Gemini (`geminiModelFor`): `GEMINI_MODEL_<TIER>` → `GEMINI_MODEL` → tier default. The code comment records why every tier defaults to `-lite`: on a free key the larger models timed out or returned 503/429, and the `gemini-flash-latest` alias had become slower than 45 s, which broke the WhatsApp router's 15 s budget.

Current tier usage by callers (explicit `tier:` in the code):

| Tier | Callers |
|---|---|
| `cheap` | `server/campaigns/checkpoint.service.ts`, `server/competitors/diff.ts`, `server/content/version-workspace.service.ts`, `server/leads/discovery/scoring.ts`, `server/leads/discovery/sources/company-site.ts`, `server/whatsapp/router.ts` |
| `standard` | `server/analytics/report.service.ts`, `server/competitors/report.service.ts`, `server/content/brand-voice.service.ts`, `server/content/review.service.ts`, `server/engagement/comment.service.ts`, `server/media/creative/creative.service.ts`, `server/media/image-prompt.service.ts`, `server/memory/extraction.service.ts`, `server/opportunities/ai-detection.service.ts`, `server/outreach/drafting.service.ts`, `server/recommendations/engine.service.ts`, `server/services/trend-config.service.ts`, `server/trends/digest.service.ts` |
| `premium` (default, no `tier`) | e.g. `server/content/generator.ts`, `server/content/variations.service.ts`, `server/campaigns/planner.ts`, `server/planner/plan.service.ts`, `server/advisor/advisor.service.ts`, `server/intelligence/intelligence.service.ts` |

### 3.3 One Anthropic call (`callAnthropic`)

1. Resolve the `ModelSpec` for the tier.
2. **Thinking:** request `thinking: { type: 'adaptive' }` only if the model supports it **and** `shouldThink(maxTokens, effort)`, i.e. `effort !== 'low'` and `maxTokens >= 2000` (`THINKING_MIN_TOKENS`). Thinking draws from the same `max_tokens` budget as the reply. Small calls such as the onboarding preview used to spend their whole budget thinking and return no text.
3. **Effort:** `output_config: { effort }` is sent only when `supportsEffort`.
4. **Streaming:** when `maxTokens >= 8000` (`STREAM_THRESHOLD_TOKENS`) the call uses `messages.stream(...).finalMessage()`, otherwise `messages.create(...)`. This avoids HTTP timeouts on long generations.
5. Request options: `timeout: timeoutMs` (default 120 000 ms) and SDK `maxRetries: 1`.
6. `extractText()` joins only `text` blocks (thinking blocks are ignored). An empty result throws `EmptyCompletionError(stop_reason)`.

### 3.4 One Gemini call (`callGemini`)

1. Model from `geminiModelFor(tier)`.
2. Body: `contents` (the prompt as one user turn), optional `systemInstruction`, and `generationConfig` with `maxOutputTokens: maxTokens`, `temperature: 0.7`, `responseMimeType: 'application/json'` when `json: true`, and `thinkingConfig` from `geminiThinking(model, effort)`:
   - Gemini 2.5 models: `thinkingBudget` = `-1` (dynamic) for effort high/xhigh/max, otherwise `0` for `flash-lite` and `512` for other 2.5 models.
   - Later models: `thinkingLevel` = `'high'` for high/xhigh/max, otherwise `'low'`.
3. `AbortSignal.timeout(timeoutMs)`. A timeout becomes `Error("Gemini did not respond within Ns.")`.
4. A non-2xx response becomes `Error("Gemini API error (<status>): …")` with `status` attached. For 429, `geminiQuota(body)` reads `google.rpc.QuotaFailure` / `RetryInfo` and attaches `quotaId` and `retryAfterMs`, and the message names the quota and the approximate reset.
5. Text is joined from `candidates[0].content.parts[].text`. If it is empty, `EmptyCompletionError(finishReason)` is thrown.

Streaming is Anthropic-only.

### 3.5 Retries (`complete`)

- Up to `maxAttempts` attempts (default **3**, `MAX_ATTEMPTS`), with a linear backoff of `400 ms × attempt` between them.
- `isRetryable(err)`:
  - `ClaudeNotConfiguredError` → never retried.
  - Errors with a numeric `status`: 429 and ≥ 500 are retried; 400/401/403/404 are not. A 429 that `isQuotaExhausted()` (quota id matches `/PerDay/i`, or `retryAfterMs > 30 000` = `MAX_RETRY_WAIT_MS`) is not retried.
  - Errors without a status (network errors, `EmptyCompletionError`, Gemini timeouts) are retried.
- Callers working to a deadline pass `maxAttempts: 1` and manage time themselves: `server/planner/plan.service.ts` (the calendar draft retries using `isRetryable` within its own time budget in `server/planner/calendar-draft.ts`), `server/content/review.service.ts` (`timeoutMs: 25_000`) and `server/whatsapp/router.ts` (`timeoutMs: 15_000`).

### 3.6 JSON and structured output

- `parseJson<T>(raw)`: trims, unwraps the first ```` ```json ```` fence, isolates the outermost `{…}` / `[…]`, then `JSON.parse`. Only if that fails does it try `repairModelJson()`. That function is a character scan, not a regex, so string contents are left exactly as they are. It removes a trailing comma before `}`/`]` and quotes bare property names. If the repair does not help, the **original** parse error is thrown.
- `completeJson<T>()`: `complete({ ...options, json: true })` then `parseJson`.
- `completeStructured({ schema, ... })`: runs `complete({ json: true })`, parses, and `schema.safeParse`s. On a parse or validation failure it logs and re-asks **once**, appending "Your previous response did not match the required JSON schema. Validation errors: … Respond again with ONLY valid JSON …" (errors truncated to 500 chars). It does **not** re-ask when the error is `ClaudeNotConfiguredError` or carries a numeric `status`, because a provider refusal (quota, key, outage) is not fixed by rephrasing and was already retried by `complete()`. If the second attempt also fails, it throws `SchemaValidationError` (with the raw text).

### 3.7 Failure messages

`aiFailureMessage(err)` returns `null` unless the error came from a provider: a message starting `Gemini API error` / `Gemini did not respond`, an `EmptyCompletionError`, or a numeric-status error whose `name` mentions anthropic/claude. `lib/api.ts` calls it inside its shared error handler and, on a match, reports the exception to monitoring (`captureException(..., { kind: 'ai_provider' })`) and responds `503`. Routes that call it directly include `app/api/content/drafts/[id]/refine/route.ts`, `app/api/content/drafts/[id]/variations/_shared.ts`, `app/api/review/[kind]/[id]/route.ts` and `server/whatsapp/tools/content.ts`.

## 4. Code map

| Layer | File | Responsibility |
|---|---|---|
| Service | `server/ai/claude.ts` | The whole AI layer: provider selection, tiers, `complete` / `completeJson` / `completeStructured`, retries, errors, `parseJson`, `aiFailureMessage` |
| Lib | `lib/api.ts` | Shared route error handler; maps provider failures to a 503 with `aiFailureMessage` |
| Related | `server/media/providers/gemini.ts` | Gemini image provider; reuses the same `GEMINI_API_KEY` / `GOOGLE_GEMINI_API_KEY` credential (image generation itself is feature 12) |
| Callers | `server/content/*`, `server/planner/*`, `server/campaigns/*`, `server/recommendations/engine.service.ts`, `server/opportunities/ai-detection.service.ts`, `server/memory/extraction.service.ts`, `server/analytics/report.service.ts`, `server/trends/digest.service.ts`, `server/competitors/*`, `server/leads/discovery/*`, `server/outreach/drafting.service.ts`, `server/engagement/comment.service.ts`, `server/advisor/advisor.service.ts`, `server/intelligence/intelligence.service.ts`, `server/briefing/autopilot.service.ts`, `server/whatsapp/*`, `server/media/*`, `server/services/trend-config.service.ts`, `app/api/onboarding/preview/route.ts` | Consumers. Each picks a tier/effort/maxTokens and handles the no-AI fallback |
| Test | `tests/claude.test.ts` | `parseJson`, `isClaudeConfigured`, text extraction ignoring thinking blocks, `completeJson`, retry on transient failure (SDK mocked) |
| Test | `tests/ai-completion.test.ts` | No thinking for short/low-effort calls; thinking when affordable; retry on empty completion; `EmptyCompletionError` after retries; no retry on rejected key; retry on rate limit |
| Test | `tests/model-tiers.test.ts` | Anthropic tier defaults, premium default, `ANTHROPIC_MODEL` / per-tier overrides, Gemini `GEMINI_MODEL` |
| Test | `tests/ai-model-tiers.test.ts` | Anthropic preferred over Gemini; Gemini honours the tier; timed defaults (not the moving alias); `GEMINI_MODEL_*` vs `GEMINI_MODEL`; `GOOGLE_GEMINI_API_KEY` |
| Test | `tests/gemini-thinking.test.ts` | `geminiThinking` level vs 2.5 token budget |
| Test | `tests/ai-quota.test.ts` | `geminiQuota` parsing, `isQuotaExhausted`, `aiFailureMessage` wording, `completeStructured` not re-asking on quota/rate limit but re-asking on a malformed reply |
| Test | `tests/model-json.test.ts` | `parseJson` repair cases (trailing commas, bare keys, strings left intact, original error thrown) |

## 5. Data model

Not applicable. The AI layer owns no Prisma models and writes nothing to the database. Callers persist outputs and often record the model id from `getModel(tier)` (or `'fallback'` / `'none'` when AI is unavailable) on their own records.

## 6. API endpoints

Not applicable. The AI layer exposes no HTTP endpoints. It affects every route indirectly through `lib/api.ts`, which turns provider failures into `503` responses (see §3.7). Endpoint reference for the calling features: [Internal API](../../04-api/INTERNAL-API.md).

## 7. External services

| Service | How it is called | Credentials |
|---|---|---|
| Anthropic Messages API | `@anthropic-ai/sdk` (`messages.create` / `messages.stream`) | `ANTHROPIC_API_KEY` (read by the SDK from the environment) |
| Google Gemini (Generative Language API v1beta) | `fetch` POST `…/v1beta/models/<model>:generateContent` | `GEMINI_API_KEY` or `GOOGLE_GEMINI_API_KEY` |

Model override variables: `ANTHROPIC_MODEL`, `ANTHROPIC_MODEL_CHEAP`, `ANTHROPIC_MODEL_STANDARD`, `ANTHROPIC_MODEL_PREMIUM`, `GEMINI_MODEL`, `GEMINI_MODEL_CHEAP`, `GEMINI_MODEL_STANDARD`, `GEMINI_MODEL_PREMIUM`. See [Environment variables](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

Not applicable. The layer has no jobs of its own. It is called from cron-driven services in other features (for example the weekly briefing / Autopilot), with the same retry and failure rules.

## 9. Security & permissions

- **Server-only.** The module lives in `server/` and reads keys from `process.env`. Keys never reach the browser.
- **No raw provider text to users.** `aiFailureMessage` replaces provider bodies (JSON, quota links) with fixed wording, and the raw error goes to the log / `captureException`. Gemini error messages keep at most 200 characters of the body, for logs only.
- **Never save malformed content.** `completeStructured` validates every structured answer against the caller's Zod schema and throws rather than returning unvalidated data.
- **No RBAC or workspace scoping here.** Callers authorise the request and scope any data put into prompts to the active workspace before calling the layer.

## 10. Testing

Unit tests (Vitest, `pnpm test`): `tests/claude.test.ts`, `tests/ai-completion.test.ts`, `tests/model-tiers.test.ts`, `tests/ai-model-tiers.test.ts`, `tests/gemini-thinking.test.ts`, `tests/ai-quota.test.ts`, `tests/model-json.test.ts`. The Anthropic SDK is mocked with `vi.mock('@anthropic-ai/sdk')`, and Gemini tests stub `fetch`. No test calls a real provider.

There is no dedicated `pnpm verify:*` script for the layer. It is exercised end to end by feature verifiers that import it, such as `scripts/verify-content-studio.ts`, `scripts/verify-contextual-generation.ts` and `scripts/verify-planner.ts`. `pnpm env:check` (`scripts/env-check.ts`) checks environment setup.

## 11. Configuration & limits

| Setting | Value | Source |
|---|---|---|
| Default tier | `premium` | `CompleteOptions.tier` |
| Default `maxTokens` | 2048 | `complete()` |
| Default `effort` | `high` | `complete()` |
| Default per-attempt timeout | 120 000 ms | `DEFAULT_TIMEOUT_MS` |
| Attempts | 3 (backoff 400 ms × attempt) | `MAX_ATTEMPTS` |
| Anthropic SDK internal retries | 1 | `requestOptions.maxRetries` |
| Streaming threshold | `maxTokens >= 8000` | `STREAM_THRESHOLD_TOKENS` |
| Thinking threshold | `maxTokens >= 2000` and effort not `low` | `THINKING_MIN_TOKENS`, `shouldThink` |
| Longest provider wait retried in-request | 30 000 ms | `MAX_RETRY_WAIT_MS` |
| Schema re-asks | 1 | `completeStructured` |
| Gemini temperature | 0.7 | `callGemini` |
| Effort values | `low`, `medium`, `high`, `xhigh`, `max` | `CompleteOptions.effort` |

`.env.example` documents `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` and the three `ANTHROPIC_MODEL_*` tier overrides, with the price table and the "does a human read it" rule.

## 12. Known limitations & future work

- **No cross-provider failover.** If Anthropic is configured and failing, the layer does not try Gemini.
- **Gemini tiers are identical by default.** All three default to `gemini-3.5-flash-lite`. Tiering only changes the Gemini model when the `GEMINI_MODEL_*` variables are set.
- **No streaming on Gemini.** Very long Gemini generations depend on `timeoutMs`.
- **Capability inference is name-based.** An overridden Anthropic model is treated as effort/thinking-capable unless its id contains "haiku". Another model that rejects `effort` would need the capability table extended (as `.env.example` notes).
- **Single user turn only.** `complete` sends one user message plus an optional system prompt. There is no multi-turn conversation, tool use or prompt caching in this layer.
- **Stale comments.** The file header says "One automatic retry on transient failure", the `completeJson` doc says "Retries once on API failure", and the header still names `claude-opus-4-8` as the only default. The actual policy is up to 3 attempts and tiered models.
- **Stale test wording.** `tests/model-tiers.test.ts` still says the Gemini fallback "ignores the tier". It passes only because the three Gemini defaults happen to be equal. `tests/ai-model-tiers.test.ts` describes the current behaviour.

## 13. Related documents

- [Sprint 2 technical](../../../SPRINT-2-TECHNICAL.md): §7, original Claude service
- [Sprint 3 technical](../../../SPRINT-3-TECHNICAL.md): `completeStructured` and Content Studio
- [Sprint 4 technical](../../../SPRINT-4-TECHNICAL.md) and [Sprint 5 technical](../../../SPRINT-5-TECHNICAL.md): later AI callers
- [Product documentation](../../../PRODUCT-DOCUMENTATION.md)
- [Vercel deployment](../../../VERCEL-DEPLOYMENT.md): provider keys in production
- [Graphic generation technical](../../../GRAPHIC-GENERATION-TECHNICAL.md): Gemini image provider sharing the credential
- Sibling features: [11 Content Studio](../11-content-studio/01-FEATURE-DETAILS.md), [12 Media, graphics & creatives](../12-media-graphics-and-creatives/01-FEATURE-DETAILS.md), [14 Campaigns & planner](../14-campaigns-and-content-planner/01-FEATURE-DETAILS.md), [09 Recommendations](../09-recommendations-and-aura-suggests/01-FEATURE-DETAILS.md), [18 Marketing Memory & analytics](../18-marketing-memory-and-analytics/01-FEATURE-DETAILS.md), [21 WhatsApp assistant](../21-whatsapp-assistant/01-FEATURE-DETAILS.md)
- [Changelog](./03-CHANGELOG.md)
