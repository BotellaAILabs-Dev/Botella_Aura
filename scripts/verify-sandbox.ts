/**
 * The sandbox: Facebook Pages and Instagram publishing, end to end, on this
 * machine. Run by `npm run sandbox check`, which also runs the WhatsApp loop.
 *
 * Everything on Aura's side of the Meta boundary is the real thing here: the
 * approval gate, the execution routing, the permission and health checks, the
 * page-token exchange, the Instagram container-and-poll cycle, and what gets
 * recorded afterwards. Only Meta is replaced, by scripts/load/meta-stub.ts.
 *
 * What this does NOT prove: that Meta accepts this traffic. Nothing reaches a
 * Page or a phone. For that you need a real Meta app and a real approved
 * account. The point of a sandbox is to make everything else provable without
 * one, and to be explicit about the line.
 *
 *   Wiring       the app is pointed at the stand-in, and a base URL that is
 *                not this machine is refused — a token must never leave
 *   Facebook     a text post and a photo post, published and recorded, with
 *                the copy byte-for-byte as approved
 *   Instagram    a container, the poll until Meta has fetched the image, the
 *                publish, the permalink
 *   The gate     an unapproved draft is never published
 *
 * Run: npm run sandbox check     (with `npm run sandbox` already serving)
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { META_SCOPES } from '@/lib/meta';
import { graphBaseFrom, META_GRAPH_HOST, usingGraphStub } from '@/lib/graph-base';
import { publishDraft, publishTo } from '@/server/content/publish.service';
import { discoverAccounts } from '@/lib/connection-manager';
import { recordDiscoveredAccounts } from '@/server/connections/accounts';

const STUB = (process.env.STUB_URL ?? 'http://localhost:4010').replace(/\/$/, '');
const STAMP = Date.now();
const DAY = 86_400_000;

/** The ids the stub answers for; overridable the same way it is. */
const PAGE_ID = process.env.STUB_PAGE_ID ?? '111111111111111';
const PAGE_NAME = process.env.STUB_PAGE_NAME ?? 'Sandbox Page';
const IG_USER_ID = process.env.STUB_IG_USER_ID ?? '222222222222222';
const IG_USERNAME = process.env.STUB_IG_USERNAME ?? 'sandbox.ig';

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

interface StubPost {
  kind: 'facebook' | 'instagram';
  id: string;
  target: string;
  message: string | null;
  imageUrl: string | null;
  permalink: string;
}

async function stubPosts(kind?: string): Promise<StubPost[]> {
  const res = await fetch(`${STUB}/published${kind ? `?kind=${kind}` : ''}`);
  if (!res.ok) throw new Error(`stub /published answered HTTP ${res.status}`);
  return ((await res.json()) as { posts: StubPost[] }).posts;
}

const FB_COPY = `Our cold brew is back for the summer. Smooth and slow-steeped. ${STAMP}`;
const FB_PHOTO_COPY = `A photo post from the sandbox. ${STAMP}`;
const IG_COPY = `Instagram caption from the sandbox. ${STAMP}`;

