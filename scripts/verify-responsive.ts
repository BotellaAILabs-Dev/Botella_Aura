/**
 * Responsive UI check for the Sprint 9 pages, in a real browser (Chromium via
 * playwright-core), signed in, at phone / tablet / desktop widths:
 *
 *   - the page loads (200) without an error boundary
 *   - nothing overflows sideways (no horizontal page scroll)
 *   - the page header is visible
 *
 * A screenshot of every page × width is saved for a person to look over
 * (RESPONSIVE_SHOTS_DIR, default ./.responsive-shots — git-ignored by .next-style
 * convention; delete when done).
 *
 * Needs a Chromium: CHROMIUM_PATH, or Playwright's own install under
 * %LOCALAPPDATA%/ms-playwright (or ~/.cache/ms-playwright).
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:responsive
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { chromium } from 'playwright-core';

import { db } from '@/lib/db';

const BASE = (process.env.VERIFY_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-resp-${STAMP}!`;
const SHOTS = process.env.RESPONSIVE_SHOTS_DIR ?? path.join(process.cwd(), '.responsive-shots');
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

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const user = await db.user.create({ data: { email: `zzverify-resp-${STAMP}@example.test`, name: 'Robin Responsive', passwordHash: hash, emailVerified: new Date() } });
  const company = await db.company.create({
    data: {
      name: `zzverify Responsive ${STAMP}`,
      slug: `zzverify-resp-${STAMP}`,
      website: 'https://brunch.example',
      preferences: { business: { description: 'A neighbourhood brunch café.' }, marketingProfile: { audience: 'Weekend brunch regulars', goals: 'Fill weekend tables', channels: ['LinkedIn'] } } as Prisma.InputJsonObject,
    },
  });
  await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'OWNER' } });
  const body = { hook: 'Our weekend brunch is back.', paragraphs: ['Fresh pastries from our own oven.', 'Slow coffee, brewed to order.', 'A table by the window if you come early.'], cta: 'Book a table.', hashtags: ['brunch'] };
  const draft = await db.contentDraft.create({ data: { companyId: company.id, type: 'LINKEDIN_POST', platform: 'LINKEDIN', status: 'APPROVED', title: 'Weekend brunch is back', body } });
  const opp = await db.opportunity.create({ data: { companyId: company.id, type: 'TRENDING_TOPIC', title: 'Brunch season', summary: 's', source: 'ADVISOR', detectedBy: 'verify', priority: 'HIGH', priorityScore: 80, confidence: 'HIGH', dedupeKey: `resp-${STAMP}` } });
  const rec = await db.recommendation.create({
    data: {
      companyId: company.id, opportunityId: opp.id, type: 'AUDIENCE', status: 'ACCEPTED', title: 'Invite brunch regulars back this weekend',
      summary: 's', action: 'Post and reach out to regulars.', rationale: 'Bookings dip after the holidays.', expectedOutcome: 'Fuller weekend tables.',
      confidence: 'HIGH', priority: 'HIGH', priorityScore: 80, channel: 'LinkedIn', contentType: 'LINKEDIN_POST', audience: 'Weekend brunch regulars',
      details: { action: 'targeted-post', angle: 'Come back for brunch' } as Prisma.InputJsonObject, handoff: {} as Prisma.InputJsonObject, handoffVersion: 1, createdBy: 'verify',
    },
  });

  const pages = [
    { name: 'home', path: '/dashboard' },
    { name: 'suggestions', path: '/dashboard/suggestions' },
    { name: 'content', path: '/dashboard/content' },
    { name: 'content-new-from-suggestion', path: `/dashboard/content/new?rec=${rec.id}` },
    { name: 'draft', path: `/dashboard/content/${draft.id}` },
    { name: 'review-queue', path: '/dashboard/review' },
    { name: 'review-item', path: `/dashboard/review/content/${draft.id}` },
    { name: 'campaign-new-from-suggestion', path: `/dashboard/campaigns/new?rec=${rec.id}` },
    { name: 'outreach-new-from-suggestion', path: `/dashboard/outreach/new?rec=${rec.id}` },
    { name: 'whatsapp-assistant', path: '/dashboard/whatsapp-assistant' },
    { name: 'connection-manager', path: '/dashboard/connections' },
    { name: 'connection-setup', path: '/dashboard/connections/meta/setup' },
    { name: 'publishing', path: '/dashboard/executions' },
    { name: 'settings', path: '/dashboard/settings' },
    { name: 'privacy', path: '/privacy' },
    { name: 'terms', path: '/terms' },
    { name: 'data-deletion', path: '/data-deletion' },
  ];

  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  try {
    const cookies = await sessionCookies(user.email);
    const host = new URL(BASE).hostname;
    for (const vp of WIDTHS) {
      console.log(`\n${vp.name} (${vp.width}×${vp.height})`);
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
      await context.addCookies(cookies.map((c) => ({ ...c, domain: host, path: '/' })));
      const page = await context.newPage();
      for (const p of pages) {
        const res = await page.goto(`${BASE}${p.path}`, { waitUntil: 'networkidle', timeout: 120_000 }).catch(() => null);
        await page.waitForTimeout(300);
        const facts = await page.evaluate(() => {
          const doc = document.documentElement;
          const text = document.body.innerText;
          const h1 = document.querySelector('h1');
          const r = h1?.getBoundingClientRect();
          return {
            overflow: doc.scrollWidth - doc.clientWidth,
            broken: /Something failed while building this view|Application error|Unhandled Runtime Error/.test(text),
            login: location.pathname.startsWith('/login'),
            header: Boolean(h1 && r && r.width > 0 && r.right <= window.innerWidth + 1),
          };
        });
        await page.screenshot({ path: path.join(SHOTS, `${vp.name}-${p.name}.png`), fullPage: true });
        check(
          `${p.name}: loads, no error, no sideways scroll, header visible`,
          res?.status() === 200 && !facts.broken && !facts.login && facts.overflow <= 1 && facts.header,
          `HTTP ${res?.status()} overflow ${facts.overflow}px${facts.broken ? ' error-boundary' : ''}${facts.login ? ' redirected-to-login' : ''}${facts.header ? '' : ' no-visible-h1'}`,
        );
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await db.auditLog.deleteMany({ where: { OR: [{ companyId: company.id }, { userId: user.id }] } });
    await db.company.delete({ where: { id: company.id } });
    await db.user.delete({ where: { id: user.id } });
    console.log(`\n  ok      cleanup: throwaway user and workspace removed (screenshots in ${SHOTS})`);
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) BROKEN.` : '\nAll responsive checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
