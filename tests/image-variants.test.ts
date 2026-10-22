import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/http', () => ({ httpRequest: vi.fn() }));

import { httpRequest } from '@/lib/http';
import {
  groupVariants,
  logoOf,
  logoSpaceInstruction,
  makeSpaceInstruction,
  refinePrompt,
  variantOf,
} from '@/lib/image-variants';
import { overlayLogo } from '@/server/media/logo-overlay';
import { googleImageProvider } from '@/server/media/providers/gemini';
import { openAiImageProvider } from '@/server/media/providers/openai';
import { supportsEditing } from '@/server/media/types';

/**
 * Image variants (lib/image-variants.ts): versions, the refinement prompt,
 * the exact-logo overlay, and the providers' edit calls.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(httpRequest).mockReset();
});

describe('lineage', () => {
  it('an image made before variants is its own version 1', () => {
    expect(variantOf('a1', {})).toEqual({ rootId: 'a1', parentId: null, version: 1, action: 'generated', instruction: null });
    expect(logoOf({})).toBeNull();
  });

  it('versions group under their variant, oldest first, newest variant first', () => {
    const v = (id: string, rootId: string, version: number, createdAt: string) => ({
      id,
      createdAt,
      variant: { rootId, parentId: null, version, action: 'refined' as const, instruction: null },
    });
    const groups = groupVariants([
      v('b2', 'b1', 2, '2026-10-22T10:05:00Z'),
      v('a1', 'a1', 1, '2026-10-22T10:00:00Z'),
      v('b1', 'b1', 1, '2026-10-22T10:00:00Z'),
      v('a2', 'a1', 2, '2026-10-22T10:02:00Z'),
    ]);
    expect(groups.map((g) => g.rootId)).toEqual(['b1', 'a1']);
    expect(groups[1]!.versions.map((x) => x.id)).toEqual(['a1', 'a2']);
  });
});

describe('prompts', () => {
  it('a refinement keeps everything not asked to change, and never adds a logo or text', () => {
    const p = refinePrompt({ instruction: 'Move the whiskey glass to the right', logo: null, position: 'bottom-right' });
    expect(p).toContain('Move the whiskey glass to the right');
    expect(p).toMatch(/Keep everything the instruction does not ask to change/);
    expect(p).toMatch(/Do not add any text, lettering, logo/);
  });

  it('room for a logo is clean space, never a drawn mark', () => {
    expect(logoSpaceInstruction('top-left')).toMatch(/top left corner/);
    expect(logoSpaceInstruction('top-left')).toMatch(/Do not draw any logo/);
    expect(refinePrompt({ instruction: 'warmer', logo: 'include', position: 'top-right' })).toMatch(/top right corner/);
    expect(makeSpaceInstruction('bottom-left')).toMatch(/remove it/);
  });
});

describe('the exact logo is placed, never redrawn', () => {
  it('composites the logo’s own pixels in the chosen corner, proportions kept', async () => {
    const image = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#204060' } }).png().toBuffer();
    const logo = await sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 240, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const out = await overlayLogo({ image, logo, position: 'bottom-right' });
    expect(out.width).toBe(800);
    expect(out.box.width / out.box.height).toBeCloseTo(3, 1);
    expect(out.box.left + out.box.width).toBeLessThan(800);
    expect(out.box.left).toBeGreaterThan(400);
    const { data, info } = await sharp(out.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3));
    expect(at(out.box.left + 10, out.box.top + 10)).toEqual([240, 0, 0]);
    expect(at(20, 20)).toEqual([32, 64, 96]); // the rest of the image is untouched
  });

  it('keeps the logo’s transparency', async () => {
    const image = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const logo = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const out = await overlayLogo({ image, logo, position: 'top-left' });
    const { data, info } = await sharp(out.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const i = ((out.box.top + 5) * info.width + out.box.left + 5) * 3;
    expect(Array.from(data.subarray(i, i + 3))).toEqual([255, 255, 255]);
  });

  it('refuses an unreadable logo with a plain reason', async () => {
    const image = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#ffffff' } }).png().toBuffer();
    await expect(overlayLogo({ image, logo: Buffer.from('not an image'), position: 'top-left' })).rejects.toThrow(/logo file could not be read/);
  });
});

describe('providers that can refine', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');

  it('Gemini sends the image with the instruction and returns the edited image', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'k');
    vi.stubEnv('GOOGLE_IMAGE_MODEL', 'gemini-3.1-flash-lite-image');
    vi.mocked(httpRequest).mockResolvedValue(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }] })),
    );
    expect(googleImageProvider.canEdit?.()).toBe(true);
    const out = await googleImageProvider.editImage!({ image: { data: png, mimeType: 'image/png' }, prompt: 'warmer', aspectRatio: '1:1', width: 1024, height: 1024 });
    const [url, init] = vi.mocked(httpRequest).mock.calls[0]!;
    const body = JSON.parse(String(init!.body)) as { contents: { parts: { inlineData?: { data: string }; text?: string }[] }[] };
    expect(String(url)).toContain(':generateContent');
    expect(body.contents[0]!.parts[0]!.inlineData!.data).toBe(png.toString('base64'));
    expect(body.contents[0]!.parts[1]!.text).toBe('warmer');
    expect(out.data).toEqual(Buffer.from('AAAA', 'base64'));
  });

  it('Imagen cannot edit, and says so', () => {
    vi.stubEnv('GEMINI_API_KEY', 'k');
    vi.stubEnv('GOOGLE_IMAGE_MODEL', 'imagen-4.0-generate-001');
    expect(googleImageProvider.canEdit?.()).toBe(false);
    expect(supportsEditing(googleImageProvider)).toBe(false);
  });

  it('OpenAI uses the edits endpoint with the image as a file', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k');
    vi.mocked(httpRequest).mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] })));
    await openAiImageProvider.editImage!({ image: { data: png, mimeType: 'image/png' }, prompt: 'warmer', aspectRatio: '1:1', width: 1024, height: 1024 });
    const [url, init] = vi.mocked(httpRequest).mock.calls[0]!;
    expect(String(url)).toBe('https://api.openai.com/v1/images/edits');
    const form = init!.body as FormData;
    expect(form.get('prompt')).toBe('warmer');
    expect(form.get('image')).toBeInstanceOf(Blob);
    expect(init!.retries).toBe(0); // a paid call is never silently retried
  });
});
