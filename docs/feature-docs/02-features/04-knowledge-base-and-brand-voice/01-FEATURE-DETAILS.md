# Knowledge Base & Brand Voice

> The knowledge base takes a company's own material and stores it as small, searchable chunks. That material is the public website and blog, plus documents uploaded by the team: decks, brand guidelines, ICP notes, product docs and competitor battlecards. Each document is labelled with the kind of material it is. Every AI workflow can then pull the most relevant excerpts and tell the model what each one is (rules to follow, facts to state, competitor context never to echo). The Brand Voice Profile is a structured description of how the company sounds, written by AI from those chunks and then reviewed and edited by a person. It is added to every content-generation prompt. Together they exist so Aura writes from what the company actually says, not from generic guesswork.

## 1. Overview

- **Ingestion** (`server/knowledge/ingest.service.ts`) turns three source types into `KnowledgeChunk` rows:
  - **Website**: the homepage plus `/about`, `/about-us`, `/company` and `/blog` (`WEBSITE_PATHS`). Each fetch respects robots.txt and is throttled.
  - **Blog / RSS**: an RSS or Atom feed found through a `<link type="application/rss+xml|atom+xml">` on the homepage. Up to 12 entries are read (`MAX_BLOG_ITEMS`).
  - **Uploads**: `.pdf`, `.docx`, `.pptx`, `.txt`, `.md` and `.markdown` files, each tagged with an optional `MaterialCategory`.
- **Re-sync replaces chunks.** `replaceChunks()` deletes and re-inserts all chunks for one `(companyId, sourceType, sourceUrl)` in a single transaction. Re-syncing a site or re-uploading a file with the same name never creates duplicates.
- **Material categories** (`lib/materials.ts`). There are nine kinds of material. Each one sets:
  - a retrieval weight (from 1.0 to 1.6);
  - whether the material is *timeless*, meaning it is exempt from recency decay;
  - the label the model sees above its excerpts.
- **Retrieval** (`server/knowledge/retrieve.ts`) uses keyword overlap, category or source weight, and a 30-day recency half-life. There are no embeddings, and retrieval is deterministic.
- **Coverage** (`server/knowledge/coverage.ts`) reports which kinds of material the workspace has and which are missing, counted from chunks that can actually be retrieved.
- **Brand Voice Profile** (`server/content/brand-voice.service.ts`):
  - Produced by AI from retrieved chunks and the onboarding notes. A deterministic heuristic is used when no AI provider is configured or the AI call fails.
  - Validated by `brandVoiceProfileSchema` and stored in `Company.brandVoiceProfile`.
  - Every write goes through the Business Context write service.
- **Brand Context** (`server/brand/brand-context.service.ts`) is a projection of the Business Context. It bundles identity, audience, voice and knowledge passages into one object and renders them as one prompt preamble (`brandContextToPrompt`). Used by planning, outreach, engagement and image workflows.

## 2. User-facing behaviour

| Screen | Route | What the user can do | Roles |
|---|---|---|---|
| Business materials | `/dashboard/settings/knowledge-base` (`app/dashboard/settings/knowledge-base/page.tsx`, page title "Business materials") | See the material coverage card, the synced sources, the uploaded documents and the total chunk count. **Sync website** (disabled when the company has no website). **Upload** a document, then confirm its category in a picker. Generate, edit and save the Brand Voice Profile. | Any workspace member (no RBAC check, see §9) |
| Settings | `/dashboard/settings` | Card that links to the Business materials page. | Any member |
| Content Studio, Business Context, onboarding, opportunity UI, intelligence | various | Empty states and "missing" prompts link to `/dashboard/settings/knowledge-base`. Sources: `app/dashboard/content/page.tsx`, `components/dashboard/business/business-context-view.tsx`, `lib/onboarding.ts`, `lib/business-context.ts`, `lib/business-context-questions.ts`, `lib/opportunity-ui.ts`, `server/intelligence/foundations.ts`, `server/intelligence/intelligence.service.ts`. | Any member |

UI details (from the code):

