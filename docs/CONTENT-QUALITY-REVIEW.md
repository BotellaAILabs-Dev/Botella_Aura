# Content quality & brand safety — what changed

Written against the review feedback of sections 2–5 (image generation, text
generation, brand safety, publishing). This is the record of what was changed,
what was found, and what is still blocked.

---

## 4. Content generation and brand safety

> During the Market Trends demonstration, a source reportedly discussed people
> dying, but the generated LinkedIn copy promoted whiskey as bringing people
> together.

### What actually went wrong

Nothing in the pipeline malfunctioned. The chain was:

1. The trend digest asked Claude for **“a concrete suggested post angle/hook in
   their voice”** for *every* item it ranked — with no judgment about whether an
   item should be posted about at all.
2. That angle was stored on the digest item and shown on the card.
3. Content Studio pasted it into the writer's prompt verbatim as
   `Suggested angle: …`.
4. The writer did as it was told.
5. The reviewer passed it, because **the reviewer was never shown the source**.
   On its own terms the post was well written, on-voice, and compliant.

So there was no component to fix. What was missing was anyone asking whether
the story was marketing material — and that question was not being asked
anywhere in the system.

### What was added

A new module, `lib/brand-safety.ts`, with two deliberately separate checks:

| | |
|---|---|
| `classifySource(text)` | Reads the **source** and returns a posture: `clear`, `caution` or `unsuitable`. |
| `toneMismatch(safety, copy)` | Reads the **copy** against that posture and catches celebratory or sales language. |

It is **deterministic, not an AI judgment call**. A model asked “is this
sensitive?” agrees with whatever framing it is given, and this is precisely the
check that has to hold when the model is the thing that got it wrong.

`unsuitable` covers death, violence, armed conflict, suicide/overdose and
missing persons. `caution` covers disaster, injury, serious illness, job losses
and financial hardship, criminal proceedings and recalls, and discrimination or
harassment.

**The tone check only runs when the source is not clear.** On ordinary
material, “celebrate”, “raise a glass” and “don't miss” are exactly what a
marketing platform should produce, and flagging them would be a worse bug than
the one being fixed.

### Where it is enforced

Six places, because any single one of them can be the one that is bypassed:

1. **Trend digest** (`server/trends/digest.service.ts`) — every item is
   classified *before* a model sees it. An unsuitable item is never asked for a
   marketing angle; its `suggestedAngle` field carries the reason there is
   nothing to post. The deterministic verdict and the model's own
   `suitableForPromotion` judgment are combined by taking the **stricter** of
   the two: the patterns cannot read a story that is grim without grim words,
   and a cooperative model will talk itself past one that has them.
2. **Digest recommendations** — an unsuitable item cannot become a
   “post about this” recommendation, including in the no-API-key fallback. A
   recommendation that names an excluded headline is dropped even if the model
   ignored the instruction.
3. **Generation refusal** (`server/content/generator.ts`) — a grave source plus
   a format that exists to sell (`PROMO`, `AD`, `CAMPAIGN_COPY`) is refused with
   a 422 and an explanation. There is no respectful way to write an advert off a
   fatality. An ordinary post is still allowed, because someone may legitimately
   want to write honestly about a hard subject — and is then held to the rules.
4. **The writer's prompt** — the rules are stated as instructions
   (“do not use it as a reason, hook or occasion to promote anything”), not as
   cautions. “Be careful” is not something a model can act on.
5. **The deterministic check** (`lib/content-quality.ts`) — promotional language
   on an unsafe source is a **blocking** issue, so the draft cannot be approved.
   The automatic repair pass is given the safety rules too, so it rewrites
   rather than re-offending.
6. **The reviewer** (`lib/content-review.ts`) — a new `brand_safety` dimension,
   weighted with compliance and marked critical. **The reviewer is now shown the
   source material**, with the warning placed *before* it. It was previously
   judging fidelity to a source it had never seen.

