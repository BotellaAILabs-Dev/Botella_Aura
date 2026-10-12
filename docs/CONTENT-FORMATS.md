# Contextual content generation — formats

Content Studio writes from the accepted recommendation, its Content Brief
(`docs/CONTENT-BRIEF.md`) and the assembled generation context
(`docs/GENERATION-CONTEXT.md`). Each format is defined **once**, in
`lib/content-formats.ts`, and that definition is what the writer is given, what
the brief enforces, what the quality check holds the copy to, and what the
output is validated against.

## The formats

| Family               | Format (`type`)                           | Goes to                                           | Output                                                            |
| -------------------- | ----------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| Social post          | LinkedIn post (`LINKEDIN_POST`)           | LinkedIn, Facebook — Aura can publish             | hook · 3–5 paragraphs · cta · hashtags                            |
| Caption              | Single image post (`IMAGE_POST`)          | Instagram, Facebook, LinkedIn, X — with one image | caption · cta · hashtags · altText                                |
| Carousel             | Carousel (`CAROUSEL`)                     | LinkedIn, Instagram, Facebook                     | title · 5–8 slides · cta · hashtags                               |
| Thread               | X thread (`TWEET_THREAD`)                 | X                                                 | 2–12 tweets · 0–2 hashtags                                        |
| Article              | Blog draft (`BLOG`)                       | the business's own site (copied out)              | headline · subtitle · 2–10 sections · tags                        |
| Email                | Email (`EMAIL`)                           | the business's email tool (copied out)            | subjectLine · previewText · greeting · paragraphs · cta · signOff |
| Ad copy              | Ad copy (`AD`)                            | the ad platform (copied out)                      | headline · primaryText · description · cta                        |
| **Campaign copy**    | Campaign copy (`CAMPAIGN_COPY`) — **new** | the campaign's channels (copied out)              | tagline · keyMessage · shortCopy · longCopy · proofPoints · cta   |
| **Promotional copy** | Promotional copy (`PROMO`) — **new**      | site banner, newsletter, post (copied out)        | headline · offer · body · terms · urgency · cta                   |

The two new formats were added the same way Email and Ad were: enum values
(migration `20261012090000_content_campaign_promo`), zod schemas in
`lib/validations/content.ts`, copy-only (never published to a network), with
preview, copy-out text, list snippet, quality reading and Settings → Content
formats. Workspaces that never narrowed their formats get them automatically;
those that did can turn them on in Settings.

## What each format defines

| Part                                                                     | Where it is used                                                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prompt / template** — the structure, in order                          | the content playbook (with the network's style), so the writer gets it in "How this format works"                                            |
| **Required fields** — what the brief must carry for this format          | the Content Brief upgrades them to required; a missing one blocks generation with the format's reason                                        |
| **Channel constraints** — network or copied out, and the limits there    | the writer's "Where it goes"; the network list in the composer                                                                               |
| **Length** — per part, plus the overall ideal and hard limit per network | the writer's "Length"; the quality check                                                                                                     |
| **CTA behaviour** — required / optional / none, where it goes, how       | the writer's "Call to action" (with the destination, or "no link is known"); a missing required CTA **blocks** approval and is repaired once |
| **Brand voice application** — how the voice shows up in this format      | the writer's "Brand voice in this format", on top of the voice section                                                                       |
| **Output schema** — the JSON shape and what each field is                | the writer's output instruction; validated against the zod schema (one retry on a mismatch)                                                  |

### Required fields per format (beyond every brief's own)

| Format           | Needs                            | Why                                                          |
| ---------------- | -------------------------------- | ------------------------------------------------------------ |
| Email            | a CTA destination (website)      | the button has to send people somewhere                      |
| Ad copy          | target audience, CTA destination | an ad is shown to a chosen audience and needs a landing page |
| Campaign copy    | marketing goal, target audience  | campaign copy serves one goal and speaks to one audience     |
| Promotional copy | a CTA destination                | an offer needs a place to claim it                           |

For the other formats these fields stay recommended: the copy goes ahead and the
gap is stated.

### CTA

| Mode                                            | Formats                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| required                                        | social post, caption, carousel, email, ad, campaign copy, promotional copy |
| optional (required when the brief asks for one) | blog — closing line in the last section                                    |
| optional, inline                                | thread — in the last tweet; there is no separate field                     |

### Never invented

Promotional copy states the offer exactly as the business gives it — no
invented price, discount or product; `terms` and `urgency` stay empty unless
the business stated them (no false scarcity). Campaign copy's proof points come
only from the evidence or the business's own material.

## How a draft is written from a recommendation

1. The Content Brief is rebuilt for the chosen format and network and
   validated — including the format's required fields.
2. The generation context is assembled: current business snapshot, the
   recommendation, goal, **audience**, **brand voice**, channel rules, relevant
   material.
3. The writer's task names the audience and the channel ("…for home brewers, to
   run on LinkedIn"), then gives the format's definition, the context, and the
   output shape.
4. The copy is validated against the format's schema, checked (length, claims,
   CTA, voice's "never mention" list) and repaired once if something blocks.
5. The draft keeps its brief and the context trace.

**Brand voice** reaches every draft: the business's own stated voice when there
is one, else Aura's voice profile built from its content (labelled as such). The
snapshot alone treats an Aura-built profile as unconfirmed, so it is supplied
to the package explicitly.

## Checking it

```bash
pnpm test tests/format-specs.test.ts tests/generation-context.test.ts
pnpm verify:contextual-generation
# with the AI key loaded, one live draft too:
node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/verify-contextual-generation.ts
```