- **Material coverage** (`components/dashboard/knowledge/material-coverage.tsx`):
  - Shows "{covered} of {total} kinds of material", with 8 kinds prompted (all except `OTHER`).
  - Highlights the top missing kind. That is the first gap in weight order, so it is the one that would improve writing most.
  - Notes how many uncategorised chunks (website and older uploads) Aura is still using.
- **Knowledge manager** (`components/dashboard/knowledge/knowledge-manager.tsx`):
  - The file input accepts `.pdf,.docx,.pptx,.txt,.md,.markdown`.
  - After a file is chosen, the picker defaults to `guessCategory(filename)` and the user confirms or changes it. The guess is never applied silently.
  - Toasts: "Synced — N chunks ingested." and "{Category label} added — Aura has read N sections."
  - Sources are listed with status, last sync time, error and chunk count. Uploads are listed with their category label, or "Uncategorised".
- **Brand voice card** (`components/dashboard/content/brand-voice-card.tsx`): **Generate** calls `POST /api/brand-voice`, and **Save voice** calls `PUT /api/brand-voice` with the edited profile.

`components/brand/logo.tsx` sits in this feature's path map but is only the Botella Aura wordmark used by the app shell. It has no knowledge or voice logic.

## 3. How it works

### 3.1 Website ingestion (`ingestWebsite`)

1. Normalise the URL. `https://` is added when the scheme is missing, and a URL that will not parse returns 0 chunks. The source key is the URL's origin.
2. Upsert a `KnowledgeSource` row (`type = WEBSITE`, `label` = hostname) with `status = SYNCING`.
3. For each of the paths `''`, `/about`, `/about-us`, `/company` and `/blog`, call `politeFetchHtml(url)` (`server/knowledge/robots.ts`):
   - It fetches and caches the origin's `robots.txt` in process memory with a 6 s timeout. A missing or unreachable file counts as allowed.
   - It skips the page when the user agent `BotellaAuraBot/0.1 (+https://botella.ai/bot)` is disallowed.
   - It waits `THROTTLE_MS = 1200` ms, then fetches with a 10 s timeout and 1 retry.
4. From the homepage only, try to discover an RSS/Atom feed.
5. Run `htmlToText()` (`server/knowledge/extract.ts`), which never executes page JavaScript:
   - It first collects `<title>`, meta description, `og:*` and `twitter:description` tags, keywords and JSON-LD strings (up to 1500 characters). This is how JavaScript-rendered sites still yield brand copy.
   - It then removes `script, style, noscript, nav, footer, header, svg, form` and reads `main`, `article` or `body`, de-duplicating repeated lines.
6. Skip pages whose text is 60 characters or shorter. Skip pages whose first 200 characters match an already-seen page; this catches single-page apps that serve the same HTML shell on every route.
7. `replaceChunks()`, then set the source to `SYNCED` with `lastSyncedAt`. `error` is set to `"No readable pages found"` when no page qualified. Audit `KNOWLEDGE_SOURCE_SYNCED`.

### 3.2 Blog ingestion (`ingestBlog`)

1. Upsert a `BLOG` source labelled "Blog feed" with `status = SYNCING`.
2. Fetch the feed with a 10 s timeout. If the fetch fails, set the source to `ERROR` with the error message and return 0 chunks.
3. Parse RSS `channel.item` and Atom `feed.entry` with `fast-xml-parser`, keeping the first 12 entries.
4. Take the text from `content:encoded`, `content`, `description` or `summary`, with HTML stripped. Keep only entries longer than 120 characters.
5. `replaceChunks()`, set the source to `SYNCED`, and audit `KNOWLEDGE_SOURCE_SYNCED`.

`resyncCompany()` runs the website ingestion and then the blog ingestion. A blog failure is logged and does not fail the sync.

### 3.3 Upload ingestion (`ingestUpload`)

1. The route checks the file extension against the allow-list and enforces `MAX_BYTES = 4_000_000`; larger files get a 413.
2. The route narrows the `category` form field with `isMaterialCategory()`. An unknown value is dropped (`null`) rather than rejecting the upload.
3. The service applies its own `MAX_UPLOAD_BYTES = 10 MB` cap.
4. The extractor is chosen by extension, not by MIME type, because browsers mislabel Office files:
   - **PDF**: `pdfToText()` via `unpdf`. A parse failure returns 422 with advice about scanned or password-protected PDFs.
   - **DOCX/PPTX**: `officeToText()` (`server/knowledge/office.ts`), a dependency-free ZIP reader that uses `node:zlib`. It does not support ZIP64 or encryption. `OfficeParseError` messages are written for the user.
   - **Text**: `TextDecoder`.
