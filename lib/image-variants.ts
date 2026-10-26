/**
 * Image variants and their versions (Content Studio).
 *
 * Every generated image is a VARIANT. Refining it ("warmer light, move the
 * glass to the right"), regenerating it, or changing its logo setting never
 * modifies it: a new image is stored as the next VERSION of that variant, so
 * any earlier version can be compared, reverted to, and used.
 *
 * The lineage lives in the asset's `metadata` (no schema change):
 *   variant: { rootId, parentId, version, action, instruction? }
 *   logo:    { mode, position, applied, reason? }
 *   cleanId: the logo-free image a logo was placed on (kept, hidden)
 *   hidden:  true for that logo-free copy — not shown as its own image
 *
 * The brand logo is NEVER drawn by the image model: images are generated
 * with clean space where it goes, and the exact uploaded logo file is placed
 * on top afterwards (server/media/logo-overlay.ts). Refinements are made on
 * the logo-free copy, then the logo is placed again — so the model never sees
 * or redraws it.
 */

export const LOGO_MODES = ['include', 'none', 'space'] as const;
export type LogoMode = (typeof LOGO_MODES)[number];

export const LOGO_MODE_LABELS: Record<LogoMode, string> = {
  include: 'Include logo',
  none: 'No logo',
  space: 'Add logo later',
};

export const LOGO_MODE_HINTS: Record<LogoMode, string> = {
  include: 'Your exact uploaded logo is placed on the image — never redrawn.',
  none: 'The image is made without a logo.',
  space: 'Clean space is left in a corner for you to place the logo yourself.',
};

export const LOGO_POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const;
export type LogoPosition = (typeof LOGO_POSITIONS)[number];

/**
 * How the logo is coloured when it is placed.
 *
 * 'original' is the default and the only one that touches nothing — the
 * uploaded file's own pixels, as before. The others recolour the logo's opaque
 * pixels while keeping its exact SHAPE and transparency, which is what a brand
 * guideline means by a one-colour or reversed logo: the mark is unchanged, its
 * ink is not.
 *
 * This is for legibility, not creativity. A dark logo disappears into a dark
 * photograph; 'white' is the standard answer and every brand book has a
 * reversed version for exactly this. 'brand' uses the workspace's own primary
 * colour. The image model is never asked to draw or recolour a logo
 * (see the file header) — this is a deterministic pixel operation on the
 * uploaded file.
 */
export const LOGO_TINTS = ['original', 'white', 'black', 'brand'] as const;
export type LogoTint = (typeof LOGO_TINTS)[number];

export const LOGO_TINT_LABELS: Record<LogoTint, string> = {
  original: 'Original colours',
  white: 'White',
  black: 'Black',
  brand: 'Brand colour',
};

export const LOGO_TINT_HINTS: Record<LogoTint, string> = {
  original: 'Your logo file exactly as uploaded.',
  white: 'One-colour white — for dark or busy photographs.',
  black: 'One-colour black — for light, clean backgrounds.',
  brand: 'One colour, in your brand’s primary colour.',
};

export function isLogoTint(value: unknown): value is LogoTint {
  return (LOGO_TINTS as readonly string[]).includes(value as string);
}

export const VARIANT_ACTIONS = ['generated', 'refined', 'regenerated', 'logo'] as const;
export type VariantAction = (typeof VARIANT_ACTIONS)[number];

export interface VariantInfo {
  /** The first image of this variant (version 1). */
  rootId: string;
  /** The version this one was made from. */
  parentId: string | null;
  version: number;
  action: VariantAction;
  /** The refinement instruction, for a refined version. */
  instruction: string | null;
}

export interface LogoInfo {
  mode: LogoMode;
  position: LogoPosition;
  /** The logo is actually on the image. */
  applied: boolean;
  /** Why it is not, when it was asked for. */
  reason: string | null;
  /** How it was coloured. Absent on images placed before tinting existed. */
  tint?: LogoTint;
  /** The colour actually used for 'brand', as a hex string. */
  tintColor?: string | null;
}

