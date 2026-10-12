# Content generation variations

Ask Aura for another version of a draft — without regenerating the whole thing
and without losing the one you have. Every variation is added **next to** the
current version, read on its own, and used only if you choose it.

- Rules (pure): `lib/content-variations.ts`
- Making one: `server/content/variations.service.ts`
- API: `POST /api/content/drafts/:id/variations { kind, tone?, platform? }`;
  choosing a version: `POST /api/content/drafts/:id/variation { index }`
- UI: the draft page's writing-assistant panel — **Make a variation** and the
  versions list

## Variations

| Variation            | What changes                                                                                                                                                                              | Available                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Shorter              | the whole piece, ~40% fewer words; hook, key message and CTA kept                                                                                                                         | every format                                                   |
| Longer               | the whole piece, more depth from the facts, evidence and context only                                                                                                                     | every format                                                   |
| Different tone       | the whole piece, in professional / friendly / playful / bold / warm / concise                                                                                                             | every format                                                   |
| Alternative CTA      | **only the `cta` field** — the rest kept byte for byte                                                                                                                                    | every format except a thread (its CTA is inside the last post) |
| Alternative headline | **only the headline field** (hook, title, headline, subject line, tagline)                                                                                                                | formats with one                                               |
| For another channel  | the piece shaped for another network the format runs on, with that network's rules; choosing it moves the draft there                                                                     | formats on more than one network                               |
| Another image        | a new picture from the same brief — the latest image's prompt (a sibling of it), else one written from the visual brief; generated through the graphics workflow (plan allowance applies) | formats that take an image                                     |

## Guardrail — the original stays the original

Every variation keeps the original recommendation's **goal, audience, key
message, evidence, call-to-action destination and brand** (voice, topics never
mentioned). The writer is given these as "keep exactly", together with the
facts in the current version — and told not to change, round or invent any
number, price, percentage, date, name, link or claim to make the version
different.

The result is then **checked**: any number, price, percentage, date, link,
email or handle that is in neither the original nor the brief/evidence is a
changed fact.

1. It is sent back once, naming the facts, to be corrected.
2. If it still changes a fact, the version is kept for review but **blocked
   from approval**, with the facts named ("This version changes facts from the
   original: $14.99").

A shorter version may drop a fact; it may not alter or invent one. Alternative
CTA and headline change one field in code, so nothing else can move.

## Reviewing versions

- Each version is stored with its kind, when it was made, what it was made
  from, its network (for channel variations), its own quality check and the
  facts check — shown as **Facts kept** or **Changes facts from the original**.
- **Read this version** shows it in full; **Use this version** switches to it
  (undoable). The version being left is saved as it reads, so a hand edit is
  never lost.
- Up to 8 versions are kept per draft; the oldest unused ones go first, never
  the one in use.
- The draft itself does not change until a version is chosen.

## When the writer is unavailable

A rate limit or outage at the AI provider returns a plain message — "Aura's
writer is at its limit right now … Nothing was changed — try again in a few
minutes." — instead of the provider's raw error (also applied to the existing
rewrite actions). An image variation that fails leaves the post untouched.

## Checking it

```bash
pnpm test tests/content-variations.test.ts
VERIFY_BASE_URL=http://localhost:3001 pnpm verify:variations
```
