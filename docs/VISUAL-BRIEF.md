# Visual / asset generation context

Recommendations that need a picture now carry what the image workflow needs to
make it: a **visual brief**, derived from the recommendation and part of the
Content Brief.

- Rules (pure, client-safe): `lib/visual-brief.ts`
- In the Content Brief: field `visual` (`lib/content-brief.ts`)
- For any draft: `server/media/visual-brief.service.ts` (`visualBriefForDraft`)
- Used by: the image prompt (`server/media/image-prompt.service.ts`), the
  generator's default shape (`server/media/generation.service.ts`), the draft
  page's **Visual brief** panel and Content Studio's brief panel

## When an image is required

From the format and the channel (the Content Brief's asset requirements):

| Format                 | Image                                                                   |
| ---------------------- | ----------------------------------------------------------------------- |
| Single image post, ad  | required — 1                                                            |
| Carousel               | required — 3–10                                                         |
| LinkedIn / social post | recommended (required where the network requires media, e.g. Instagram) |
| Email, blog            | recommended — a landscape header (16:9)                                 |
| Promotional copy       | recommended — 1 square image                                            |
| Thread, campaign copy  | none                                                                    |

The brief says why ("A single image post cannot go out without an image."), and
the draft page shows "Image required — none attached yet" until one is.

## What the visual brief carries

| Part                                                                         | From                                                                                                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Subject** — the idea the image carries                                     | the recommendation's key message (angle → opportunity angle → a concrete step)                                                |
| **Product** — the real thing to show                                         | the business's offerings, else what it does                                                                                   |
| **Audience**                                                                 | the brief's audience                                                                                                          |
| **Setting**                                                                  | consumer imagery (the thing and the moment of using it) or business imagery (the work and its outcome), from the market mode  |
| **Brand** — palette, mood, never-show, logo on file                          | brand colours (Settings), brand voice tone and topics to avoid; a logo is added by the business, never drawn                  |
| **Format** — ratio, width × height, other ratios, file limits, art direction | the channel chosen (Instagram 4:5 at 1024×1280, LinkedIn 1:1, email/blog 16:9 …), from the same size table the generator uses |
| **Rules**                                                                    | no text, logos, real people or other brands' marks; no offer, price or claim the brief does not state; one coherent image     |

## Missing visual information

Each gap is listed with what it means and where to fix it — nothing invented:

| Missing  | Requirement | Effect / fix                                                    |
| -------- | ----------- | --------------------------------------------------------------- |
| subject  | required    | nothing to picture — the brief needs a key message              |
| product  | recommended | the image shows the idea, not the product — _Add what you sell_ |
| audience | recommended | not aimed at anyone in particular — _Describe your audience_    |
| palette  | recommended | neutral palette instead of the brand's — _Add brand colours_    |
| mood     | recommended | mood follows the style only — _Set your brand voice_            |

Readiness: `ready`, `ready_with_gaps`, `blocked` (no subject) or `not_needed`.

## Passed to image generation

The art director (the model that writes the image prompt) receives the visual
brief as one structured block — idea, product, audience, setting, palette, mood,
never-show, shape and rules — plus the post and the style. If that model call
fails, the deterministic fallback prompt is built from the same brief (its
subject, product, palette and never-show), not from the post's first line.

Drafts written from a recommendation use the brief they kept; other drafts get
one built from the business context, the brand and the post. When the image is
for a different network than the brief named, the shape follows that network
and everything else stays.

The studio opens on the brief's shape, and a generation request without a shape
uses it.

## Failure and regeneration

- A failed image run ends with the provider's reason (and is retried
  automatically when the failure is temporary). The studio shows **Retry** and
  **Try another model**; its button is never left disabled.
- The post is never touched by an image failure and can be edited as normal.
- Regenerating starts a fresh run (or picks up the queued retry) with the same
  brief, and the new image is made in the brief's shape.
- If writing the image prompt fails, the fallback prompt is used — the user can
  still edit it and generate.

## Checking it

```bash
pnpm test tests/visual-brief.test.ts
VERIFY_BASE_URL=http://localhost:3001 pnpm verify:visual-context
```