5. If the extracted text is shorter than 20 characters, return 422. For PDFs the message says the file looks scanned.
6. `replaceChunks(companyId, 'UPLOAD', filename, ..., category)`. Each filename is its own source, so re-uploading a file replaces its chunks. Uploads do **not** get a `KnowledgeSource` row: an upload is just its chunks.
7. Audit `KNOWLEDGE_DOCUMENT_UPLOADED` with `{ filename, chunks, category }`.

### 3.4 Chunking (`server/knowledge/chunk.ts`)

- Split on blank lines, then pack paragraphs into chunks of up to `TARGET_CHARS = 3200` characters (about 800 tokens).
- A paragraph longer than the target is split on sentence boundaries.
- Chunks shorter than `MIN_CHUNK_CHARS = 80` are dropped.
- `tokenCount = ceil(length / 4)`.

### 3.5 Material categories (`lib/materials.ts`)

The list is ordered by weight, so the first missing kind is always the most valuable one to add.

| Category | Label | Weight | Timeless | Prompt label (abridged) |
|---|---|---|---|---|
| `DIFFERENTIATORS` | Key differentiators | 1.6 | yes | WHAT MAKES THIS COMPANY DIFFERENT |
| `AUDIENCE_ICP` | Target audience / ICP | 1.5 | yes | WHO THIS COMPANY SELLS TO |
| `BRAND_GUIDELINES` | Brand guidelines | 1.4 | yes | BRAND RULES (follow these exactly) |
| `PITCH_DECK` | Pitch deck | 1.35 | yes | THE COMPANY'S OWN PITCH |
| `PAST_CAMPAIGN` | Existing content & campaigns | 1.25 | no | CONTENT THIS COMPANY HAS PUBLISHED BEFORE |
| `COMPANY_INFO` | Company & product information | 1.2 | yes | ABOUT THE COMPANY |
| `COMPETITOR_INTEL` | Competitor information | 1.15 | no | COMPETITOR MATERIAL (context only, never adopt their voice or repeat their claims as ours) |
| `PRODUCT_DOCS` | Product documentation | 1.1 | no | PRODUCT DOCUMENTATION (factual; do not embellish) |
| `OTHER` | Something else | 1.0 | no | COMPANY MATERIAL |

`guessCategory(filename)` checks the filename for keywords: brand/tone, then pitch/deck, ICP/persona, competitor/battlecard, positioning, docs/spec, campaign/newsletter, and finally about/company/product. A bare `.pptx` defaults to `PITCH_DECK`, and anything else to `OTHER`.

### 3.6 Retrieval (`retrieve(companyId, query, { limit = 6 })`)

1. Load up to 400 of the company's newest chunks.
2. Split the query into terms: lowercase alphanumerics longer than 2 characters, with stopwords removed.
3. Score each chunk as `relevance × weight × decay`:
   - `relevance` is the share of query terms found in the chunk's title and content. A chunk with no overlap scores 0.
   - `weight` is the category weight. A chunk with no category falls back to the source weight: `PAST_POST` 1.25, `BLOG` 1.15, `UPLOAD` 1.1, `WEBSITE` 1.0.
   - `decay` is 1 for timeless categories. For everything else it is `0.7 + 0.3 × 0.5^(ageDays/30)`, so the factor never drops below 0.7.
4. Return the top `limit` chunks. When nothing matches, fall back to the `limit` most recent chunks with score 0.
5. `chunksToContext()` groups excerpts by category prompt label, numbers them `[1]`, `[2]` and so on across groups, and truncates each to 800 characters. With no chunks it returns `"(No company knowledge base content available.)"`.

### 3.7 Coverage (`getMaterialCoverage`)

- Groups chunk counts by `category`.
- Returns, for the 8 prompted categories: `items`, `missing` (in weight order), `covered`, `total`, and `uncategorisedChunks` (the count for a `null` category).

### 3.8 Brand Voice Profile

