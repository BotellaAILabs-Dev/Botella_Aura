# Context assembly for content generation

What the generation model receives when Content Studio writes a first draft —
a context package assembled per draft, so Aura writes from what is true about
**this** business for **this** piece, not from a generic prompt.

- Rules (pure): `lib/generation-context.ts`
- Gathering (server): `server/content/generation-context.service.ts`
- Used by: `generateDraft` in `server/content/generator.ts`

## What goes in

| Section                           | From                                                                                                                                       | Required             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| The brief                         | the person's brief text (secrets removed, their words kept)                                                                                | yes                  |
| The business                      | the **current Business Context Snapshot** (content view): what it does and sells, website, and the product highlights that match the topic | yes                  |
| How this format works             | the format's and network's playbook                                                                                                        | yes                  |
| Written for Aura's recommendation | the Content Brief: key message, why now, expected outcome, evidence to cite (and only that), CTA, length, gaps not to invent               | when written for one |
| The opportunity behind it         | its title, type and summary                                                                                                                | when written for one |
| Marketing goal                    | the brief's goal, else the snapshot's; the campaign the piece is for (always), and running campaigns whose themes match                    | —                    |
| Audience                          | the brief's audience, else the snapshot's                                                                                                  | —                    |
| Brand voice                       | the snapshot's voice: summary, tone, words to avoid, vocabulary, emoji/hashtag habits                                                      | —                    |
| What has worked                   | learned patterns that bear on this piece (topic, format or channel)                                                                        | —                    |
| Reference page                    | a page the person linked in the brief, fetched live                                                                                        | —                    |
| The business's own material       | knowledge passages that match the topic                                                                                                    | —                    |
| Earlier posts on this topic       | approved or published posts from the last 120 days sharing at least two topic words — "do not repeat; stay consistent"                     | —                    |
| Recently published topics         | from the snapshot                                                                                                                          | —                    |
| Not confirmed                     | the snapshot's assumptions, marked as background only                                                                                      | —                    |

## Current, not stale

The business context comes from `getContextSnapshot(companyId, { view: 'content' })`,
which checks the snapshot's source stamp on every read and rebuilds it when
anything it is built from has changed (or it is older than its TTL). A change
to the business is therefore used on the very next draft. The recommendation,
brief, opportunity, knowledge and earlier posts are read live.

## Removed as irrelevant (and recorded)

- knowledge passages that do not match the topic — including ones retrieval
  matched only by part of a word ("not" in "notes") or by one chance word: a
  passage must share at least two whole topic words with the piece
- learned patterns about other topics, formats or channels
- running campaigns the piece is not for
- earlier posts on other topics
- competitors and market data (the content view leaves them out)
- performance numbers

Every removal is listed in the package's `dropped` with its reason.

## Sensitive or unnecessary data — never passed

- **Always removed**, everywhere (even the person's brief): API keys and tokens
  (Anthropic, Google, GitHub, Slack, AWS, JWTs, bearer tokens), passwords and
  secrets written as `key=value`, database connection strings, secret URL
  parameters (`token=`, `key=`, `sig=`…), valid card numbers (Luhn-checked),
  internal record ids.
- **Removed from documents, fetched pages and earlier posts**: email addresses
  not on the business's own domain, and phone numbers. The business's own
  address (e.g. hello@its-domain) is kept. Years, prices and ranges are not
  mistaken for phone numbers.
- **Never read**: leads, contacts, connections, credentials, performance data.
- The same redaction applies to the material Aura reads when it builds the
  brand voice profile, and when a draft is revised.

Counts per kind are recorded in `redactions`.

## Size

Rough token estimate: characters ÷ 4. The package has a budget
(`CONTEXT_TOKEN_BUDGET` = 3,200 tokens; the task wording and output shape are
extra) and every section a cap (`SECTION_SPECS`).

1. Required sections (brief, business, format) are trimmed to their cap —
   never dropped.
2. Optional sections are added in priority order (recommendation → opportunity
   → goal → audience → voice → memory → reference → knowledge → earlier posts →
   recent topics → assumptions), each trimmed to its cap and to what is left.
3. When fewer than 60 tokens remain, the rest are dropped with
   "Over the context budget."

Trimming cuts at a line or sentence boundary and marks the cut with "…".

## Traceable

Each draft keeps `aiMetadata.context` — the package's **trace and shape, not
its text**:

- `trace`: recommendation id, opportunity id, Content Brief version, snapshot
  fingerprint / revision / generatedAt / whether it was rebuilt, campaign id,
  the ids of the knowledge passages and earlier posts used, reference URLs
- `sections`: key, source, tokens, whether trimmed
- `dropped`, `redactions`, `budget`

`contextRevision` and `knowledgeChunkIds` on the draft now come from the
package, so revisions re-read only the material that was relevant (and redact
it the same way).

## Checking it

```bash
pnpm test tests/generation-context.test.ts
VERIFY_BASE_URL=http://localhost:3001 pnpm verify:generation-context
# include a live draft through the app:
VERIFY_BASE_URL=http://localhost:3001 node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/verify-generation-context.ts
```
