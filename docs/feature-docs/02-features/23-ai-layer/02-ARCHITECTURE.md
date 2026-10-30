# AI Layer (Claude / Gemini Client) — Architecture

All AI text generation in Botella Aura goes through one module, `server/ai/claude.ts`. It chooses a provider (Anthropic first, Gemini as fallback) and a model per cost tier. It applies one retry and validation policy to every call, and turns provider failures into fixed, user-safe messages. Feature services only decide the prompt, the tier, the effort and their own no-AI fallback.

## Component architecture

```mermaid
flowchart LR
  subgraph S1["Callers - feature services"]
    C1["content generator<br/>variations, planner<br/>premium"]
    C2["recommendations, memory,<br/>analytics, digests, review<br/>standard"]
    C3["lead scoring, diffs,<br/>WhatsApp router<br/>cheap"]
  end
  subgraph S2["server/ai/claude.ts"]
    API1["completeStructured"]
    API2["completeJson"]
    API3["complete<br/>retry loop"]
    Tier["modelFor / geminiModelFor<br/>tier to model"]
    Anth["callAnthropic"]
    Gem["callGemini"]
    Parse["parseJson<br/>repairModelJson"]
    Fail["aiFailureMessage"]
  end
  Routes["lib/api.ts<br/>route error handler"]
  ExtA{{"Anthropic Messages API"}}
  ExtG{{"Gemini generateContent"}}
  C1 --> API1
  C2 --> API1
  C3 --> API1
  C2 --> API3
  API1 --> API3
  API2 --> API3
  API1 --> Parse
  API2 --> Parse
  API3 --> Tier
  API3 -->|"ANTHROPIC_API_KEY set"| Anth
  API3 -->|"else GEMINI key set"| Gem
  Anth --> ExtA
  Gem --> ExtG
  Routes -->|"maps provider errors to 503"| Fail
```

Read left to right: feature services, grouped by the tier they usually ask for, enter through one of three public functions, and all three end in `complete()`, which owns the retry loop. `complete()` resolves the model for the tier and sends the call to Anthropic when its key is present, otherwise to Gemini. JSON answers pass back through `parseJson`. Separately, the shared route error handler in `lib/api.ts` uses `aiFailureMessage` to turn any provider error into a plain 503.

## Main flow

```mermaid
sequenceDiagram
  participant Svc as Feature service
  participant CS as completeStructured
  participant C as complete
  participant P as Provider call
  participant Ext as Anthropic or Gemini
  Svc->>CS: prompt, system, schema, tier, effort, maxTokens
  CS->>C: same options with json true
  loop up to maxAttempts, default 3
    C->>P: callAnthropic or callGemini
    P->>Ext: request with model for tier
    alt text returned
      Ext-->>P: response
      P-->>C: text
    else 429, 5xx, timeout or empty text
      Ext-->>P: error or empty
      P-->>C: throw
      Note over C: retry after 400 ms x attempt unless not retryable
    end
  end
  C-->>CS: text
  CS->>CS: parseJson then schema.safeParse
  alt valid
    CS-->>Svc: typed data
  else invalid JSON or schema mismatch
    CS->>C: re-ask once with validation errors appended
    C-->>CS: text
    CS-->>Svc: typed data or SchemaValidationError
  end
```

This is the most common path, a schema-validated generation. Transport problems are retried inside `complete()`: up to three attempts with linear backoff, but never for a missing key, a 4xx other than 429, or a spent daily quota. Content problems are handled one level up: `completeStructured` re-asks exactly once with the validation errors. It skips the re-ask when the failure came from the provider, because rephrasing cannot fix a quota or a bad key.

```mermaid
flowchart TD
  Start["complete called"] --> Key{"Which key is set?"}
  Key -->|"ANTHROPIC_API_KEY"| AModel["modelFor tier<br/>ANTHROPIC_MODEL_TIER, ANTHROPIC_MODEL, default"]
  Key -->|"GEMINI_API_KEY or GOOGLE_GEMINI_API_KEY"| GModel["geminiModelFor tier<br/>GEMINI_MODEL_TIER, GEMINI_MODEL, flash-lite"]
  Key -->|"none"| NoKey["throw ClaudeNotConfiguredError"]
  AModel --> Think{"supports thinking and<br/>effort not low and<br/>maxTokens at least 2000?"}
  Think -->|"yes"| Adaptive["add adaptive thinking"]
  Think -->|"no"| Plain["no thinking"]
  Adaptive --> Stream{"maxTokens at least 8000?"}
  Plain --> Stream
  Stream -->|"yes"| S["messages.stream"]
  Stream -->|"no"| M["messages.create"]
  GModel --> GCfg["generationConfig<br/>temperature 0.7, JSON mime if json,<br/>geminiThinking by effort"]
```

The second diagram expands the provider step. On Anthropic, the tier decides the model, and the model's capabilities decide whether `effort` and adaptive thinking are sent. Haiku gets neither. Thinking is skipped for small budgets, because it shares `max_tokens` with the answer. Large budgets stream. On Gemini, effort maps to a thinking level or a 2.5 thinking budget, and JSON calls request a JSON mime type, so no fences come back.

## Design decisions

- **One seam for all AI.** Model choice, prompting conventions, retries and parsing live in one file, so later features inherit a tested client instead of re-implementing it (file header; Sprint 2 doc §7).
- **Anthropic preferred, Gemini as fallback.** The code comments say Anthropic is the recommended provider for anything a customer reads. Gemini keeps the product working with a single alternative key. Old names (`isClaudeConfigured`) were kept so call sites did not change.
- **Cost tiers keyed to "is this the product?".** Post copy, plans and recommendations stay `premium`. Extraction, scoring and summaries use `standard` / `cheap`. The default is `premium`, so an unclassified call never silently gets worse.
- **Capabilities travel with the model.** Haiku rejects `output_config.effort` with a 400, so `ModelSpec` carries `supportsEffort` / `supportsAdaptiveThinking`, and overrides infer them from the model id.
- **Thinking only when affordable.** Thinking shares the output budget, so small or low-effort calls skip it. An empty answer is an `EmptyCompletionError` that the retry loop can see, not a silent empty string.
- **Timed Gemini defaults, not aliases.** `gemini-flash-latest` moved and became slow enough to break the WhatsApp router's 15 s budget. The defaults are models that were actually timed, and they can be overridden per tier.
- **Retry only what can improve.** 429/5xx/network errors are retried. Bad keys, bad requests and quotas that will not reset within 30 s fail fast, so callers can fall back. Deadline-bound callers (planner, review, WhatsApp router) pass `maxAttempts: 1` and manage their own time.
- **Validate, and re-ask once.** `completeStructured` backs the "never save malformed content" guarantee. `parseJson` repairs only the two common non-JSON habits (trailing commas, bare keys), and only after a normal parse fails.
- **Users never see provider internals.** `aiFailureMessage` produces three fixed sentences, and the raw error goes to logs and monitoring.