- **Schema** (`brandVoiceProfileSchema` in `lib/validations/content.ts`):

  | Field | Limit or default |
  |---|---|
  | `toneDescriptors` | up to 10 items, 40 characters each |
  | `sentenceLength` | `short`, `medium`, `long` or `varied` |
  | `vocabulary` | up to 20 items, 60 characters each |
  | `commonPhrases` | up to 15 items, 120 characters each |
  | `topicsToAvoid` | up to 15 items, 80 characters each |
  | `formatting.emojiUsage` | default `minimal` |
  | `formatting.hashtagStyle` | default `a few relevant hashtags` |
  | `formatting.notes` | up to 300 characters |
  | `summary` | up to 600 characters |

- **`generateBrandVoiceProfile({ company, userId, force })`**:
  - Returns the stored profile unless `force` is set.
  - When an AI provider is configured (`isClaudeConfigured()`, meaning Anthropic or Gemini):
    1. Retrieve 8 chunks for `"<name> <industry>"`.
    2. Redact personal and secret data with `redactSensitive(..., { personal: true })`.
    3. Call `completeStructured` with `tier: 'standard'`, `effort: 'medium'` and `maxTokens: 1500`.
  - If the AI call fails, or no provider is configured, it uses `heuristicProfile()`. That profile is built from `brandVoiceNotes`, defaulting to "Clear, professional {industry} voice. Practical and specific, no hype."
  - The result is saved through `updateBusinessContext` with `patch: { voice: { profile } }`, `origin: 'ai'` and audit `BRAND_VOICE_GENERATED` (metadata `source: claude|heuristic`). Rule R6 in `server/business-context/update.ts` allows an `ai` origin to write only `voice.profile` (`AI_WRITABLE_FIELDS`).
- **Lazy generation.** The content generator, comment drafting and outreach drafting call it without `force`, so a profile is created on first use. Sources: `server/content/generator.ts`, `server/engagement/comment.service.ts`, `server/outreach/drafting.service.ts`.
- **`updateBrandVoiceProfile`** validates the input, then saves with `origin: 'settings'`, `confirm: ['voice.profile']` and audit `BRAND_VOICE_UPDATED`. Saving counts as a human confirmation even when nothing was edited.
- **`brandVoiceToPrompt(profile)`** renders the `BRAND VOICE — write exactly in this voice:` instruction block.

### 3.9 Brand Context (`server/brand/brand-context.service.ts`)

- `getBrandContext(companyId, { query, knowledgeLimit })` calls `getBusinessContext(..., { sections: ['targeting'] })` and projects the result into `{ company, business, audience, voice, knowledge }`. Knowledge is retrieved only when a `query` is passed.
- `brandContextToPrompt()` builds the prompt in this order:
  1. identity;
  2. audience (always included);
  3. voice (optional);
  4. B2B/B2C writing rules (optional);
  5. knowledge, under the heading "COMPANY KNOWLEDGE — the only facts you may state as this company".
- `hasBrandContext()` lets callers tell an empty workspace apart from a failure.

## 4. Code map

