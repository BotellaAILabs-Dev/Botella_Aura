# Media, Graphics & Marketing Creatives — Architecture

The browser never talks to an image vendor. It calls Aura routes, and those routes run a few cheap checks and then queue a `GenerationJob`. The job runner drives the media services, which go through a provider registry to the vendors and store the resulting bytes in Postgres or an S3-compatible bucket. Every image, logo version and creative ends up as an ordinary `GeneratedAsset`, and a post attaches assets through `ContentMedia`.

## Component architecture

```mermaid
flowchart TD
  subgraph UI1["Draft page /dashboard/content/[id]"]
    GS["graphic-studio.tsx<br/>image-variant-panel.tsx"]
    CS["creative-studio.tsx"]
    AG["agnes-image-generator.tsx"]
  end
  subgraph R1["API routes"]
    RPrompt["/api/content/drafts/:id/graphics/prompt"]
    RGen["/api/content/drafts/:id/graphics<br/>/api/content/drafts/:id/creative"]
    RVar["/api/content/graphics/:assetId<br/>refine, regenerate, logo, attach"]
    RUp["/api/content/graphics/upload"]
    RFile["/api/content/graphics/:assetId/file"]
    RFree["/api/generate-image"]
    RJob["/api/jobs/:id/run"]
  end
  subgraph S1["Server services"]
    Prompt["image-prompt.service.ts<br/>visual-brief.service.ts"]
    Runner["jobs/runners.ts IMAGE_GENERATION"]
    Gen["generation.service.ts"]
    Var["variant.service.ts<br/>logo-overlay.ts"]
    Cre["creative.service.ts<br/>render.ts satori + resvg"]
    Store["persist.ts validate.ts<br/>storage.ts asset.service.ts"]
    Reg["providers/index.ts registry"]
  end
  DB[("PostgreSQL<br/>GeneratedAsset ContentMedia GenerationJob")]
  S3[("S3-compatible bucket")]
  Ext{{"OpenAI, Google, Agnes,<br/>Hugging Face, Stability, Replicate"}}
  LLM{{"AI layer LLM"}}

  GS --> RPrompt
  GS --> RGen
  GS --> RVar
  GS --> RUp
  CS --> RGen
  CS --> RVar
  AG --> RFree
  RPrompt --> Prompt
  Prompt -->|"art director"| LLM
  RGen -->|"enqueue"| DB
  RVar -->|"enqueue or sync logo"| Var
  GS -->|"kick and poll"| RJob
  RJob --> Runner
  Runner --> Gen
  Runner --> Var
  Runner --> Cre
  Cre --> Gen
  Cre -->|"copy"| LLM
  Var --> Reg
  Gen --> Reg
  RFree --> Reg
  Reg --> Ext
  Gen --> Store
  Var --> Store
  Cre --> Store
  RUp --> Store
  Store --> DB
  Store -->|"when ASSET_S3 set"| S3
  RFile --> Store
```

The top band is the three UI components on the draft page. The middle band is the Next.js route handlers. The lower band is `server/media/` together with the job runner. Generation, creatives with a new photo, refine, regenerate and make-space requests only enqueue a job. The browser then calls `/api/jobs/:id/run`, and the runner dispatches to `generateGraphics`, `generateCreative` or the variant service. All of these paths converge on the same storage path: `persistImage`, then `validateImageBytes`, then `putImage`, then `createAsset`. `/api/generate-image` is the one path that calls the provider registry and returns the bytes directly, without storing anything.

## Main flow

