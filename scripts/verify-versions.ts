/**
 * Edit & version management, against the real database and the running app
 * (lib/versions.ts, server/versions). The AI is stubbed at the network.
 *
 *   Original    a generated draft is version 1, by Aura
 *   Kept        edits, regenerations, variations and undo are new numbered
 *               versions with their editor and time — nothing is lost
 *   Approved    the approved version is marked and stays identifiable
 *   Restore     making an old version current adds a new version; approved
 *               work is reopened, not overwritten
 *   Outreach    the same model; the review screen shows it all
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:versions
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { REVIEW_DIMENSIONS } from '@/lib/content-review';
import {
  generateDraft,
  refineDraft,
  switchVariation,
} from '@/server/content/generator';
import { reviewDraft } from '@/server/content/review.service';

const BASE = (
  process.env.VERIFY_BASE_URL ??
  process.env.AURA_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-versions-${STAMP}!`;
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

class Client {
  private jar = new Map<string, string>();
  private keep(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      this.jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
  }
  private cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        Origin: BASE,
        cookie: this.cookie(),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.keep(res);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* page */
    }
    return { status: res.status, json: json as Record<string, any>, text };
  }
  async page(path: string) {
    const r = await this.req('GET', path);
    return {
      status: r.status,
      text: r.text
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#x27;|&rsquo;/g, '’')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' '),
    };
  }
  async signIn(email: string) {
    const csrf = await this.req('GET', '/api/auth/csrf');
    const token = (csrf.json as { csrfToken: string }).csrfToken;
    const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        cookie: this.cookie(),
      },
      body: new URLSearchParams({
        csrfToken: token,
        email,
        password: PASSWORD,
        json: 'true',
      }),
    });
    this.keep(res);
    const s = await this.req('GET', '/api/auth/session');
    return (s.json as { user?: { email?: string } })?.user?.email;
  }
}

async function person(label: string) {
  return db.user.create({
    data: {
      email: `zzverify-versions-${label}-${STAMP}@example.test`,
      name: `Dana ${label}`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      emailVerified: new Date(),
    },
  });
}

/** The AI stubbed at the network: the writer returns the next body in turn; the reviewer passes. */
async function withAi<T>(bodies: unknown[], run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const saved = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.GEMINI_API_KEY = 'stub';
  delete process.env.ANTHROPIC_API_KEY;
  let i = 0;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (!String(url).includes('generativelanguage.googleapis.com'))
      return realFetch(url, init);
    const prompt =
      (
        JSON.parse(String(init?.body ?? '{}')) as {
          contents?: { parts: { text: string }[] }[];
        }
      ).contents?.[0]?.parts[0]?.text ?? '';
    const out = prompt.startsWith('TASK: Review this')
      ? {
          dimensions: REVIEW_DIMENSIONS.map((d) => ({
            dimension: d,
            score: 5,
            reason: 'fine',
          })),
          issues: [],
          summary: 'Ready.',
        }
      : prompt.includes('{ "variations": [')
        ? {
            variations: bodies
              .slice(0, 2)
              .map((body, k) => ({ angle: `Angle ${k + 1}`, body })),
          }
        : prompt.includes('"hook": string') || prompt.startsWith('TASK: Revise')
          ? bodies[Math.min(i++, bodies.length - 1)]
          : {};
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: JSON.stringify(out) }] },
            finishReason: 'STOP',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const post = (hook: string) => ({
  hook,
  paragraphs: [
    'We roast single-origin coffee in small batches.',
    'Coffee subscriptions bring it to your kitchen.',
    'Which roast would you start with?',
  ],
  cta: 'Start your coffee subscription on our site.',
  hashtags: ['coffee', 'specialtycoffee', 'homebrewing'],
});
const A = post('We roast single-origin coffee in small batches.');
const B = post('Fresh beans, roasted in small batches every week.');
const C = post('Small batches. Big flavour. Every week.');

/** Same content, whatever order Postgres stored the keys in. */
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
        )
      : v;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canon(a)) === JSON.stringify(canon(b));

interface V {
  n: number;
  source: string;
  byName: string;
  at: string;
  basedOn: number | null;
  isOriginal: boolean;
  isCurrent: boolean;
  isApproved: boolean;
  text: string;
}