| Layer | File | Responsibility |
|---|---|---|
| Page | `app/dashboard/settings/knowledge-base/page.tsx` | Server component that loads status, coverage and voice profile |
| Component | `components/dashboard/knowledge/knowledge-manager.tsx` | Sync, upload with category picker, sources and uploads list |
| Component | `components/dashboard/knowledge/material-coverage.tsx` | Coverage card, top gap, uncategorised count |
| Component | `components/dashboard/content/brand-voice-card.tsx` | Generate, edit and save the voice profile |
| Component | `components/brand/logo.tsx` | Aura wordmark (not feature logic) |
| API | `app/api/knowledge/upload/route.ts` | Multipart upload (Node runtime, `maxDuration = 60`) |
| API | `app/api/knowledge/sync/route.ts` | Re-ingest website and blog |
| API | `app/api/brand-voice/route.ts` | GET, POST (regenerate) and PUT (save edits) |
| Service | `server/knowledge/ingest.service.ts` | `ingestWebsite`, `ingestBlog`, `ingestUpload`, `resyncCompany`, `getKnowledgeStatus` |
| Service | `server/knowledge/retrieve.ts` | `retrieve`, `chunksToContext` |
| Service | `server/knowledge/coverage.ts` | `getMaterialCoverage` |
| Service | `server/knowledge/extract.ts` | `htmlToText`, `pdfToText`, `stripHtml` |
| Service | `server/knowledge/office.ts` | `officeToText`, `OfficeParseError` (DOCX/PPTX) |
| Service | `server/knowledge/chunk.ts` | `chunkText`, `estimateTokens` |
| Service | `server/knowledge/robots.ts` | `isAllowed`, `politeFetchHtml`, `KB_USER_AGENT` |
| Service | `server/content/brand-voice.service.ts` | Generate, read, update and render the voice profile |
| Service | `server/brand/brand-context.service.ts` | `getBrandContext`, `brandContextToPrompt`, `hasBrandContext` |
| Lib | `lib/materials.ts` | `MATERIAL_CATEGORIES`, `materialCategory`, `guessCategory`, `isMaterialCategory` |
| Lib | `lib/validations/content.ts` | `brandVoiceProfileSchema` |
| Tests | `tests/materials.test.ts`, `tests/retrieve.test.ts`, `tests/brand-context.test.ts` | Unit tests (see §10) |
| Scripts | `scripts/verify-materials.ts` | End-to-end check against a real database |

Consumers outside this feature that call `retrieve`, `chunksToContext`, `getBrandContext` or the voice service:

- `server/content/generator.ts`, `server/content/generation-context.service.ts` and `server/content/fact-check.service.ts`. The fact checker reads `knowledgeChunkIds`.
- `server/business-context/build.ts`, `business-context.service.ts`, `snapshot.service.ts` and `snapshot.ts`.
- `server/campaigns/planner.ts`, `server/planner/plan.service.ts`, `server/outreach/drafting.service.ts`, `server/engagement/comment.service.ts` and `server/intelligence/intelligence.service.ts`.
- `server/competitors/sources/website.ts` and `server/leads/discovery/sources/company-site.ts`, which reuse the robots and extract helpers.

## 5. Data model

| Model / field | Key fields | Notes |
|---|---|---|
| `KnowledgeSource` | `id`, `companyId`, `type: KnowledgeSourceType`, `category: MaterialCategory?`, `url?`, `label`, `status: KnowledgeSourceStatus` (default `PENDING`), `lastSyncedAt?`, `error?`, `createdAt`, `updatedAt` | `@@unique([companyId, type, url])`. Created only for `WEBSITE` and `BLOG`. Cascade-deleted with `Company`. |
| `KnowledgeChunk` | `id`, `companyId`, `sourceType`, `category?`, `sourceUrl?`, `title?`, `content` (Text), `tokenCount?`, `createdAt` | `@@index([companyId, sourceType])`. `category` is copied onto the chunk so retrieval needs no join. For uploads, `sourceUrl` holds the filename. |
| `enum KnowledgeSourceType` | `WEBSITE`, `BLOG`, `UPLOAD`, `PAST_POST` | No ingestion code currently writes `PAST_POST`. It appears only in the retrieval weights. |
| `enum KnowledgeSourceStatus` | `PENDING`, `SYNCING`, `SYNCED`, `ERROR` | Sync lifecycle |
| `enum MaterialCategory` | `COMPANY_INFO`, `PITCH_DECK`, `BRAND_GUIDELINES`, `AUDIENCE_ICP`, `PRODUCT_DOCS`, `DIFFERENTIATORS`, `PAST_CAMPAIGN`, `COMPETITOR_INTEL`, `OTHER` | What a document is |
| `Company.brandVoiceProfile` | `Json?` | Validated by `brandVoiceProfileSchema` when read (`getBrandVoiceProfile` returns null on bad data) |
| `Company.brandVoiceNotes` | `String?` (Text) | Onboarding voice notes. Input to the heuristic and the AI prompt. |

## 6. API endpoints

The full list is in [Internal API](../../04-api/INTERNAL-API.md).

