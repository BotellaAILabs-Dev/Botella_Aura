# AI Layer (Claude / Gemini Client) — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 23 Jul 2026 (`bea3b50` — feat(ai): reusable Claude service + shared HTTP client) |
| Last changed | 27 Oct 2026 (`6cff62e`) |
| Commits | 11 |
| Days with changes | 10 |
| Lines in this feature's files | +752 / −89 |
| By status | Fresh addition 6, Fix 4, Change 1 |
| Committed by | dspraneeth07 (6), srbaggari (5) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 2 – Trends, AI & LinkedIn | 1 | 23 Jul |
| Sprint 3 – Content Studio & Knowledge | 1 | 23 Jul |
| Client feedback & UX review | 2 | 31 Jul – 27 Aug |
| AI graphics, autonomy & guided setup | 1 | 02 Sep |
| Sprint 8 – Recommendations | 1 | 06 Oct |
| Sprint 9 – Recommendation to Content | 2 | 09 Oct – 12 Oct |
| Sprint 10 – Connections & Execution | 1 | 22 Oct |
| Post-review hardening | 2 | 26 Oct – 27 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `bea3b50` | Fresh addition | **feat(ai): reusable Claude service + shared HTTP client**<br/>server/ai/claude.ts wraps the Anthropic SDK (claude-opus-4-8, adaptive thinking, streaming for large outputs, retry-once, tolerant JSON parsing) as the single AI entry point Content Studio and Outreach will reuse. lib/http.ts centralizes outbound calls with timeouts + retry so no route makes raw fetch(). | dspraneeth07 | 23-Jul-2026 | 1 |
| 2 | `48afe94` | Fresh addition | **feat(ai): schema-validated structured generation (completeStructured)**<br/>Adds completeStructured() to the Claude wrapper: generate JSON, validate against a Zod schema, retry ONCE with a clarifying instruction on failure — the guarantee behind "never save malformed content". Adds unpdf, node-html-parser, robots-parser for knowledge ingestion. | dspraneeth07 | 23-Jul-2026 | 1 |
| 3 | `43ff16e` | Fresh addition | **feat(ai): add Google Gemini as an alternate AI provider**<br/>The whole app talks to AI through one module, so this lights up every AI feature (content, campaign plans, outreach, lead scoring, memory insights) when only a Gemini key is available. Uses Anthropic when ANTHROPIC_API_KEY is set, otherwise falls back to Gemini via the Generative Language REST API (no SDK). | dspraneeth07 | 31-Jul-2026 | 1 |
| 4 | `ac4d45e` | Fix | **fix: screens review — P0 generation failures, OAuth, first-run, lead scoring**<br/>Three separate "AI is broken" reports shared one root cause. Extended thinking draws from the same output-token budget as the reply, so a small max_tokens could be spent entirely on thinking and return a well-formed response containing a thinking block and no text. | dspraneeth07 | 27-Aug-2026 | 1 |
| 5 | `366b881` | Fresh addition | **feat(content,ai): audience-focused writing and per-task model tiers**<br/>Two problems, one commit, because the second pays for the first. | srbaggari | 02-Sep-2026 | 1 |
| 6 | `b973e45` | Fix | **fix(ai): stop Gemini truncating JSON answers; much faster generation**<br/>Current Gemini models think by default, and thinking tokens come out of the same maxOutputTokens budget as the answer. Measured: 946 thinking tokens for a 213-token JSON answer (~12s); on longer pieces the JSON was cut off, failed to parse and forced a full retry (a one-click Shorten took ~27s). | srbaggari | 06-Oct-2026 | 1 |
| 7 | `89cf8a2` | Change | **perf(planner): generate the monthly calendar fast, bounded and complete**<br/>The Content Plan hung at "Monthly calendar - 35%": the whole month was one high-effort model call (up to 8k output tokens), retries stacked to ~12 min, the job runner is killed at 60s, and a stuck run was only noticed after 10 min - so Generate again reattached to the dead run. | srbaggari | 09-Oct-2026 | 1 |
| 8 | `d78aace` | Fresh addition | **feat(content): content generation variations with a facts guardrail**<br/>Users can ask for a variation of a draft - added next to the current version, reviewed on its own, used only if chosen (lib/content-variations.ts). | srbaggari | 12-Oct-2026 | 1 |
| 9 | `183a772` | Fresh addition | **feat(content, meta, launch): Content Studio control, image refinement and preview, Meta review prep, production readiness**<br/>Content Studio; Recommendations workspace: compare versions, use one (others kept), edit, refine, regenerate or revert ONE version, add 1-3 more recommendations; Per-version CTA, website, address, phone and email (post details), never written by the AI; typed details must be confirmed before approval; | srbaggari | 22-Oct-2026 | 1 |
| 10 | `38083a5` | Fix | **fix(ai): honour the model tier on the Gemini path; local WhatsApp loop**<br/>THE BUG | dspraneeth07 | 26-Oct-2026 | 1 |
| 11 | `6cff62e` | Fix | **fix(whatsapp, content, media): four defects the full verifier sweep found**<br/>Running all 65 verify scripts turned up five failures. One was a dev-server artifact (two `next dev` instances sharing .next corrupt the webpack graph; the same request succeeds on retry) and four were real. | dspraneeth07 | 27-Oct-2026 | 1 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