```mermaid
sequenceDiagram
  participant UI as Graphic Studio
  participant PR as /api/content/drafts/:id/graphics/prompt
  participant GR as /api/content/drafts/:id/graphics
  participant JR as /api/jobs/:id/run
  participant RU as runners IMAGE_GENERATION
  participant GE as generation.service
  participant PV as Image provider
  participant ST as persist and storage
  participant DB as PostgreSQL

  UI->>PR: POST style, guidance
  PR->>PR: visualBriefForDraft then LLM or heuristic
  PR-->>UI: prompt, negativePrompt, subject, visual brief
  UI->>GR: POST prompt, provider, aspectRatio, variations, logo
  GR->>GR: role, provider configured, 6 per min, entitlement, clamp to plan
  GR->>DB: enqueueJob IMAGE_GENERATION dedupe on draftId
  GR-->>UI: 202 jobId
  UI->>JR: POST run
  JR->>RU: runJob
  RU->>GE: generateGraphics with jobId
  GE->>GE: resolveProvider, resolveFormat, count already done
  GE->>PV: generateImage remaining count
  PV-->>GE: image bytes
  loop each image
    GE->>ST: persistImage validate then putImage then createAsset
    ST->>DB: GeneratedAsset with metadata.jobId
    opt logo mode include
      GE->>ST: placeLogoOn stores logo version and hides clean copy
    end
  end
  GE->>DB: audit GRAPHIC_GENERATED
  RU-->>JR: assets, provider, warning, alternatives
  UI->>JR: GET /api/jobs/:id poll until SUCCEEDED
  UI->>UI: show variants, user attaches one
```

Read the diagram top to bottom. The prompt call is cheap and runs synchronously. Generation is paid, so it is queued. Every check that should fail fast (role, provider configured, burst limit, plan allowance) runs before the job row is created. Inside the runner, `generateGraphics` subtracts any images an earlier attempt of the same job already stored, so a retry pays only for the shortfall. Each image is stored on its own; one rejected image does not lose the rest, and the shortfall comes back as `warning`.

## Lifecycle / state machine

### Generation job

```mermaid
stateDiagram-v2
  [*] --> QUEUED: route enqueues
  QUEUED --> RUNNING: claimJob via run or cron
  RUNNING --> SUCCEEDED: assets stored
  RUNNING --> QUEUED: retryable error and attempts below 3
  RUNNING --> FAILED: permanent error or 3 attempts
  RUNNING --> QUEUED: stuck 3 min, reaper requeues
  SUCCEEDED --> [*]
  FAILED --> [*]
```

`GenerationJobStatus` is owned by the jobs platform, but image runs use their own stuck threshold of 3 minutes. Errors that declare `retryable = false`, such as `NoImageProviderError`, go straight to FAILED. A retried run resumes from the assets stamped with its `jobId`, so returning to QUEUED never charges for the same images twice.

### Image variant versions

```mermaid
stateDiagram-v2
  [*] --> GENERATED: generateGraphics or upload
  GENERATED --> REFINED: refine with instruction
  GENERATED --> REGENERATED: regenerate
  GENERATED --> LOGO: include or none
  REFINED --> REFINED: refine again
  REFINED --> LOGO: include or none
  REGENERATED --> REFINED: refine
  REGENERATED --> LOGO: include or none
  LOGO --> REFINED: refine clean copy then re-place logo
  LOGO --> LOGO: change position or tint
```

Each state is a value of `metadata.variant.action` on a **new** `GeneratedAsset`. Every transition creates the next version under the same `rootId`; nothing is edited in place, so choosing an earlier version is how a user reverts. A LOGO version keeps a pointer (`cleanId`) to the hidden logo-free image, and refinements always edit that clean copy. The image model never sees the logo.

## Data model

```mermaid
erDiagram
  Company ||--o{ GeneratedAsset : "owns"
  Company ||--o{ GenerationJob : "runs"
  ContentDraft |o--o{ GeneratedAsset : "generated for"
  ContentDraft ||--o{ ContentMedia : "has ordered media"
  GeneratedAsset ||--o{ ContentMedia : "attached as"
  User |o--o{ GeneratedAsset : "created by"

  GeneratedAsset {
    string id PK
    string companyId FK
    string contentDraftId FK
    string createdById FK
    enum provider
    string model
    enum kind
    string prompt
    string originalPrompt
    string revisedPrompt
    string negativePrompt
    string style
    string aspectRatio
    int width
    int height
    string mimeType
    int fileSize
    enum storage
    string storageUrl
    string sourceUrl
    enum platform
    json metadata
    datetime createdAt
  }
  ContentMedia {
    string id PK
    string companyId FK
    string contentDraftId FK
    string assetId FK
    enum kind
    int position
    string altText
    datetime createdAt
  }
  GenerationJob {
    string id PK
    string companyId FK
    string userId
    enum kind
    enum status
    json inputs
    json progress
    json result
    int attempts
    datetime createdAt
  }
  ContentDraft {
    string id PK
    string companyId FK
    json aiMetadata
  }
```