| Method | Path | Purpose | Auth/permission |
|---|---|---|---|
| POST | `/api/knowledge/upload` | Multipart `file` plus optional `category`. Returns `{ filename, chunks, category }`. Errors: 400 no file, 413 too large, 415 wrong type, 422 unreadable. | Signed-in member of the active company (`requireActiveCompany`) |
| POST | `/api/knowledge/sync` | Re-ingest the company website and discovered blog. Returns `{ chunks }`. 400 when no website is set. | Same |
| GET | `/api/brand-voice` | Current profile, or `null` | Same |
| POST | `/api/brand-voice` | Regenerate the profile (`force: true`) | Same |
| PUT | `/api/brand-voice` | Save a human-edited profile (Zod-validated, 422 on bad shape) | Same |

## 7. External services

- **Company websites and RSS feeds**: plain HTTP GET through `lib/http.getText`, with the `BotellaAuraBot` user agent, respecting robots.txt.
- **AI provider** (`server/ai/claude.ts`, `completeStructured`): used only for brand voice generation. `isClaudeConfigured()` is true when either the Anthropic or the Gemini key is present, and the `standard` tier resolves to that provider's model.
- **Libraries**: `unpdf` (PDF), `node-html-parser`, `fast-xml-parser` and `robots-parser`. DOCX and PPTX are read with `node:zlib` and need no third-party library.

See [Environment variables](../../06-environment/ENVIRONMENT-VARIABLES.md) for the AI provider keys. This feature reads no environment variable of its own.

## 8. Background jobs & cron

Not applicable. Ingestion runs only inside the request: a user clicks **Sync website** or uploads a file. Voice generation runs on request, or lazily the first time a generator needs a profile. No cron or job queue re-syncs knowledge sources.

## 9. Security & permissions

- **Workspace scoping.** Every route resolves the active company through `requireActiveCompany()` (403 for non-members). Every query filters on `companyId`, and `KnowledgeSource` and `KnowledgeChunk` cascade-delete with the company.
- **No RBAC permission check.** None of the three routes calls `can(...)`, so a `VIEWER` can upload documents, re-sync and regenerate or overwrite the brand voice. `lib/rbac.ts` describes VIEWER as read-only, so this does not match the stated role matrix.
- **What AI may write.** Voice generation is written with `origin: 'ai'`, and the Business Context update rules (R6) refuse any AI-origin change except `voice.profile`. Human saves mark `voice.profile` as confirmed.
- **Validation:**
  - File extension allow-list and a 4 MB size limit in the route, plus a 10 MB limit in the service.
  - `category` is narrowed to the enum.
  - The voice profile is Zod-validated on PUT and on every read.
- **Privacy.** Knowledge excerpts pass through `redactSensitive(..., { personal: true })` before the voice-generation prompt.
- **Crawling ethics.** Crawling respects robots.txt, waits 1.2 s between requests, reads only server-served HTML (never executes JavaScript) and does not bypass authentication.
- **Prompt hygiene.** Competitor material is labelled "context only — never adopt their voice or repeat their claims as ours". Brand Context tells the model that knowledge passages are "the only facts you may state".
- **Audit actions:** `KNOWLEDGE_SOURCE_SYNCED`, `KNOWLEDGE_DOCUMENT_UPLOADED`, `BRAND_VOICE_GENERATED` and `BRAND_VOICE_UPDATED`.

## 10. Testing

- `tests/materials.test.ts`:
  - `officeToText` for Word: paragraphs, line breaks, XML entities, headers.
  - `officeToText` for PowerPoint: slide order, slide labels, speaker notes, ignored layouts and masters.
  - Failure messages.
  - Category invariants: unique ids, descending weight, timeless flags, the competitor warning.
  - `guessCategory`, and the grouping and numbering in `chunksToContext`.
- `tests/retrieve.test.ts`: query ranking, the past-post boost over website chunks, the fallback to recent chunks, and an empty knowledge base.
- `tests/brand-context.test.ts`: `brandContextToPrompt` covering description and audience, B2C/B2B rules, the empty workspace, the omit options, and the knowledge labelling.
- `pnpm verify:materials` (`scripts/verify-materials.ts`): against a real database, checks that an upload becomes retrievable chunks, that categories change which excerpts win, that timeless material is not decayed, and coverage. Its data is namespaced and cleaned up afterwards.
- `pnpm verify:sipn` (`scripts/verify-sipn.ts`) also calls `getMaterialCoverage`.