/** Read the lineage of an asset (an image made before variants is its own version 1). */
export function variantOf(id: string, metadata: unknown): VariantInfo {
  const v = ((metadata ?? {}) as { variant?: Partial<VariantInfo> }).variant;
  if (!v || typeof v.rootId !== 'string') {
    return { rootId: id, parentId: null, version: 1, action: 'generated', instruction: null };
  }
  return {
    rootId: v.rootId,
    parentId: typeof v.parentId === 'string' ? v.parentId : null,
    version: typeof v.version === 'number' ? v.version : 1,
    action: (VARIANT_ACTIONS as readonly string[]).includes(v.action as string) ? (v.action as VariantAction) : 'generated',
    instruction: typeof v.instruction === 'string' ? v.instruction : null,
  };
}

export function logoOf(metadata: unknown): LogoInfo | null {
  const l = ((metadata ?? {}) as { logo?: Partial<LogoInfo> }).logo;
  if (!l || !(LOGO_MODES as readonly string[]).includes(l.mode as string)) return null;
  return {
    mode: l.mode as LogoMode,
    position: (LOGO_POSITIONS as readonly string[]).includes(l.position as string) ? (l.position as LogoPosition) : 'bottom-right',
    applied: Boolean(l.applied),
    reason: typeof l.reason === 'string' ? l.reason : null,
    // An image placed before tinting existed carries the uploaded colours.
    tint: isLogoTint(l.tint) ? l.tint : 'original',
    tintColor: typeof l.tintColor === 'string' ? l.tintColor : null,
  };
}

export const isHiddenAsset = (metadata: unknown): boolean => Boolean((metadata as { hidden?: unknown } | null)?.hidden);

/**
 * The composition instruction for an image that must leave room for a logo.
 * Used for "Include logo" (the real logo is placed there afterwards) and
 * "Add logo later" (the person places it).
 */
export function logoSpaceInstruction(position: LogoPosition): string {
  const where = position.replace('-', ' ');
  return (
    `Composition: keep the ${where} corner (about a fifth of the width) clean and uncluttered — plain background, ` +
    'no subject, props or detail there — so a logo can be placed on it. ' +
    'Do not draw any logo, emblem, badge, wordmark, watermark or lettering anywhere.'
  );
}

/**
 * The prompt for refining an image: the person's single instruction, plus
 * what must stay the same unless they say otherwise.
 */
export function refinePrompt(args: { instruction: string; logo: LogoMode | null; position: LogoPosition }): string {
  return [
    `Edit this image: ${args.instruction.trim()}`,
    '',
    'Keep everything the instruction does not ask to change: the same subject, composition, framing, camera angle, ' +
      'colour palette, campaign mood and brand direction. Make it look like a real professional photograph, not AI-generated.',
    'Do not add any text, lettering, logo, emblem, watermark or signature.',
    args.logo === 'include' || args.logo === 'space' ? logoSpaceInstruction(args.position) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The instruction behind "Add logo later" on an existing image. */
export function makeSpaceInstruction(position: LogoPosition): string {
  return `Clear the ${position.replace('-', ' ')} corner so a logo can be placed there later: remove anything in it and continue the background naturally. If the image contains a logo or lettering, remove it.`;
}

/** Group assets (newest first) into variants, each with its versions oldest → newest. */
export function groupVariants<T extends { id: string; variant: VariantInfo | null; createdAt: string }>(
  assets: T[],
): { rootId: string; versions: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const a of assets) {
    const root = a.variant?.rootId ?? a.id;
    const list = groups.get(root) ?? [];
    list.push(a);
    groups.set(root, list);
  }
  const out = [...groups.entries()].map(([rootId, versions]) => ({
    rootId,
    versions: versions.sort((x, y) => (x.variant?.version ?? 1) - (y.variant?.version ?? 1) || x.createdAt.localeCompare(y.createdAt)),
  }));
  // Newest activity first.
  const latest = (g: { versions: T[] }) => g.versions.reduce((m, v) => (v.createdAt > m ? v.createdAt : m), '');
  return out.sort((a, b) => latest(b).localeCompare(latest(a)));
}
