/**
 * Content Studio image preview, in a real browser (Chromium via
 * playwright-core), at phone / tablet / desktop widths:
 *
 *   - clicking a generated image opens it full screen (a modal dialog)
 *   - shown whole: aspect ratio kept, fully on screen, full-resolution file
 *   - the page behind does not scroll; next / previous / arrow keys move
 *     between images; Download points at the file
 *   - Escape and a click outside the image close it
 *   - no console errors
 *
 * Screenshots go to ./.responsive-shots (git-ignored).
 * Run (app running): VERIFY_BASE_URL=http://localhost:3000 pnpm verify:image-preview
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { chromium, type Page } from 'playwright-core';

import { db } from '@/lib/db';

const BASE = (process.env.VERIFY_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-preview-${STAMP}!`;
const SHOTS = path.join(process.cwd(), '.responsive-shots');
const WIDTHS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function chromiumPath(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean) as string[];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(root, dir, exe);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error('No Chromium found — set CHROMIUM_PATH or run `npx playwright install chromium`.');
}

async function sessionCookies(email: string): Promise<{ name: string; value: string }[]> {
  const jar = new Map<string, string>();
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`, { headers: { cookie: cookie() } });
  keep(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: cookie() },
    body: new URLSearchParams({ csrfToken, email, password: PASSWORD, json: 'true' }),
  });
  keep(res);
  return [...jar].map(([name, value]) => ({ name, value }));
}

/** What the open preview shows, measured in the page. */
async function previewFacts(page: Page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const img = dialog?.querySelector('img') as HTMLImageElement | null;
    const r = img?.getBoundingClientRect();
    return {
      open: Boolean(dialog),
      src: img?.getAttribute('src') ?? null,
      natural: img ? { w: img.naturalWidth, h: img.naturalHeight } : null,
      box: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height } : null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      loading: Boolean(dialog?.querySelector('[role="status"]')),
      scrollLocked: document.body.hasAttribute('data-scroll-locked') || getComputedStyle(document.body).overflow === 'hidden',
      download: dialog?.querySelector('a[download]')?.getAttribute('href') ?? null,
      // What a person sees: the image's own opacity and the dialog's.
      opacity: img ? Number(getComputedStyle(img).opacity) * Number(getComputedStyle(dialog as Element).opacity) : 0,
    };
  });
}