async function main() {
  // ----------------------------------------------------------------- Wiring
  console.log('\n1. Wiring');

  const reachable = await fetch(`${STUB}/stats`)
    .then((r) => r.ok)
    .catch(() => false);
  check(
    `the local Meta stand-in answers on ${STUB}`,
    reachable,
    reachable ? '' : 'start it with `npm run sandbox`',
  );
  if (!reachable) {
    console.log('\nNothing else can run without it.');
    process.exitCode = 2;
    return;
  }

  check(
    'this process talks to the stand-in, not to Meta',
    usingGraphStub() && graphBaseFrom(process.env.META_GRAPH_BASE_URL) === STUB,
    `META_GRAPH_BASE_URL=${process.env.META_GRAPH_BASE_URL ?? '(unset)'}`,
  );

  /**
   * The rule that makes the whole thing safe to leave lying around: the
   * override is honoured only for this machine. Every Graph request carries
   * an access token, so a host that is not loopback has to be ignored —
   * including one that merely looks local.
   */
  const refused = [
    'https://graph.evil.example.com',
    'http://localhost.evil.example.com',
    'http://10.0.0.5:4010',
    'not a url',
  ];
  check(
    'a base URL that is not this machine is ignored in favour of Meta',
    refused.every((u) => graphBaseFrom(u) === META_GRAPH_HOST),
    refused.map((u) => `${u} -> ${graphBaseFrom(u)}`).join(' | '),
  );
  check(
    'loopback spellings are accepted',
    ['http://localhost:4010', 'http://127.0.0.1:4010'].every(
      (u) => graphBaseFrom(u) === u,
    ),
  );

  await fetch(`${STUB}/reset`, { method: 'POST' });

  // ------------------------------------------------------------- A workspace
  const passwordHash = await bcrypt.hash(`Zz-sandbox-${STAMP}!`, 10);
  const owner = await db.user.create({
    data: { email: `zzsandbox-${STAMP}@example.test`, passwordHash },
  });
  const company = await db.company.create({
    data: {
      name: `zzsandbox Cafe ${STAMP}`,
      slug: `zzsandbox-${STAMP}`,
      industry: 'Cafe',
    },
  });
  await db.companyMember.create({
    data: { userId: owner.id, companyId: company.id, role: 'OWNER' },
  });

  try {
    // A Meta connection whose ids are the ones the stand-in answers for. The
    // token is a throwaway string; the stub checks that one is sent, as Meta
    // does, but not what it says.
    const pages = [
      { id: PAGE_ID, name: PAGE_NAME, ig: { id: IG_USER_ID, username: IG_USERNAME } },
    ];
    const metadata = {
      fbUserId: 'stub-fb-user',
      pages,
      pageId: PAGE_ID,
      pageName: PAGE_NAME,
      igUserId: IG_USER_ID,
      igUsername: IG_USERNAME,
    };
    const connection = await db.connection.create({
      data: {
        companyId: company.id,
        connectorId: 'meta',
        kind: 'OAUTH',
        status: 'CONNECTED',
        accountLabel: `@${IG_USERNAME} (${PAGE_NAME})`,
        scope: META_SCOPES.join(' '),
        accessTokenEnc: encrypt('sandbox-user-token'),
        expiresAt: new Date(Date.now() + 50 * DAY),
        metadata: metadata as Prisma.InputJsonObject,
        provider: 'meta',
        channels: ['FACEBOOK', 'INSTAGRAM'],
        providerAccountId: 'stub-fb-user',
        scopes: [...META_SCOPES],
        setupStage: 'CONFIRMED',
        health: 'HEALTHY',
        confirmedAt: new Date(),
      },
    });
    await recordDiscoveredAccounts({
      connectionId: connection.id,
      companyId: company.id,
      accounts: discoverAccounts({
        connectorId: 'meta',
        accountLabel: PAGE_NAME,
        providerAccountId: 'stub-fb-user',
        metadata,
      }),
    });

    const draftFor = async (
      copy: string,
      platform: 'FACEBOOK' | 'INSTAGRAM',
      status: 'APPROVED' | 'DRAFT' = 'APPROVED',
    ) =>
      db.contentDraft.create({
        data: {
          companyId: company.id,
          type: 'IMAGE_POST',
          platform,
          status,
          title: `Sandbox ${platform}`,
          body: { caption: copy, cta: '', hashtags: [], altText: '' },
        },
      });

    /** An image the publisher can reference. The stub never fetches it. */
    const attachImage = async (draftId: string) => {
      const asset = await db.generatedAsset.create({
        data: {
          companyId: company.id,
          contentDraftId: draftId,
          createdById: owner.id,
          provider: 'GOOGLE',
          model: 'sandbox',
          kind: 'IMAGE',
          prompt: 'a sandbox image',
          aspectRatio: '1:1',
          width: 1080,
          height: 1080,
          mimeType: 'image/jpeg',
          fileSize: 240_000,
          data: Buffer.from('sandbox-jpeg-bytes'),
        },
      });
      await db.contentMedia.create({
        data: {
          companyId: company.id,
          contentDraftId: draftId,
          assetId: asset.id,
          kind: 'IMAGE',
          position: 0,
        },
      });
      return asset.id;
    };

    // --------------------------------------------------------- 2. Facebook
    console.log('\n2. Facebook Page');

    const fbText = await draftFor(FB_COPY, 'FACEBOOK');
    const fbResult = await publishTo({
      companyId: company.id,
      userId: owner.id,
      draft: fbText,
      platform: 'FACEBOOK',
    });
    check(
      'a text post is published',
      fbResult.mode === 'published',
      `${fbResult.mode}${'reason' in fbResult ? ` — ${fbResult.reason}` : ''}`,
    );

    const fbPhoto = await draftFor(FB_PHOTO_COPY, 'FACEBOOK');
    await attachImage(fbPhoto.id);
    const photoResult = await publishTo({
      companyId: company.id,
      userId: owner.id,
      draft: fbPhoto,
      platform: 'FACEBOOK',
    });
    check(
      'a photo post is published, and reports the story rather than the photo',
      photoResult.mode === 'published' &&
        Boolean(photoResult.externalId?.startsWith(PAGE_ID)),
      `${photoResult.mode} / ${'externalId' in photoResult ? photoResult.externalId : ''}`,
    );

    const fbPosts = await stubPosts('facebook');
    check(
      'both reached the Page, and the copy is exactly what was approved',
      fbPosts.length === 2 &&
        fbPosts.every((p) => p.target === PAGE_ID) &&
        fbPosts.some((p) => p.message === FB_COPY) &&
        fbPosts.some((p) => p.message === FB_PHOTO_COPY && p.imageUrl !== null),
      fbPosts.map((p) => `${p.id}:${String(p.message).slice(0, 40)}`).join(' | '),
    );
    check(
      'the permalink is recorded against the draft',
      Boolean(
        'url' in fbResult && fbResult.url && fbResult.url.includes('facebook.com'),
      ),
      'url' in fbResult ? String(fbResult.url) : '',
    );

    // -------------------------------------------------------- 3. Instagram
    console.log('\n3. Instagram');

    const igDraft = await draftFor(IG_COPY, 'INSTAGRAM');
    await attachImage(igDraft.id);
    const igResult = await publishTo({
      companyId: company.id,
      userId: owner.id,
      draft: igDraft,
      platform: 'INSTAGRAM',
    });
    /**
     * Instagram has no direct post endpoint: a container is created, polled
     * until Meta has fetched the image, then published. The stand-in holds a
     * container IN_PROGRESS for STUB_IG_PROCESSING_MS so that polling really
     * happens — and `processing` is a correct outcome too, the one where the
     * publish sweep finishes the job later.
     */
    check(
      'the container-and-publish cycle completes (or is handed to the sweep)',
      igResult.mode === 'published' || igResult.mode === 'processing',
      `${igResult.mode}${'reason' in igResult ? ` — ${igResult.reason}` : ''}`,
    );

    const stats = (await fetch(`${STUB}/stats`).then((r) => r.json())) as {
      igContainers: number;
      igPublished: number;
    };
    check(
      'a container was created',
      stats.igContainers === 1,
      `containers ${stats.igContainers}`,
    );

    if (igResult.mode === 'published') {
      const igPosts = await stubPosts('instagram');
      check(
        'the media is published with the approved caption',
        igPosts.length === 1 &&
          igPosts[0]!.target === IG_USER_ID &&
          igPosts[0]!.message === IG_COPY,
        igPosts.map((p) => `${p.id}:${String(p.message).slice(0, 40)}`).join(' | '),
      );
      check(
        'Instagram image posts carry a signed, app-served image URL',
        Boolean(igPosts[0]!.imageUrl?.includes('/api/content/graphics/')),
        String(igPosts[0]!.imageUrl).slice(0, 80),
      );
    } else {
      console.log(
        `          handed to the publish sweep (externalId ${'externalId' in igResult ? igResult.externalId : '?'}) — the container was created and is being processed`,
      );
    }

    // ---------------------------------------------------------- 4. The gate
    console.log('\n4. The approval gate still holds');

    /**
     * Through `publishDraft`, not `publishTo`. The checks above use the latter
     * on purpose — it is the per-network mechanic, and the mechanic is what a
     * sandbox exists to exercise. The gate is one layer up, where a click
     * actually enters: `publishDraft` refuses anything not APPROVED, and
     * `startMultiPublish` approves first and needs the permission to do it.
     * Asserting the gate against the mechanic says nothing about either.
     */
    const before = (await stubPosts()).length;
    const unapproved = await draftFor(`Never published. ${STAMP}`, 'FACEBOOK', 'DRAFT');
    let refusedPublish = 'nothing — it went through';
    try {
      const r = await publishDraft({
        companyId: company.id,
        userId: owner.id,
        draftId: unapproved.id,
      });
      refusedPublish = `published as "${r.mode}"`;
    } catch (err) {
      refusedPublish = err instanceof Error ? err.constructor.name : String(err);
    }
    check(
      'an unapproved draft is refused, even with a working connection',
      (await stubPosts()).length === before &&
        refusedPublish === 'InvalidTransitionError',
      refusedPublish,
    );
  } finally {
    await db.company.delete({ where: { id: company.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: owner.id } }).catch(() => undefined);
    console.log('  ok      cleanup: throwaway workspace and user removed');
  }

  console.log(
    failures === 0
      ? '\nThe sandbox works: Facebook Pages and Instagram publish end to end,\n' +
          'through the real publishers, against a local stand-in for Meta.\n' +
          'This does not prove Meta accepts our traffic — nothing left this machine.\n' +
          'For that: real META_* credentials, then `npm run verify:meta`.'
      : `\n${failures} sandbox check(s) BROKEN.`,
  );
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