The verdict and the source material are stored on the draft, so a rewrite, a
variation and the reviewer are all held to the same reading of the source — and
“why was this blocked” has an answer later.

### Visible in the product

Trend cards now carry a **Not for promotion** or **Handle with care** badge with
the reason, and the call to action changes from “Generate content from this” to
“Write about this anyway”.

---

## 3. Content Studio — text generation

> The team identified that some text-generation functionality was based on an
> older implementation and required updating.

**Found it.** The trend digest enrichment was the last generation path still on
`completeJson<T>` — unvalidated, unschema'd. A reply with the wrong shape
silently became “no enrichment”, so a prompt that had quietly stopped working
looked identical to a deliberate fallback. Both digest calls are now
`completeStructured` with Zod schemas, like the rest of the pipeline.

> Generated copy must match the original prompt, draft, trend, or source
> material.

Added a `STAY ON THE SOURCE MATERIAL` block to the writer's prompt. This sounds
too obvious to need saying, and it was not being said: a model handed a business
context, a brand voice, a format spec and a one-line brief reliably produces an
excellent post about the **business**, because that is where nearly all the
material is — and quietly drops the specific trend that prompted it. The copy
reads well, passes every other check, and is not what was asked for.

The full source material is now also stored on the draft and passed to the
reviewer, so `relevance` and `accuracy` are judged against the source rather
than against the business details alone.

> Alternative versions must remain relevant to the original topic.

Variations already checked that no **fact** was changed. They did not check that
the version was still about the same **subject** — a version that invents
nothing, reads well and is simply about something else passed cleanly.

Added `topicOverlap` / `TOPIC_DRIFT_FLOOR` (`lib/content-variations.ts`) and a
blocking `topic-drift` issue.

One design note worth recording: the obvious metric — *how much of the
original's subject matter survived* — is wrong, and wrong in the direction that
hurts. “Make it 40% shorter” is a legitimate variation whose entire job is to
drop material; a correctly shortened post scores ~0.24 that way and would be
blocked as off-topic, which is a false accusation about the user's own request.
The implemented metric takes the better of both directions, so shortening and
expanding both pass and only a genuine change of subject fails.

---

## 2. Content Studio — image generation

> Images without people generally look realistic… Images featuring people still
> tend to look AI-generated.

### A confirmed bug, not a tuning problem

`PHOTO_NEGATIVE` was built as `mergeNegative(NO_TEXT_NEGATIVE, AI_LOOK_NEGATIVE)`
and capped at 400 characters (`NEGATIVE_MAX`). The no-text list is long enough
that **the last eight terms of the second list never fitted**:

```
perfect symmetry · generic stock photo · posed stock smiles · distorted hands
extra fingers · deformed faces · warped products · blurry subject
```

Those are, almost exactly, the failures being reported. Every photograph the
platform has ever generated went out with no defence against them, while the
code read as though it had them. Nothing errored — the terms were dropped on the
floor by a budget check, in silence. An existing test asserted the broken
ordering and passed throughout.

The cap could not simply be raised: a stored negative prompt is replayed through
a 400-character request schema by “Another image”, so a longer one would break
that round trip.

**Fix:** `photoNegativeFor(kind)` orders the terms by what matters for the shot
being taken. A few text terms that carry most of the text rule come first, then
the shot's own failure modes, then the rest as filler. A shot with people keeps
its hands, faces and skin terms; a product shot keeps `warped products` and
`impossible reflections`.

### Positive direction

Added `PEOPLE_REALISM` — the specific tells of a generated person (symmetrical
faces, pore-less skin, held smiles, hands) and the imperfections a real
photograph always has. The art-director model gets the full brief; prompts
composed directly get `PEOPLE_REALISM_SHORT`, because an image prompt has a hard
1,500-character limit and every clause displaces something else that matters.

Applied only where there are people in frame — it is wasted on a product shot.

Also fixed while here: the marketing-creative prompt's length budget did not
count the people brief, so an `event` creative overshot 1,500 by three
characters and silently lost its quality line instead.

