import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

import {
  CREATIVE_FORMATS,
  contrast,
  deepen,
  INK,
  luminance,
  mix,
  PAPER,
  textOn,
  type CreativeSpec,
} from '@/lib/creative/spec';
import {
  fitText,
  measure,
  type Fitted,
  type FontMetrics,
} from '@/lib/creative/text-fit';
import { BODY, DISPLAY, loadFonts } from '@/server/media/creative/fonts';

/**
 * Composes a marketing creative: the photograph, the brand's colours and logo,
 * and the copy set in real typography — then exports one PNG.
 *
 * Text is never drawn by the image model. Every line is measured against the
 * font's own metrics (lib/creative/text-fit.ts), broken here and drawn
 * unwrapped, so the headline is sized to its box: no cropping, no overlap.
 * satori lays the page out; resvg rasterises it.
 */

export class CreativeFitError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'CreativeFitError';
  }
}

export interface RenderImage {
  /** data: URL. */
  src: string;
  width: number;
  height: number;
}

export interface RenderResult {
  png: Buffer;
  width: number;
  height: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// A minimal element builder (satori takes React-element-shaped objects)
// ---------------------------------------------------------------------------

type Style = Record<string, string | number>;
interface El {
  type: string;
  props: {
    style?: Style;
    children?: El | string | (El | string)[];
    [k: string]: unknown;
  };
}
const div = (
  style: Style,
  ...children: (El | string | null | false)[]
): El => ({
  type: 'div',
  props: {
    style: { display: 'flex', ...style },
    children: children.filter(Boolean) as (El | string)[],
  },
});
const img = (src: string, style: Style): El => ({
  type: 'img',
  props: {
    src,
    style,
    width: Number(style.width),
    height: Number(style.height),
  },
});

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface Ctx {
  W: number;
  H: number;
  /** One unit: 1% of the short side. */
  u: number;
  P: number;
  landscape: boolean;
  tall: boolean;
  spec: CreativeSpec;
  metrics: FontMetrics;
  photo: RenderImage | null;
  logo: RenderImage | null;
  warnings: string[];
}

interface Block {
  el: El;
  height: number;
}

const display = (c: Ctx) => DISPLAY[c.spec.fontPair];
const up = (c: Ctx, s: string) => (display(c).upper ? s.toUpperCase() : s);

function lines(f: Fitted, style: Style): El {
  return div(
    { flexDirection: 'column', ...style },
    ...f.lines.map((l) => div({ whiteSpace: 'nowrap' }, l)),
  );
}

/** Fit body text, or drop it (with a warning) when it cannot fit — never crop. */
function bodyBlock(
  c: Ctx,
  text: string | null,
  o: {
    width: number;
    size: number;
    maxLines: number;
    weight?: 400 | 600 | 800;
    color: string;
    label?: string;
    upper?: boolean;
    tracking?: number;
    align?: string;
  },
): Block | null {
  if (!text) return null;
  const t = o.upper ? text.toUpperCase() : text;
  const files =
    o.weight === 800
      ? BODY.bold
      : o.weight === 600
        ? BODY.semibold
        : BODY.regular;
  const f = fitText(c.metrics, t, {
    fonts: files,
    maxWidth: o.width,
    maxHeight: o.size * 1.3 * o.maxLines,
    maxSize: o.size,
    minSize: Math.round(o.size * 0.75),
    lineHeight: 1.3,
    maxLines: o.maxLines,
    letterSpacing: o.tracking ?? 0,
  });
  if (!f) {
    c.warnings.push(
      `${o.label ?? 'Some text'} was too long for this format and was left out.`,
    );
    return null;
  }
  return {
    el: lines(f, {
      fontFamily: BODY.family,
      fontWeight: o.weight ?? 400,
      fontSize: f.size,
      lineHeight: 1.3,
      color: o.color,
      letterSpacing: `${(o.tracking ?? 0) * f.size}px`,
      alignItems: o.align === 'center' ? 'center' : 'flex-start',
    }),
    height: f.height,
  };
}

function headlineBlock(
  c: Ctx,
  width: number,
  maxHeight: number,
  o: { color: string; maxSize: number; align?: string },
): Block {
  const d = display(c);
  const text = up(c, c.spec.text.headline);
  const f = fitText(c.metrics, text, {
    fonts: d.files,
    maxWidth: width,
    maxHeight,
    maxSize: o.maxSize,
    minSize: Math.round(4.2 * c.u),
    lineHeight: d.lineHeight,
    maxLines: c.tall ? 5 : 4,
    letterSpacing: d.tracking,
  });
  if (!f) {
    const room = Math.max(12, Math.floor((width / (4.2 * c.u * 0.6)) * 3));
    throw new CreativeFitError(
      `The headline is too long for this format. Shorten it to about ${room} characters, or pick a taller format.`,
    );
  }
  return {
    el: lines(f, {
      fontFamily: d.family,
      fontWeight: d.weight,
      fontSize: f.size,
      lineHeight: d.lineHeight,
      letterSpacing: `${d.tracking * f.size}px`,
      color: o.color,
      alignItems: o.align === 'center' ? 'center' : 'flex-start',
    }),
    height: f.height,
  };
}

function ctaBlock(
  c: Ctx,
  o: { bg: string; fg: string; outline?: boolean; width: number },
): Block | null {
  const text = c.spec.text.cta;
  if (!text) return null;
  const size = Math.round(2.6 * c.u);
  const label = text.toUpperCase();
  const padX = 3.2 * c.u;
  const w = measure(c.metrics, BODY.bold, label, size, 0.06) + padX * 2;
  if (w > o.width) {
    c.warnings.push(
      'The call to action was too long for a button and was left out.',
    );
    return null;
  }
  const h = size * 1.2 + 3 * c.u;
  return {
    el: div(
      {
        alignItems: 'center',
        justifyContent: 'center',
        height: h,
        padding: `0 ${padX}px`,
        borderRadius: 0.9 * c.u,
        backgroundColor: o.outline ? 'transparent' : o.bg,
        border: o.outline
          ? `${Math.max(2, 0.3 * c.u)}px solid ${o.bg}`
          : 'none',
        color: o.outline ? o.bg : o.fg,
        fontFamily: BODY.family,
        fontWeight: 800,
        fontSize: size,
        letterSpacing: `${0.06 * size}px`,
        whiteSpace: 'nowrap',
      },
      label,
    ),
    height: h,
  };
}

/** Date, time and venue — exactly as given. */
function detailsBlock(
  c: Ctx,
  width: number,
  color: string,
  accent: string,
  align?: string,
): Block | null {
  const t = c.spec.text;
  const when = [t.date, t.time].filter(Boolean).join('  ·  ');
  const parts = [when || null, t.venue].filter(Boolean) as string[];
  if (!parts.length) return null;
  const blocks = parts
    .map((p, i) =>
      bodyBlock(c, p, {
        width: width - 2.2 * c.u,
        size: Math.round(3 * c.u),
        maxLines: i === 0 ? 1 : 2,
        weight: 600,
        color,
        label: i === 0 ? 'The date and time' : 'The venue',
      }),
    )
    .filter(Boolean) as Block[];
  if (!blocks.length) return null;
  const gap = 0.8 * c.u;
  const height =
    blocks.reduce((n, b) => n + b.height, 0) + gap * (blocks.length - 1);
  return {
    el: div(
      {
        flexDirection: 'row',
        alignItems: 'stretch',
        justifyContent: align === 'center' ? 'center' : 'flex-start',
      },
      align === 'center'
        ? null
        : div({
            width: 0.6 * c.u,
            backgroundColor: accent,
            borderRadius: 0.3 * c.u,
            marginRight: 1.6 * c.u,
          }),
      div(
        {
          flexDirection: 'column',
          gap,
          alignItems: align === 'center' ? 'center' : 'flex-start',
        },
        ...blocks.map((b) => b.el),
      ),
    ),
    height,
  };
}

/** The logo on a pill (so it reads on any background), or the brand name. */
function brandBlock(
  c: Ctx,
  o: { onDark: boolean; color: string; maxWidth: number },
): Block {
  const b = c.spec.brand;
  if (c.logo && b.showLogo) {
    const h = (c.landscape ? 7.5 : 7) * c.u;
    let w = (c.logo.width / c.logo.height) * h;
    let hh = h;
    if (w > o.maxWidth * 0.6) {
      w = o.maxWidth * 0.6;
      hh = (c.logo.height / c.logo.width) * w;
    }
    const pad = 1.1 * c.u;
    return {
      el: div(
        {
          padding: pad,
          borderRadius: 1.2 * c.u,
          backgroundColor: o.onDark ? 'rgba(255,255,255,0.94)' : 'transparent',
        },
        img(c.logo.src, {
          width: Math.round(w),
          height: Math.round(hh),
          objectFit: 'contain',
        }),
      ),
      height: hh + pad * 2,
    };
  }
  const size = Math.round(2.6 * c.u);
  const name = b.name.toUpperCase();
  const f = fitText(c.metrics, name, {
    fonts: BODY.bold,
    maxWidth: o.maxWidth,
    maxHeight: size * 1.2,
    maxSize: size,
    minSize: Math.round(size * 0.7),
    lineHeight: 1.2,
    maxLines: 1,
    letterSpacing: 0.14,
  });
  if (!f) return { el: div({}), height: 0 };
  return {
    el: lines(f, {
      fontFamily: BODY.family,
      fontWeight: 800,
      fontSize: f.size,
      letterSpacing: `${0.14 * f.size}px`,
      color: o.color,
    }),
    height: f.height,
  };
}

function eyebrowBlock(
  c: Ctx,
  width: number,
  color: string,
  align?: string,
): Block | null {
  // The business name is already set as the wordmark when there is no logo.
  const eyebrow = c.spec.text.eyebrow;
  const shownAsWordmark = !(c.logo && c.spec.brand.showLogo);
  if (
    eyebrow &&
    shownAsWordmark &&
    eyebrow.trim().toLowerCase() === c.spec.brand.name.trim().toLowerCase()
  )
    return null;
  return bodyBlock(c, eyebrow, {
    width,
    size: Math.round(2.3 * c.u),
    maxLines: 1,
    weight: 800,
    color,
    upper: true,
    tracking: 0.16,
    label: 'The eyebrow line',
    align,
  });
}

/** Stack blocks with gaps; the headline gets whatever height is left. */
function column(
  c: Ctx,
  o: {
    width: number;
    height: number;
    align?: string;
    headlineColor: string;
    headlineMax: number;
    gap: number;
  },
  before: (Block | null)[],
  after: (Block | null)[],
): El {
  const b = before.filter(Boolean) as Block[];
  const a = after.filter(Boolean) as Block[];
  const fixed =
    [...b, ...a].reduce((n, x) => n + x.height, 0) +
    o.gap * (b.length + a.length);
  const headline = headlineBlock(
    c,
    o.width,
    Math.max(6 * c.u, o.height - fixed),
    {
      color: o.headlineColor,
      maxSize: o.headlineMax,
      align: o.align,
    },
  );
  return div(
    {
      flexDirection: 'column',
      width: o.width,
      gap: o.gap,
      alignItems: o.align === 'center' ? 'center' : 'flex-start',
    },
    ...b.map((x) => x.el),
    headline.el,
    ...a.map((x) => x.el),
  );
}

function background(c: Ctx, w: number, h: number, extra: Style = {}): El {
  const pal = c.spec.brand.colors;
  if (c.photo) {
    return img(c.photo.src, {
      position: 'absolute',
      left: 0,
      top: 0,
      width: w,
      height: h,
      objectFit: 'cover',
      ...extra,
    });
  }
  // No photograph: a considered brand-colour field, not a fake photo.
  return div(
    {
      position: 'absolute',
      left: 0,
      top: 0,
      width: w,
      height: h,
      backgroundImage: `linear-gradient(135deg, ${pal.primary} 0%, ${mix(pal.primary, pal.secondary, 0.6)} 60%, ${pal.secondary} 100%)`,
      overflow: 'hidden',
      ...extra,
    },
    div({
      position: 'absolute',
      width: Math.max(w, h) * 0.9,
      height: Math.max(w, h) * 0.9,
      borderRadius: Math.max(w, h),
      right: -Math.max(w, h) * 0.35,
      top: -Math.max(w, h) * 0.3,
      backgroundColor: 'rgba(255,255,255,0.06)',
    }),
    div({
      position: 'absolute',
      width: Math.max(w, h) * 0.5,
      height: Math.max(w, h) * 0.5,
      borderRadius: Math.max(w, h),
      left: -Math.max(w, h) * 0.18,
      bottom: -Math.max(w, h) * 0.2,
      backgroundColor: rgba(pal.accent, 0.12),
    }),
  );
}

// ---------------------------------------------------------------------------
// The layouts
// ---------------------------------------------------------------------------

/** Full-bleed photo, a deep gradient, the headline low and large. */
function hero(c: Ctx): El {
  const { W, H, P, u } = c;
  const pal = c.spec.brand.colors;
  const dark = mix(pal.primary, '#000000', 0.72);
  const eyebrowColor = contrast(pal.accent, dark) >= 3 ? pal.accent : PAPER;
  const width = c.landscape ? W * 0.52 : W - P * 2;
  const top = c.landscape ? P : H * (c.tall ? 0.46 : 0.4);
  const brand = brandBlock(c, { onDark: true, color: PAPER, maxWidth: width });
  const height = H - P - (c.landscape ? P + brand.height + 3 * u : top);
  const cta = ctaBlock(c, { bg: pal.accent, fg: textOn(pal.accent), width });
  return div(
    { width: W, height: H, position: 'relative', backgroundColor: dark },
    background(c, W, H),
    div({
      position: 'absolute',
      left: 0,
      top: 0,
      width: W,
      height: H,
      backgroundImage: c.landscape
        ? `linear-gradient(90deg, ${rgba(dark, 0.94)} 0%, ${rgba(dark, 0.82)} 42%, ${rgba(dark, 0)} 78%)`
        : `linear-gradient(180deg, ${rgba(dark, 0.35)} 0%, ${rgba(dark, 0)} 16%, ${rgba(dark, 0.05)} ${c.tall ? 30 : 24}%, ${rgba(dark, 0.72)} ${c.tall ? 46 : 42}%, ${rgba(dark, 0.95)} 100%)`,
    }),
    div({ position: 'absolute', left: P, top: P }, brand.el),
    div(
      {
        position: 'absolute',
        left: P,
        bottom: P,
        height,
        flexDirection: 'column',
        justifyContent: 'flex-end',
      },
      column(
        c,
        {
          width,
          height,
          headlineColor: PAPER,
          headlineMax: Math.round((c.landscape ? 9 : c.tall ? 12.5 : 10.5) * u),
          gap: 2.2 * u,
        },
        [eyebrowBlock(c, width, eyebrowColor)],
        [
          bodyBlock(c, c.spec.text.subheadline, {
            width,
            size: Math.round(3.4 * u),
            maxLines: 3,
            color: rgba('#FFFFFF', 0.92),
            label: 'The supporting line',
          }),
          detailsBlock(c, width, PAPER, pal.accent),
          cta,
        ],
      ),
    ),
  );
}

/** Photo and a brand-colour panel. */
function split(c: Ctx): El {
  const { W, H, P, u } = c;
  const pal = c.spec.brand.colors;
  const panel = deepen(pal.primary);
  const fg = textOn(panel);
  const accent = contrast(pal.accent, panel) >= 3 ? pal.accent : fg;
  const cta = (width: number) =>
    ctaBlock(c, { bg: accent, fg: textOn(accent), width });
  if (c.landscape) {
    const pw = Math.round(W * 0.47);
    const width = pw - P * 2;
    const brand = brandBlock(c, {
      onDark: luminance(panel) < 0.4,
      color: fg,
      maxWidth: width,
    });
    const height = H - P * 2 - brand.height - 3 * u;
    return div(
      { width: W, height: H, position: 'relative', backgroundColor: panel },
      div(
        {
          position: 'absolute',
          left: pw,
          top: 0,
          width: W - pw,
          height: H,
          overflow: 'hidden',
        },
        background(c, W - pw, H),
      ),
      div({
        position: 'absolute',
        left: pw - 0.6 * u,
        top: 0,
        width: 0.6 * u,
        height: H,
        backgroundColor: pal.accent,
      }),
      div({ position: 'absolute', left: P, top: P }, brand.el),
      div(
        {
          position: 'absolute',
          left: P,
          bottom: P,
          height,
          flexDirection: 'column',
          justifyContent: 'center',
        },
        column(
          c,
          {
            width,
            height,
            headlineColor: fg,
            headlineMax: Math.round(8.5 * u),
            gap: 2 * u,
          },
          [eyebrowBlock(c, width, accent)],
          [
            bodyBlock(c, c.spec.text.subheadline, {
              width,
              size: Math.round(3.2 * u),
              maxLines: 4,
              color: fg,
              label: 'The supporting line',
            }),
            detailsBlock(c, width, fg, accent),
            cta(width),
          ],
        ),
      ),
    );
  }
  const ph = Math.round(H * (c.tall ? 0.56 : W === H ? 0.5 : 0.54));
  const width = W - P * 2;
  const brand = brandBlock(c, {
    onDark: luminance(panel) < 0.4,
    color: fg,
    maxWidth: width * 0.5,
  });
  const height = H - ph - P * 2;
  return div(
    { width: W, height: H, position: 'relative', backgroundColor: panel },
    div(
      {
        position: 'absolute',
        left: 0,
        top: 0,
        width: W,
        height: ph,
        overflow: 'hidden',
      },
      background(c, W, ph),
    ),
    div({
      position: 'absolute',
      left: 0,
      top: ph,
      width: W,
      height: 0.7 * u,
      backgroundColor: pal.accent,
    }),
    div({ position: 'absolute', left: P, top: P }, brand.el),
    div(
      {
        position: 'absolute',
        left: P,
        top: ph + P,
        height,
        flexDirection: 'column',
        justifyContent: 'center',
      },
      column(
        c,
        {
          width,
          height,
          headlineColor: fg,
          headlineMax: Math.round((c.tall ? 9.5 : 8) * u),
          gap: 1.8 * u,
        },
        [eyebrowBlock(c, width, accent)],
        [
          bodyBlock(c, c.spec.text.subheadline, {
            width,
            size: Math.round(3.1 * u),
            maxLines: 2,
            color: fg,
            label: 'The supporting line',
          }),
          detailsBlock(c, width, fg, accent),
          cta(width),
        ],
      ),
    ),
  );
}

/** Photo with a centred card. */
function frame(c: Ctx): El {
  const { W, H, P, u } = c;
  const pal = c.spec.brand.colors;
  const head =
    contrast(deepen(pal.primary), PAPER) >= 4.5 ? deepen(pal.primary) : INK;
  const cw = Math.round(c.landscape ? W * 0.56 : W * 0.8);
  const pad = 5 * u;
  const width = cw - pad * 2;
  const brand = brandBlock(c, { onDark: false, color: head, maxWidth: width });
  const maxCard = H - P * 2;
  const rule = div({
    width: 8 * u,
    height: 0.55 * u,
    backgroundColor: pal.accent,
    borderRadius: 0.3 * u,
  });
  const inner = column(
    c,
    {
      width,
      height: maxCard - pad * 2 - brand.height - 2.4 * u,
      headlineColor: head,
      headlineMax: Math.round((c.landscape ? 7.5 : 8.5) * u),
      gap: 2 * u,
      align: 'center',
    },
    [
      eyebrowBlock(
        c,
        width,
        contrast(pal.accent, PAPER) >= 3 ? pal.accent : head,
        'center',
      ),
    ],
    [
      { el: rule, height: 0.55 * u },
      bodyBlock(c, c.spec.text.subheadline, {
        width,
        size: Math.round(3.1 * u),
        maxLines: 3,
        color: '#374151',
        label: 'The supporting line',
        align: 'center',
      }),
      detailsBlock(c, width, INK, pal.accent, 'center'),
      ctaBlock(c, { bg: deepen(pal.primary), fg: PAPER, width }),
    ],
  );
  return div(
    {
      width: W,
      height: H,
      position: 'relative',
      alignItems: 'center',
      justifyContent: 'center',
    },
    background(c, W, H),
    div({
      position: 'absolute',
      left: 0,
      top: 0,
      width: W,
      height: H,
      backgroundColor: 'rgba(0,0,0,0.22)',
    }),
    div(
      {
        flexDirection: 'column',
        alignItems: 'center',
        width: cw,
        maxHeight: maxCard,
        padding: pad,
        gap: 2.4 * u,
        borderRadius: 2 * u,
        backgroundColor: 'rgba(255,255,255,0.97)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
      },
      brand.el,
      inner,
    ),
  );
}

/** Photo with a bold offer badge — the offer exactly as given. */
function offer(c: Ctx): El {
  const { W, H, P, u } = c;
  const pal = c.spec.brand.colors;
  const dark = mix(pal.primary, '#000000', 0.7);
  const d = Math.round(
    (c.landscape ? 0.42 : 0.3) * Math.min(W, H) * (c.landscape ? 1 : 1.15),
  );
  const badgeFg = textOn(pal.accent);
  const disp = display(c);
  const offerText = up(c, c.spec.text.offer ?? '');
  const of = fitText(c.metrics, offerText, {
    fonts: disp.files,
    maxWidth: d * 0.7,
    maxHeight: d * 0.62,
    maxSize: Math.round(d * 0.34),
    minSize: Math.round(d * 0.1),
    lineHeight: disp.lineHeight,
    maxLines: 3,
    letterSpacing: disp.tracking,
  });
  if (!of)
    throw new CreativeFitError(
      'The offer is too long for the badge. Keep it short, like "20% OFF".',
    );
  const width = c.landscape ? W * 0.5 : W - P * 2;
  const brand = brandBlock(c, { onDark: true, color: PAPER, maxWidth: width });
  const top = c.landscape ? P + brand.height + 3 * u : P + d + 3 * u;
  const height = H - P - top;
  return div(
    { width: W, height: H, position: 'relative', backgroundColor: dark },
    background(c, W, H),
    div({
      position: 'absolute',
      left: 0,
      top: 0,
      width: W,
      height: H,
      backgroundImage: c.landscape
        ? `linear-gradient(90deg, ${rgba(dark, 0.93)} 0%, ${rgba(dark, 0.75)} 45%, ${rgba(dark, 0.1)} 80%)`
        : `linear-gradient(180deg, ${rgba(dark, 0.3)} 0%, ${rgba(dark, 0.05)} 30%, ${rgba(dark, 0.8)} 60%, ${rgba(dark, 0.96)} 100%)`,
    }),
    div({ position: 'absolute', left: P, top: P }, brand.el),
    div(
      {
        position: 'absolute',
        right: P,
        top: P,
        width: d,
        height: d,
        borderRadius: d,
        backgroundColor: pal.accent,
        alignItems: 'center',
        justifyContent: 'center',
        border: `${Math.round(0.8 * u)}px solid ${rgba('#FFFFFF', 0.9)}`,
      },
      lines(of, {
        fontFamily: disp.family,
        fontWeight: disp.weight,
        fontSize: of.size,
        lineHeight: disp.lineHeight,
        color: badgeFg,
        alignItems: 'center',
        letterSpacing: `${disp.tracking * of.size}px`,
      }),
    ),
    div(
      {
        position: 'absolute',
        left: P,
        bottom: P,
        height,
        flexDirection: 'column',
        justifyContent: 'flex-end',
      },
      column(
        c,
        {
          width,
          height,
          headlineColor: PAPER,
          headlineMax: Math.round((c.tall ? 12 : 9.5) * u),
          gap: 2 * u,
        },
        [
          eyebrowBlock(
            c,
            width,
            contrast(pal.accent, dark) >= 3 ? pal.accent : PAPER,
          ),
        ],
        [
          bodyBlock(c, c.spec.text.subheadline, {
            width,
            size: Math.round(3.3 * u),
            maxLines: 2,
            color: rgba('#FFFFFF', 0.92),
            label: 'The supporting line',
          }),
          detailsBlock(c, width, PAPER, pal.accent),
          ctaBlock(c, { bg: pal.accent, fg: badgeFg, width }),
        ],
      ),
    ),
  );
}

/** Magazine style: the headline set above a framed photograph. */
function editorial(c: Ctx): El {
  const { W, H, P, u } = c;
  const pal = c.spec.brand.colors;
  const paper = mix(pal.primary, '#FFFFFF', 0.94);
  const head =
    contrast(deepen(pal.primary), paper) >= 4.5 ? deepen(pal.primary) : INK;
  const accentOnPaper = contrast(pal.accent, paper) >= 3 ? pal.accent : head;
  const cta = (width: number) =>
    ctaBlock(c, { bg: deepen(pal.primary), fg: PAPER, width });
  if (c.landscape) {
    const tw = Math.round(W * 0.44);
    const width = tw - P * 1.5;
    const brand = brandBlock(c, {
      onDark: false,
      color: head,
      maxWidth: width,
    });
    const height = H - P * 2 - brand.height - 3 * u;
    return div(
      { width: W, height: H, position: 'relative', backgroundColor: paper },
      div(
        {
          position: 'absolute',
          left: tw,
          top: P,
          width: W - tw - P,
          height: H - P * 2,
          borderRadius: 2 * u,
          overflow: 'hidden',
        },
        background(c, W - tw - P, H - P * 2),
      ),
      div({ position: 'absolute', left: P, top: P }, brand.el),
      div(
        {
          position: 'absolute',
          left: P,
          bottom: P,
          height,
          flexDirection: 'column',
          justifyContent: 'center',
        },
        column(
          c,
          {
            width,
            height,
            headlineColor: head,
            headlineMax: Math.round(8 * u),
            gap: 2 * u,
          },
          [eyebrowBlock(c, width, accentOnPaper)],
          [
            bodyBlock(c, c.spec.text.subheadline, {
              width,
              size: Math.round(3.1 * u),
              maxLines: 4,
              color: '#374151',
              label: 'The supporting line',
            }),
            detailsBlock(c, width, INK, pal.accent),
            cta(width),
          ],
        ),
      ),
    );
  }
  const width = W - P * 2;
  const brand = brandBlock(c, {
    onDark: false,
    color: head,
    maxWidth: width * 0.5,
  });
  const textH =
    Math.round(H * (c.tall ? 0.42 : 0.44)) - P - brand.height - 2 * u;
  const photoTop = P + brand.height + 2 * u + textH + 2 * u;
  const photoH = H - photoTop - P;
  const ctaEl = cta(W * 0.6);
  return div(
    { width: W, height: H, position: 'relative', backgroundColor: paper },
    div({ position: 'absolute', left: P, top: P }, brand.el),
    div(
      {
        position: 'absolute',
        left: P,
        top: P + brand.height + 2 * u,
        height: textH,
        flexDirection: 'column',
        justifyContent: 'flex-end',
      },
      column(
        c,
        {
          width,
          height: textH,
          headlineColor: head,
          headlineMax: Math.round((c.tall ? 9 : 7.5) * u),
          gap: 1.6 * u,
        },
        [eyebrowBlock(c, width, accentOnPaper)],
        [
          bodyBlock(c, c.spec.text.subheadline, {
            width,
            size: Math.round(3 * u),
            maxLines: 2,
            color: '#374151',
            label: 'The supporting line',
          }),
          detailsBlock(c, width, INK, pal.accent),
        ],
      ),
    ),
    div(
      {
        position: 'absolute',
        left: P,
        top: photoTop,
        width,
        height: photoH,
        borderRadius: 2 * u,
        overflow: 'hidden',
      },
      background(c, width, photoH),
    ),
    ctaEl
      ? div(
          {
            position: 'absolute',
            left: P + 2.4 * u,
            top: photoTop + photoH - ctaEl.height - 2.4 * u,
          },
          ctaEl.el,
        )
      : null,
  );
}

/** Dramatic and centred: a dark veil, fine rules, elegant type. */
function spotlight(c: Ctx): El {
  const { W, H, P, u } = c;
  const pal = c.spec.brand.colors;
  const dark = mix(pal.primary, '#000000', 0.78);
  const accent = contrast(pal.accent, dark) >= 3 ? pal.accent : PAPER;
  const width = c.landscape ? W * 0.62 : W - P * 2.6;
  const brand = brandBlock(c, { onDark: true, color: PAPER, maxWidth: width });
  const eyebrow = eyebrowBlock(c, width * 0.7, accent, 'center');
  const ruled: Block | null = eyebrow
    ? {
        el: div(
          { flexDirection: 'row', alignItems: 'center', gap: 2 * u },
          div({
            width: 6 * u,
            height: Math.max(2, 0.25 * u),
            backgroundColor: accent,
          }),
          eyebrow.el,
          div({
            width: 6 * u,
            height: Math.max(2, 0.25 * u),
            backgroundColor: accent,
          }),
        ),
        height: eyebrow.height,
      }
    : null;
  const height = H - P * 2 - brand.height - 4 * u;
  return div(
    {
      width: W,
      height: H,
      position: 'relative',
      backgroundColor: dark,
      alignItems: 'center',
      justifyContent: 'center',
    },
    background(c, W, H),
    div({
      position: 'absolute',
      left: 0,
      top: 0,
      width: W,
      height: H,
      backgroundImage: `linear-gradient(180deg, ${rgba(dark, 0.78)} 0%, ${rgba(dark, 0.62)} 45%, ${rgba(dark, 0.85)} 100%)`,
    }),
    div(
      {
        position: 'absolute',
        left: 0,
        top: P,
        width: W,
        justifyContent: 'center',
      },
      brand.el,
    ),
    div(
      {
        position: 'absolute',
        left: (W - width) / 2,
        top: P + brand.height + 4 * u,
        width,
        height,
        alignItems: 'center',
        justifyContent: 'center',
      },
      column(
        c,
        {
          width,
          height,
          headlineColor: PAPER,
          headlineMax: Math.round((c.landscape ? 8.5 : 10) * u),
          gap: 2.4 * u,
          align: 'center',
        },
        [ruled],
        [
          bodyBlock(c, c.spec.text.subheadline, {
            width,
            size: Math.round(3.3 * u),
            maxLines: 3,
            color: rgba('#FFFFFF', 0.9),
            label: 'The supporting line',
            align: 'center',
          }),
          detailsBlock(c, width, PAPER, accent, 'center'),
          ctaBlock(c, { bg: accent, fg: textOn(accent), width, outline: true }),
        ],
      ),
    ),
  );
}

const LAYOUT_FN = { hero, split, frame, offer, editorial, spotlight } as const;

/** Render a creative to PNG. Throws CreativeFitError when text cannot fit. */
export async function renderCreative(
  spec: CreativeSpec,
  images: { photo: RenderImage | null; logo: RenderImage | null },
): Promise<RenderResult> {
  const { fonts, metrics } = loadFonts();
  const { width: W, height: H } = CREATIVE_FORMATS[spec.aspectRatio];
  const short = Math.min(W, H);
  const c: Ctx = {
    W,
    H,
    u: short / 100,
    P: Math.round(short * 0.065),
    landscape: W > H,
    tall: H / W > 1.5,
    spec,
    metrics,
    photo: images.photo,
    logo: images.logo,
    warnings: [],
  };
  // The offer layout needs an offer; without one the hero says the same thing.
  const layout =
    spec.layout === 'offer' && !spec.text.offer ? 'hero' : spec.layout;
  if (layout !== spec.layout)
    c.warnings.push(
      'No offer was given, so the offer layout was swapped for the hero layout.',
    );
  const tree = LAYOUT_FN[layout](c);
  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: W,
    height: H,
    fonts,
  });
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: W },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
  return { png: Buffer.from(png), width: W, height: H, warnings: c.warnings };
}