async function main() {
  const owner = await person('owner');
  const viewer = await person('viewer');
  const outsider = await person('outsider');
  const company = await db.company.create({
    data: {
      name: 'zzverify versions Roastery',
      slug: `zzverify-versions-${STAMP}`,
      industry: 'Coffee',
      preferences: {
        business: {
          description:
            'We roast single-origin coffee in small batches every week and sell coffee subscriptions online.',
        },
      } as Prisma.InputJsonObject,
    },
  });
  const other = await db.company.create({
    data: {
      name: 'zzverify versions Other',
      slug: `zzverify-versions-o-${STAMP}`,
    },
  });
  const companyId = company.id;
  await db.companyMember.createMany({
    data: [
      { userId: owner.id, companyId, role: 'OWNER' },
      { userId: viewer.id, companyId, role: 'VIEWER' },
      { userId: outsider.id, companyId: other.id, role: 'OWNER' },
    ],
  });
  const load = async (id: string) =>
    (await db.contentDraft.findUnique({ where: { id } }))!;

  try {
    const ownerC = new Client();
    await ownerC.signIn(owner.email);
    const viewerC = new Client();
    await viewerC.signIn(viewer.email);
    const outC = new Client();
    await outC.signIn(outsider.email);
    const versionsOf = async (id: string, kind = 'content') =>
      (await ownerC.req('GET', `/api/review/${kind}/${id}/versions`)).json as {
        versions: V[];
        current: number;
        approved: number | null;
      };

    // ---------------------------------------------------------- Generated
    console.log('\n1. The original AI version');
    const draft = await withAi([A, B], () =>
      generateDraft({
        companyId,
        userId: owner.id,
        type: 'LINKEDIN_POST',
        platform: 'LINKEDIN',
        source: { kind: 'BRIEF', brief: 'Roast day' },
        variations: 2,
      }),
    );
    let v = await versionsOf(draft.id);
    check(
      'a new draft has version 1 — generated by Aura, current and original',
      v.versions.length === 1 &&
        v.versions[0]!.n === 1 &&
        v.versions[0]!.source === 'generated' &&
        v.versions[0]!.byName === 'Aura' &&
        v.versions[0]!.isOriginal &&
        v.versions[0]!.isCurrent,
      JSON.stringify(v).slice(0, 200),
    );

    // ---------------------------------------------------------- Edited
    console.log('\n2. User edits, regenerations and variations are all kept');
    const before = await load(draft.id);
    const saved = await ownerC.req('POST', `/api/review/content/${draft.id}`, {
      action: 'save',
      edits: {
        hook: 'We roast single-origin coffee, by hand, in small batches.',
      },
      baseUpdatedAt: before.updatedAt.toISOString(),
    });
    v = await versionsOf(draft.id);
    const v2 = v.versions.find((x) => x.n === 2);
    check(
      'the person’s edit is version 2, with the editor and the time',
      saved.status === 200 &&
        v.current === 2 &&
        v2?.source === 'edited' &&
        v2.byName === 'Dana owner' &&
        Boolean(Date.parse(v2.at)) &&
        v2.text.includes('by hand'),
      `${saved.status} ${JSON.stringify(v2)}`,
    );
    await withAi([C], async () =>
      refineDraft({
        draft: await load(draft.id),
        userId: owner.id,
        action: 'regenerate',
      }),
    );
    await switchVariation({
      draft: await load(draft.id),
      userId: owner.id,
      index: 1,
    });
    v = await versionsOf(draft.id);
    check(
      'a regeneration (v3) and a variation switch (v4) are new versions — the original and the edit are still there',
      v.versions.map((x) => x.source).join(',') ===
        'variation,regenerated,edited,generated' && v.current === 4,
      v.versions.map((x) => `${x.n}:${x.source}`).join(' '),
    );

    // ---------------------------------------------------------- Approved
    console.log('\n3. The approved version is clearly identified');
    await withAi([C], async () =>
      reviewDraft(await load(draft.id), { trigger: 'manual' }),
    );
    await ownerC.req('POST', `/api/content/drafts/${draft.id}/status`, {
      action: 'submit',
    });
    const ap = await ownerC.req(
      'POST',
      `/api/content/drafts/${draft.id}/status`,
      { action: 'approve', factsReviewed: true, reviewAcknowledged: true },
    );
    v = await versionsOf(draft.id);
    check(
      'the approved version is marked (v4)',
      ap.status === 200 &&
        v.approved === 4 &&
        v.versions.find((x) => x.isApproved)?.n === 4,
      `${ap.status} ${ap.json?.error ?? ''} approved=${v.approved}`,
    );

    // ---------------------------------------------------------- Restore
    console.log('\n4. Choosing the current version — never overwriting');
    const restore = await ownerC.req(
      'POST',
      `/api/review/content/${draft.id}/versions`,
      { version: 1 },
    );
    const d5 = await load(draft.id);
    v = await versionsOf(draft.id);
    const v5 = v.versions.find((x) => x.n === 5);
    check(
      'making the original current adds v5 “restored from v1”; the original is recovered exactly',
      restore.status === 200 &&
        v.current === 5 &&
        v5?.source === 'restored' &&
        v5.basedOn === 1 &&
        same(
          d5.body,
          v.versions.find((x) => x.n === 1)
            ? (await db.contentDraft.findUnique({ where: { id: draft.id } }))!
                .body
            : null,
        ) &&
        same(
          d5.body,
          (
            d5.aiMetadata as {
              versions: { versions: { n: number; body: unknown }[] };
            }
          ).versions.versions.find((x) => x.n === 1)!.body,
        ),
      `${restore.status} ${JSON.stringify(v5)}`,
    );
    check(
      'restoring over an approved version does not overwrite it silently: the post goes back for approval, v4 stays marked approved',
      d5.status === 'DRAFT' &&
        v.approved === 4 &&
        v.versions.find((x) => x.n === 4)?.isApproved === true &&
        !v.versions.find((x) => x.n === 5)?.isApproved,
      `${d5.status} approved=${v.approved}`,
    );
    const again = await ownerC.req(
      'POST',
      `/api/review/content/${draft.id}/versions`,
      { version: 5 },
    );
    const viewerRestore = await viewerC.req(
      'POST',
      `/api/review/content/${draft.id}/versions`,
      { version: 2 },
    );
    const outsiderGet = await outC.req(
      'GET',
      `/api/review/content/${draft.id}/versions`,
    );
    const missing = await ownerC.req(
      'POST',
      `/api/review/content/${draft.id}/versions`,
      { version: 99 },
    );
    check(
      'the current version cannot be “restored” (409); a viewer cannot restore (403); another workspace sees nothing (404); an unknown version is 404',
      again.status === 409 &&
        viewerRestore.status === 403 &&
        outsiderGet.status === 404 &&
        missing.status === 404,
      `${again.status} ${viewerRestore.status} ${outsiderGet.status} ${missing.status}`,
    );
    const undo = await ownerC.req(
      'POST',
      `/api/content/drafts/${draft.id}/undo`,
    );
    v = await versionsOf(draft.id);
    check(
      'an undo is a new version too, linked to the version it returned to',
      undo.status === 200 &&
        v.versions[0]?.source === 'undo' &&
        v.versions[0]?.basedOn !== null &&
        v.versions.length === 6,
      `${undo.status} ${JSON.stringify(v.versions[0])}`,
    );

    // ---------------------------------------------------------- Outreach
    console.log('\n5. Outreach messages keep versions the same way');
    const lead = await db.lead.create({
      data: { companyId, name: 'Priya Shah', companyName: 'Corner Café' },
    });
    const msg = await db.outreachMessage.create({
      data: {
        leadId: lead.id,
        companyId,
        type: 'FOLLOWUP',
        status: 'DRAFT',
        draftText: 'Hi Priya — would you like a sample of this week’s roast?',
      },
    });
    const edit = await ownerC.req('PATCH', `/api/outreach/messages/${msg.id}`, {
      draftText: 'Hi Priya — happy to drop off a sample of this week’s roast.',
    });
    await ownerC.req('POST', `/api/outreach/messages/${msg.id}/status`, {
      action: 'approve',
    });
    const back = await ownerC.req(
      'POST',
      `/api/review/outreach/${msg.id}/versions`,
      { version: 1 },
    );
    const ov = await versionsOf(msg.id, 'outreach');
    const om = (await db.outreachMessage.findUnique({
      where: { id: msg.id },
    }))!;
    check(
      'original, edit and approved version are kept; restoring the original reopens it as v3',
      edit.status === 200 &&
        back.status === 200 &&
        ov.versions.map((x) => x.n).join(',') === '3,2,1' &&
        ov.approved === 2 &&
        om.draftText ===
          'Hi Priya — would you like a sample of this week’s roast?' &&
        om.status === 'DRAFT',
      `${edit.status} ${back.status} ${JSON.stringify(ov.versions.map((x) => [x.n, x.source, x.isApproved]))} ${om.status}`,
    );

    const page = await ownerC.page(`/dashboard/review/content/${draft.id}`);
    check(
      'the review screen lists the versions with Original, Current and Approved marked',
      page.status === 200 &&
        [
          'Versions',
          'Original',
          'Current',
          'Approved',
          'Make this current',
        ].every((t) => page.text.includes(t)),
    );
  } finally {
    await db.company
      .delete({ where: { id: companyId } })
      .catch(() => undefined);
    await db.company.delete({ where: { id: other.id } }).catch(() => undefined);
    for (const u of [owner, viewer, outsider])
      await db.user.delete({ where: { id: u.id } }).catch(() => undefined);
    console.log('  ok      cleanup: throwaway workspaces and users removed');
  }

  console.log(
    failures
      ? `\n${failures} version check(s) failed.`
      : '\nEdit & version management works end to end.',
  );
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