> Users should be able to edit image versions, choose post types, customize logo
> colors, and optionally add brand logos.

Three of these already shipped — image versions with refine/regenerate history,
post types (`IMAGE_POST` for a single image), and brand logo placement with four
corner positions and three modes.

**Logo colours are new.** `LOGO_TINTS` — original, white, black, or the
workspace's brand colour — in the studio's Logo control and on the per-image
logo action. The mark's **shape and transparency are the uploaded file's**; only
its ink changes, which is what a brand guideline means by a one-colour or
reversed logo. A dark logo on a dark photograph is invisible, and this is the
standard answer to that. The image model is still never asked to draw or
recolour a logo.

If `brand` is chosen and the workspace has no usable primary colour, the logo
keeps its own colours and that is recorded — rather than being recoloured to a
guess.

---

## 5. Social media integrations and publishing

> Compare Content Studio and WhatsApp output using the same prompts and content.
> Ensure that the required prompt-processing pipelines are connected across the
> relevant channels.

**Checked: they are already the same pipeline.** `server/whatsapp/tools/content.ts`
calls the same `generateDraft()` and `generateImagePrompt()` as Content Studio.
There is no second, older writer behind WhatsApp.

The differences are in what each one *asks for*, not how it writes:

| | Content Studio | WhatsApp |
|---|---|---|
| Variations | 1–3, user's choice | always 1 |
| Tone | user-selectable | not passed |
| Platform | user-selectable | inferred from the requested type |
| Brief | a form, often with a recommendation and a validated Content Brief behind it | one line of chat |

So output quality differences trace to the **brief**, which is expected: a
one-line WhatsApp message carries far less than a Content Brief. All the
brand-safety and source-fidelity work above applies to both channels
automatically, because both go through `generateDraft`.

### Still blocked — needs credentials, not code

The publishers exist (`server/media/publishers/`: `facebook.ts`,
`instagram.ts`, `linkedin-image.ts`) and the capability map in
`lib/capabilities.ts` declares the scopes each path needs. What is missing is
authorisation:

- **Facebook Page publishing** — `pages_show_list`, `pages_read_engagement`,
  `pages_manage_posts`
- **Instagram publishing** — the above plus `instagram_basic`,
  `instagram_content_publish`, and an Instagram **Business** account linked to
  the Page

To validate publishing against the Sippin Bourbon Meta Business account, the
following are needed and cannot be supplied from the codebase:

1. The Meta app added as an app on that Business account, with the Aura
   connector's redirect URI registered.
2. A user with an admin role on the Page completing the connection flow.
3. For Instagram: the Business account linked to that Page.
4. App Review for the scopes above, if the app is not in development mode with
   those users added as testers.

Until then the publish path cannot be verified end to end, and this is the one
item in the feedback that no amount of code will close.

---

## Verification

- `pnpm typecheck` — clean
- `pnpm test` — **2104 passing** (up from 2041; 63 new)
- New: `tests/brand-safety.test.ts` (44), `tests/logo-overlay.test.ts` (9),
  plus additions to `tests/content-variations.test.ts`,
  `tests/photo-realism.test.ts` and `tests/content-review.test.ts`

Two notes on the tests, both deliberate:

**One existing test was rewritten, not just extended.**
`tests/photo-realism.test.ts` asserted the old negative-prompt ordering
(“puts text first, then the tells of generated images”) and checked for
`name badges`. That test passed for the entire period during which the terms
that actually mattered were being dropped. `name badges` is now what gets
dropped instead — a correct trade, and the one the old test prevented anyone
from making.

**The brand-safety tests spend more lines on false positives than on real
cases.** Fourteen of them assert that ordinary marketing English is *not*
flagged — “killer feature”, “dead simple”, “price war”, “we crushed it”,
“flooded with orders”, “to die for”, “pain points”, “bleeding edge”. A
brand-safety check that cries wolf on those gets switched off within a week,
and then protects nothing at all.
