import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { FontPair } from '@/lib/creative/spec';
import type { FontMetrics } from '@/lib/creative/text-fit';

/**
 * The fonts creatives are set in — bundled with the app (assets/fonts, SIL
 * Open Font License, see assets/fonts/LICENSES), so text renders identically
 * on every machine and needs no system fonts or network. Read once per
 * process.
 */

const DIR = path.join(process.cwd(), 'assets', 'fonts');

export interface FontFace {
  name: string;
  file: string;
  weight: 400 | 600 | 700 | 800;
}

/** Every face, in the order satori should try them. "InterExt" carries ₹ and other extended Latin glyphs. */
const FACES: FontFace[] = [
  { name: 'Inter', file: 'inter-400.woff', weight: 400 },
  { name: 'Inter', file: 'inter-600.woff', weight: 600 },
  { name: 'Inter', file: 'inter-800.woff', weight: 800 },
  { name: 'InterExt', file: 'inter-ext-400.woff', weight: 400 },
  { name: 'InterExt', file: 'inter-ext-800.woff', weight: 800 },
  { name: 'Montserrat', file: 'montserrat-700.woff', weight: 700 },
  { name: 'Montserrat', file: 'montserrat-800.woff', weight: 800 },
  { name: 'Playfair Display', file: 'playfair-display-700.woff', weight: 700 },
  { name: 'Bebas Neue', file: 'bebas-neue-400.woff', weight: 400 },
];

/** How each pairing sets its display type. Body copy is always Inter. */
export const DISPLAY: Record<
  FontPair,
  {
    family: string;
    weight: 400 | 700 | 800;
    files: string[];
    upper: boolean;
    tracking: number;
    lineHeight: number;
  }
> = {
  modern: {
    family: 'Montserrat, InterExt',
    weight: 800,
    files: ['montserrat-800.woff', 'inter-ext-800.woff'],
    upper: true,
    tracking: -0.01,
    lineHeight: 1.04,
  },
  impact: {
    family: 'Bebas Neue, InterExt',
    weight: 400,
    files: ['bebas-neue-400.woff', 'inter-ext-800.woff'],
    upper: true,
    tracking: 0.01,
    lineHeight: 0.98,
  },
  elegant: {
    family: 'Playfair Display, InterExt',
    weight: 700,
    files: ['playfair-display-700.woff', 'inter-ext-800.woff'],
    upper: false,
    tracking: -0.005,
    lineHeight: 1.1,
  },
  clean: {
    family: 'Inter, InterExt',
    weight: 800,
    files: ['inter-800.woff', 'inter-ext-800.woff'],
    upper: false,
    tracking: -0.02,
    lineHeight: 1.08,
  },
};

export const BODY = {
  family: 'Inter, InterExt',
  regular: ['inter-400.woff', 'inter-ext-400.woff'],
  semibold: ['inter-600.woff', 'inter-ext-400.woff'],
  bold: ['inter-800.woff', 'inter-ext-800.woff'],
};

let cached: {
  fonts: {
    name: string;
    data: Buffer;
    weight: FontFace['weight'];
    style: 'normal';
  }[];
  metrics: FontMetrics;
} | null = null;

export function loadFonts() {
  if (cached) return cached;
  cached = {
    fonts: FACES.map((f) => ({
      name: f.name,
      data: readFileSync(path.join(DIR, f.file)),
      weight: f.weight,
      style: 'normal' as const,
    })),
    metrics: JSON.parse(
      readFileSync(path.join(DIR, 'metrics.json'), 'utf8'),
    ) as FontMetrics,
  };
  return cached;
}