async function main() {
  const user = await db.user.create({
    data: { email: `zzverify-preview-${STAMP}@example.test`, name: 'Pat Preview', passwordHash: await bcrypt.hash(PASSWORD, 10), emailVerified: new Date() },
  });
  const company = await db.company.create({ data: { name: `zzverify Preview ${STAMP}`, slug: `zzverify-preview-${STAMP}` } });
  await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'OWNER' } });
  const body = { hook: 'Our tasting night is back.', paragraphs: ['One.', 'Two.', 'Three.'], cta: 'Book a seat.', hashtags: [] };
  const draft = await db.contentDraft.create({ data: { companyId: company.id, type: 'LINKEDIN_POST', platform: 'LINKEDIN', status: 'DRAFT', title: 'Tasting night', body } });

  // Three generated images of different shapes (portrait, square, landscape).
  const shapes = [
    { w: 1024, h: 1280, ratio: '4:5', color: '#7a3a3a' },
    { w: 1024, h: 1024, ratio: '1:1', color: '#3a7a4a' },
    { w: 1536, h: 864, ratio: '16:9', color: '#3a4a7a' },
  ];
  const ids: string[] = [];
  for (const [i, s] of shapes.entries()) {
    const png = await sharp({ create: { width: s.w, height: s.h, channels: 3, background: s.color } }).png().toBuffer();
    const a = await db.generatedAsset.create({
      data: {
        companyId: company.id,
        contentDraftId: draft.id,
        provider: 'GOOGLE',
        model: 'gemini-image',
        prompt: 'A candle-lit wine tasting table, real photograph.',
        aspectRatio: s.ratio,
        width: s.w,
        height: s.h,
        mimeType: 'image/png',
        fileSize: png.byteLength,
        storage: 'DATABASE',
        data: png,
        createdAt: new Date(Date.now() - (3 - i) * 60_000),
      },
    });
    ids.push(a.id);
  }

  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  try {
    const cookies = await sessionCookies(user.email);
    const host = new URL(BASE).hostname;
    for (const vp of WIDTHS) {
      console.log(`\n${vp.name} (${vp.width}×${vp.height})`);
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      await context.addCookies(cookies.map((c) => ({ ...c, domain: host, path: '/' })));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location().url || 'page'}`);
      });
      // Name the failing URL, so a console "404" says what it was.
      page.on('response', (r) => {
        if (r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`);
      });
      await page.goto(`${BASE}/dashboard/content/${draft.id}`, { waitUntil: 'networkidle', timeout: 120_000 });

      const tiles = page.getByRole('button', { name: /in a larger view/i });
      check('generated images are offered to open larger', (await tiles.count()) >= 3, `${await tiles.count()} tiles`);
      await tiles.first().scrollIntoViewIfNeeded();
      await tiles.first().click();
      await page.getByRole('dialog').waitFor({ timeout: 10_000 });
      await page.waitForFunction(() => {
        const img = document.querySelector('[role="dialog"] img') as HTMLImageElement | null;
        return Boolean(img && img.complete && img.naturalWidth > 0 && !document.querySelector('[role="dialog"] [role="status"]'));
      }, null, { timeout: 15_000 });
      await page.waitForTimeout(500); // the open animation
      let f = await previewFacts(page);
      check('…and the image is actually visible', f.opacity > 0.99, `opacity ${f.opacity}`);
      check('clicking a generated image opens the full-screen preview', f.open);
      check('…from the full-resolution file', Boolean(f.src && /\/api\/content\/graphics\/[^/]+\/file$/.test(f.src) && f.natural && f.natural.w >= 1024), JSON.stringify(f.natural));
      const ratio = (b: { w: number; h: number }) => b.w / b.h;
      check('…whole, in its own proportions', Boolean(f.box && f.natural && Math.abs(ratio(f.box) - ratio(f.natural)) < 0.02), JSON.stringify({ box: f.box, natural: f.natural }));
      check('…and fully on screen', Boolean(f.box && f.box.left >= 0 && f.box.top >= 0 && f.box.right <= f.viewport.w + 0.5 && f.box.bottom <= f.viewport.h + 0.5), JSON.stringify(f.box));
      check('…using most of the screen', Boolean(f.box && (f.box.w > f.viewport.w * 0.6 || f.box.h > f.viewport.h * 0.6)), JSON.stringify(f.box));
      check('the page behind does not scroll', f.scrollLocked);
      check('Download points at the image shown', f.download === f.src);
      await page.screenshot({ path: path.join(SHOTS, `${vp.name}-image-preview.png`) });

      const first = f.src;
      await page.getByRole('button', { name: /next image/i }).click();
      f = await previewFacts(page);
      check('Next shows another image', f.src !== first && Boolean(f.src));
      await page.keyboard.press('ArrowLeft');
      f = await previewFacts(page);
      check('the left arrow key goes back', f.src === first);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => {
        const img = document.querySelector('[role="dialog"] img') as HTMLImageElement | null;
        return Boolean(img && img.complete && img.naturalWidth > 0);
      }, null, { timeout: 15_000 });
      await page.waitForTimeout(500);
      f = await previewFacts(page);
      check('after stepping through, the image shown is visible', f.opacity > 0.99, `opacity ${f.opacity}`);
      check('a landscape image also fits whole', Boolean(f.box && f.natural && Math.abs(ratio(f.box) - ratio(f.natural)) < 0.02 && f.box.right <= f.viewport.w + 0.5), JSON.stringify(f.box));
      await page.screenshot({ path: path.join(SHOTS, `${vp.name}-image-preview-landscape.png`) });

      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      check('Escape closes it', !(await previewFacts(page)).open);
      check('…and the page scrolls again', !(await previewFacts(page)).scrollLocked);

      await tiles.first().click();
      await page.getByRole('dialog').waitFor();
      // A click on the empty space beside the image (a corner of the backdrop).
      await page.mouse.click(4, vp.height - 4);
      await page.waitForTimeout(300);
      check('a click outside the image closes it', !(await previewFacts(page)).open);

      await tiles.first().click();
      await page.getByRole('dialog').waitFor();
      await page.getByRole('button', { name: /close preview/i }).click();
      await page.waitForTimeout(300);
      check('the X closes it', !(await previewFacts(page)).open);

      // The selected image's large view opens the preview too.
      const big = page.getByRole('button', { name: /open this image in a larger view/i });
      if (await big.count()) {
        await big.first().click();
        await page.getByRole('dialog').waitFor();
        check('the selected image opens the preview as well', (await previewFacts(page)).open);
        await page.keyboard.press('Escape');
      }

      // The browser's automatic /favicon.ico request 404s app-wide (no favicon
      // at that path) — unrelated to the preview, so it is not counted.
      const real = errors.filter((e) => !e.includes('/favicon.ico'));
      check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));
      await context.close();
    }
  } finally {
    await browser.close();
    await db.company.delete({ where: { id: company.id } }).catch(() => undefined);
    await db.auditLog.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    console.log(`\n  ok      cleanup: throwaway workspace removed (screenshots in ${SHOTS})`);
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll image preview checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