## 11. Configuration & limits

| Setting | Value | Where |
|---|---|---|
| Allowed upload types | `.txt .md .markdown .pdf .docx .pptx` | `app/api/knowledge/upload/route.ts` |
| Route upload cap | 4,000,000 bytes (platform bodies cap at about 4.5 MB on Vercel) | same |
| Service upload cap | 10 MB | `ingest.service.ts` |
| Upload route runtime | `nodejs`, `maxDuration = 60` s | upload route |
| Website paths crawled | `''`, `/about`, `/about-us`, `/company`, `/blog` | `WEBSITE_PATHS` |
| Minimum page text | more than 60 characters | `ingestWebsite` |
| Blog entries | 12, each over 120 characters | `MAX_BLOG_ITEMS` |
| Fetch timeouts | robots.txt 6 s; pages and feeds 10 s | `robots.ts`, `ingest.service.ts` |
| Throttle | 1200 ms per page fetch | `THROTTLE_MS` |
| Chunk size | target 3200 characters, minimum 80 | `chunk.ts` |
| Minimum extracted text | 20 characters | `ingestUpload` |
| Retrieval scan / default limit | 400 chunks / 6 | `retrieve.ts` |
| Recency half-life | 30 days (decay floor 0.7) | `retrieve.ts` |
| Excerpt length in prompt | 800 characters | `chunksToContext` |
| Voice generation | 8 chunks, `tier: standard`, `effort: medium`, `maxTokens: 1500` | `brand-voice.service.ts` |

## 12. Known limitations & future work

- **Retrieval is keyword-based.** It only considers the 400 newest chunks. `retrieve.ts` names semantic or vector search (pgvector) as the planned upgrade behind the same `retrieve()` interface.
- **No way to remove material.** There is no endpoint to delete an upload or a source, or to change an upload's category after ingestion. Re-uploading with the same filename replaces the chunks.
- **Only the newest category counts.** Re-uploading a file under a different category replaces its chunks, since the key is filename plus type.
- **Size caps do not agree.** The route caps uploads at about 4 MB while the service allows 10 MB, so the 10 MB limit is never reached through the route.
- **Scanned PDFs are rejected.** Image-only PDFs and decks yield a 422. There is no OCR.
- **No automatic re-sync.** Website and blog material goes stale until someone clicks **Sync website**.
- **`PAST_POST` is never written.** The source type exists, and retrieval weights it, but no code ingests it.
- **No RBAC on knowledge or voice routes.** See §9.
- **Robots cache lifetime.** The robots.txt cache is per process and is never invalidated while the process runs.

## 13. Related documents

- [SPRINT-3-TECHNICAL.md](../../../SPRINT-3-TECHNICAL.md): original knowledge base and brand voice design (§4–5)
- [BUSINESS-CONTEXT-MODEL.md](../../../BUSINESS-CONTEXT-MODEL.md): how `voice` and `knowledge` sections enter the Business Context
- [BUSINESS-CONTEXT-SOURCES-AUDIT.md](../../../BUSINESS-CONTEXT-SOURCES-AUDIT.md)
- [GENERATION-CONTEXT.md](../../../GENERATION-CONTEXT.md): how retrieved chunks and the voice profile reach generation
- [FACT-CHECK.md](../../../FACT-CHECK.md): fact checking against `knowledgeChunkIds`
- [PRODUCT-DOCUMENTATION.md](../../../PRODUCT-DOCUMENTATION.md)
- [DATA-ACCESS-SECURITY.md](../../../DATA-ACCESS-SECURITY.md), [PERMISSIONS-SECURITY.md](../../../PERMISSIONS-SECURITY.md)
- Sibling features: [05 Business Context](../05-business-context/01-FEATURE-DETAILS.md), [07 Competitor Intelligence](../07-competitor-intelligence/01-FEATURE-DETAILS.md), [11 Content Studio](../11-content-studio/), [16 Engagement Copilot](../16-engagement-copilot/), [15 Leads & Outreach](../15-leads-and-outreach/), [23 AI Layer](../23-ai-layer/)
- Architecture: [02-ARCHITECTURE.md](./02-ARCHITECTURE.md)