`GeneratedAsset` stores every visual: generated images, uploads (`provider = UPLOAD`), videos (`kind = VIDEO`), logo versions and composed creatives (`metadata.kind = creative`). With database storage the bytes are kept in the `data` column, which is left out of the diagram. Deleting a draft sets `contentDraftId` to null rather than deleting the asset, so a graphic reused on another post survives. `ContentMedia` is the ordered join that turns assets into a post's media set, including carousels, and the unique key on draft and asset makes attaching the same asset twice a no-op. `GenerationJob.inputs` carries the variant or creative payload, and `ContentDraft.aiMetadata.brief.visual` is where the stored visual brief comes from.

## Design decisions

- **Provider abstraction plus registry** (`server/media/types.ts`, `providers/index.ts`). Adding a vendor means one file and one registry line. Routes and components never name a vendor. Registry order (OpenAI, Google, Agnes, Hugging Face, Stability, Replicate) decides the default. An explicit choice that is not configured is refused, never silently swapped, so a workspace is never billed for a model it did not pick.
- **Generation runs as a job, not inline.** Several variations on a slow provider exceed a serverless function's time budget. Checks that should fail fast run in the route before the job exists. Jobs are deduplicated per draft, and a conflicting request returns 409 instead of quietly attaching to the run already in progress.
- **Resumable by `metadata.jobId` / `creativeJobId`.** A run killed by the platform is retried and pays only for the images it had not finished.
- **Durable storage by default in Postgres.** Provider URLs expire within hours and the deployment targets have no writable disk. `ASSET_S3_*` switches to a bucket with no code change, and each row records which store holds its bytes, so assets made before the switch keep working. SigV4 is hand-written rather than pulling in the AWS SDK. A failed bucket upload falls back to the database because the image has already been paid for. Video has no database fallback.
- **Trust bytes, not headers.** Magic-byte sniffing and header-read dimensions run before storage, so a provider's HTML error page never becomes an asset row.
- **Signed URLs instead of a public route.** Instagram fetches media by URL, so the file route accepts a short-lived HMAC grant (15 min) or a session. Without either it answers 404, so it never confirms that an asset id exists.
- **The model never draws the logo or the words.** Prompts reserve clean space for the logo. The exact uploaded logo is composited with sharp (with tinting that keeps the alpha channel). Creative text is set by satori and resvg in bundled OFL fonts, measured against real font metrics. This avoids garbled lettering and redrawn marks.
- **Versions, never overwrites.** Lineage lives in `metadata` (`variant`, `logo`, `cleanId`, `hidden`), so no schema change was needed, every earlier version stays usable, and refinements work on the logo-free copy.
- **Fact-guarded creative copy.** Text the user typed is locked. Figures and details the model writes are checked against the user's own request, the post and the business facts, and anything unsupported is dropped and reported. When no photo can be made, the creative falls back to the brand background and is labelled honestly instead of failing.
- **Visual brief as the art director's input.** The prompt is written from what the piece is *for* (the recommendation's key message, product, audience, palette, mood, the channel's shape) rather than guessed from the post's first line. Missing inputs are listed with a link to fix them, never invented.
- **Usage counts generations, not compositions.** Creatives and logo versions reuse an image that has already been counted, so they do not reduce the monthly allowance. Entitlement checks and the studio meter share one count, `assetsThisMonth`.
- **Media changes reopen approval.** Attaching or detaching goes through `recordContentChange`, because an approval covers the images as well as the text.
