# Marketing creatives

Content Studio produces complete, branded marketing creatives: a
photorealistic photograph, the campaign's words in professional typography,
and the business's colours and logo, exported as one ready-to-post image. The
**Marketing creative** panel is on every draft page.

## How a creative is made

1. **The words** (`writeCopy` in `server/media/creative/creative.service.ts`):
   - Anything the person types (headline, date, venue, offer, call to action…)
     is used exactly as typed.
   - Aura writes the rest from the post and the business details: headline,
     supporting line, kicker and call to action.
   - Aura **never invents** a detail:
     - a date, time, venue, offer or event name is used only if the person
       gave it, in the fields or in their request (`detailBacked`);
     - a headline or supporting line may only contain figures found in the
       sources (`figuresBacked`);
     - anything else is left out, and the screen says so.
   - Each word is labelled with where it came from: you, your request, your
     post, your business details, or written by Aura.
2. **The photograph** (`lib/creative/photo-prompt.ts`):
   - Made by the existing image providers through the existing pipeline
     (`generateGraphics`, new **Photorealistic** style), so storage, plan
     limits and audit apply as before.
   - Briefed as commercial photography: the right scene for the creative type
     and industry, the lens, the light, realistic materials.
   - Keeps calm space where the layout puts the text.
   - **No text, logos or illustration in the image**, with a strong negative
     prompt.
3. **The design** (`server/media/creative/render.ts`):
   - Composed with **satori** (layout) and **resvg** (rasterising). Text is set
     in bundled OFL fonts, never drawn by the image model.
   - Every line is measured against the fonts' real character widths
     (`lib/creative/text-fit.ts`, `assets/fonts/metrics.json`), broken, and
     drawn unwrapped. The headline is sized to its box: no cropping, no
     overlap.
   - Text that cannot fit is refused with a reason instead of being cut off.
   - Colours are checked for contrast: text sits on dark overlays or panels,
     and a light brand colour is deepened until white text reads clearly
     (WCAG 4.5:1).
4. **Stored** as an ordinary image on the draft (`GeneratedAsset`,
   `metadata.kind = "creative"`, with its full design spec). Attaching it,
   the review screen, approval and the extension work unchanged. **Nothing is
   published without approval.**

## Designs

**Ten creative types:**

- event
- product launch
- promotional ad
- special offer
- festival or holiday greeting
- business announcement
- educational post
- brand awareness
- restaurant or retail promotion
- B2B post

Aura reads the type from the request and the post, or the person picks one.

**Six layouts**, each adapting to every format:

| Layout    | Looks like                                                      |
| --------- | --------------------------------------------------------------- |
| Hero      | Full-bleed photo, deep gradient, large headline low on the page |
| Split     | Photo and a brand-colour panel (side by side in landscape)      |
| Frame     | Photo with a centred white card                                 |
| Offer     | Photo with a bold offer badge, used only when there is an offer |
| Editorial | Magazine style: headline above a framed photo                   |
| Spotlight | Dark veil, fine rules, centred elegant type                     |

Each type has its own preferred layouts, so different creatives do not all
look the same.

**Four typography pairings**, chosen from the brand's tone:

| Pairing | Fonts            |
| ------- | ---------------- |
| Modern  | Montserrat       |
| Impact  | Bebas Neue       |
| Elegant | Playfair Display |
| Clean   | Inter            |

Body text is always Inter.

**Formats:**

| Format                                   | Size      |
| ---------------------------------------- | --------- |
| Square (Instagram / Facebook / LinkedIn) | 1080×1080 |
| Instagram portrait                       | 1080×1350 |
| Story / Reel                             | 1080×1920 |
| Landscape (LinkedIn / Facebook / X)      | 1920×1080 |

## The brand

From the Business Context:

- company name, industry, description and offerings;
- brand colours and **logo** (PNG or JPEG), shown on a light pill so it reads
  on any background;
- tone of voice (which sets the typography);
- audience and whether the business is B2B or B2C (which sets the photo's
  scene).

Without a logo, the business name is set as a wordmark. Without colours,
Aura uses a dependable navy and gold.

## Customising

The person can set:

- creative type, layout, typography and format;
- headline, supporting line, event name and kicker;
- date, time, venue, offer, call to action and website;
- brand and accent colours, and whether to show the logo;
- the photograph: a new AI photo (with an optional direction and light), one
  of their images, or the brand background.

| Action                   | What happens                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **Generate creative**    | Background job: words, then photo, then layout.                                                                                   |
| **Update text & design** | Re-sets the words, layout, format or colours **on the same photo** in a second or two. No AI, no image generation, no plan usage. |
| **New photo, keep text** | A new photograph with the current words.                                                                                          |
| **Use on this post**     | Attaches the creative to the post.                                                                                                |
| **Download**             | Saves the PNG.                                                                                                                    |

## When no photograph can be made

If no image provider is configured, the provider is at its quota, or it
fails, the creative is still delivered on a designed **brand-colour
background**. It is labelled in the studio as _"Brand background — no AI
photo was made (reason)"_ and recorded as such. It is never presented as an
AI photograph.

## Plan usage

A new photograph counts as one generated image. Composing or re-setting a
creative does not: `assetsThisMonth` excludes creatives.

## Deployment

- `satori` and `@resvg/resvg-js` (prebuilt binaries for Windows and Linux,
  including Vercel) are dependencies. resvg is kept outside the webpack bundle
  (`serverComponentsExternalPackages`).
- The fonts in `assets/fonts` are bundled with the server functions
  (`outputFileTracingIncludes`).
- No new API keys or paid services are needed.

## Checking it

```bash
pnpm test tests/creative.test.ts
VERIFY_BASE_URL=http://localhost:3001 pnpm verify:creative
```
