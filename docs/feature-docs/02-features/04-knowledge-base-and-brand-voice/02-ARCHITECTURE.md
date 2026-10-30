# Knowledge Base & Brand Voice — Architecture

The knowledge base is a small ingestion and retrieval pipeline. Website pages, blog feeds and uploaded documents become `KnowledgeChunk` rows, and AI workflows retrieve them with keyword scoring weighted by the kind of material. The Brand Voice Profile is a JSON document on `Company`. AI generates it from those chunks, people edit it, and every write goes through the Business Context write service.

## Component architecture

```mermaid
flowchart LR
  subgraph UI1["Settings / Business materials page"]
    Cov["material-coverage.tsx"]
    Mgr["knowledge-manager.tsx"]
    Voice["brand-voice-card.tsx"]
  end
  subgraph API1["API routes"]
    RUp["POST /api/knowledge/upload"]
    RSync["POST /api/knowledge/sync"]
    RBV["GET POST PUT /api/brand-voice"]
  end
  subgraph SVC["server/knowledge and voice"]
    Ing["ingest.service.ts"]
    Rob["robots.ts"]
    Ext["extract.ts + office.ts"]
    Chk["chunk.ts"]
    Ret["retrieve.ts"]
    CovS["coverage.ts"]
    BVS["brand-voice.service.ts"]
  end
  Mat["lib/materials.ts"]
  BCW["business-context-write.service.ts"]
  BrandCtx["brand-context.service.ts"]
  Gen["Generators: content, outreach, engagement, planner"]
  DB[("PostgreSQL<br/>KnowledgeSource, KnowledgeChunk, Company")]
  Web{{"Company website + RSS"}}
  AI{{"AI provider - Anthropic or Gemini"}}

  Mgr --> RUp
  Mgr --> RSync
  Voice --> RBV
  RUp --> Ing
  RSync --> Ing
  Ing --> Rob
  Rob -->|"robots-gated GET"| Web
  Ing --> Ext
  Ing --> Chk
  Ing -->|"replaceChunks"| DB
  Cov -.-> CovS
  CovS --> DB
  CovS --> Mat
  Ret --> Mat
  Ret --> DB
  RBV --> BVS
  BVS --> Ret
  BVS --> AI
  BVS --> BCW
  BCW -->|"Company.brandVoiceProfile"| DB
  BrandCtx --> Ret
  Gen --> BrandCtx
  Gen --> BVS
```

Solid arrows are runtime calls. The dotted arrow from the coverage card means `page.tsx` calls `getMaterialCoverage` on the server and passes the result in as props. All three ingestion paths end in `replaceChunks`, and reads go only through `retrieve()`. The voice service never writes `Company` directly: it hands its patch to the Business Context write service, which enforces the rules on what AI may write.

## Main flow

Uploading a document, then using it in a generation:

```mermaid
sequenceDiagram
  participant UI as knowledge-manager
  participant API as /api/knowledge/upload
  participant ING as ingest.service
  participant EXT as extract or office
  participant DB as PostgreSQL
  participant GEN as Generator
  participant RET as retrieve.ts

  UI->>UI: pick file, default category from guessCategory
  UI->>API: POST multipart file + category
  API->>API: requireActiveCompany, extension and 4 MB checks
  API->>ING: ingestUpload with category or null
  ING->>EXT: pdfToText or officeToText or TextDecoder
  alt text shorter than 20 chars or parse error
    EXT-->>API: error status 422
    API-->>UI: 422 with actionable message
  else readable
    ING->>ING: chunkText up to 3200 chars
    ING->>DB: transaction - deleteMany then createMany chunks
    ING->>DB: audit KNOWLEDGE_DOCUMENT_UPLOADED
    API-->>UI: 200 filename, chunks, category
  end
  Note over GEN,RET: later, any AI workflow
  GEN->>RET: retrieve companyId, query, limit
  RET->>DB: newest 400 chunks
  RET-->>GEN: top chunks scored by overlap x weight x decay
  GEN->>GEN: chunksToContext groups excerpts under category labels
```

The top half runs once per upload. Extraction is chosen by file extension, and a file that yields no readable text is rejected with a 422 rather than stored. The bottom half runs whenever a generator needs grounding. The category picked at upload time sets both the score weight and the heading the model reads above each excerpt.

## Lifecycle / state machine

`KnowledgeSource.status` for website and blog sources (uploads have no source row):

```mermaid
stateDiagram-v2
  [*] --> SYNCING: first sync
  PENDING --> SYNCING: sync started
  SYNCING --> SYNCED: chunks replaced
  SYNCING --> ERROR: feed fetch failed
  SYNCED --> SYNCING: Sync website clicked
  ERROR --> SYNCING: Sync website clicked
  SYNCED --> [*]
```

`PENDING` is the schema default, but `upsertSource` always writes `SYNCING` straight away, so in practice a new source starts in `SYNCING`. Only the blog path sets `ERROR`. When a website yields no readable pages it still ends up `SYNCED`, with `error = "No readable pages found"`.

## Data model

```mermaid
erDiagram
  Company ||--o{ KnowledgeSource : "tracks"
  Company ||--o{ KnowledgeChunk : "owns"
  Company {
    string id PK
    string website
    string brandVoiceNotes
    json brandVoiceProfile
  }
  KnowledgeSource {
    string id PK
    string companyId FK
    enum type
    enum category
    string url
    string label
    enum status
    datetime lastSyncedAt
    string error
  }
  KnowledgeChunk {
    string id PK
    string companyId FK
    enum sourceType
    enum category
    string sourceUrl
    string title
    string content
    int tokenCount
    datetime createdAt
  }
```

`KnowledgeSource` and `KnowledgeChunk` have no foreign key to each other. They are matched logically on `(companyId, type/sourceType, url/sourceUrl)`, and for uploads `sourceUrl` holds the filename. Both tables cascade-delete with `Company`. The voice profile is a validated JSON column on `Company`, not a table of its own.

## Design decisions

- **Re-sync replaces chunks instead of appending.** Replacing all chunks for one source key in a single transaction means a re-sync or re-upload can never duplicate content.
- **Labels by kind as well as source.** `MaterialCategory` records what a document *is*, separately from where it came from. Brand guidelines need to be obeyed and competitor battlecards must never be echoed, so excerpts are grouped under a prompt label for their category.
- **Reference material does not decay.** Positioning, ICP, guidelines, pitch and company info are marked timeless and skip the 30-day half-life. Without this, old but binding rules would lose out to last week's post.
- **Category is guessed but always confirmed.** `guessCategory` only pre-fills the picker. A wrong silent guess, such as treating a deck as brand rules, would do more harm than asking.
- **Keyword retrieval, no embeddings.** It is cheap, deterministic and needs no extra service. The `retrieve()` interface is kept stable so vector search can replace it later.
- **Office files read without a dependency.** DOCX and PPTX are read with a minimal ZIP reader built on `node:zlib`. The extractor is chosen by extension because browsers mislabel Office MIME types.
- **Polite, read-only crawling.** Robots.txt is respected, requests are throttled by 1.2 s, and page JavaScript is never executed. Meta, OG and JSON-LD tags are read so JavaScript-rendered sites still yield brand copy.
- **AI drafts, a person confirms.** Voice writes go through `updateBusinessContext`. AI may only touch `voice.profile`, and a human save marks it confirmed.
- **One brand preamble.** `brand-context.service.ts` composes identity, audience, voice, writing rules and knowledge in a fixed order. Every workflow therefore gets the whole picture, not whichever fragment its author remembered.
