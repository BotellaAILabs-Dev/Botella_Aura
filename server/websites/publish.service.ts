import { Prisma, type CompanyRole, type ContentDraft, type WebsiteConnection, type WebsitePublication } from '@prisma/client';
import { z } from 'zod';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { can } from '@/lib/rbac';
import { validateScheduleTime } from '@/lib/timezone';
import { blogToHtml, defaultPublishOptions, type BlogImage, type PublishOptions } from '@/lib/blog-html';
import { nextSlot, isTimeOfDay } from '@/lib/website-schedule';
import { BLOG_PUBLISH_STATE_LABEL, websitePlatform, type BlogPublishState } from '@/lib/website-platforms';
import { blogSchema, type BlogBody } from '@/lib/validations/content';
import { assertContentIntact, contentHash } from '@/server/approval/approval.service';
import { getDraft, markPublished } from '@/server/content/content.service';
import { getAsset, readAssetBytes } from '@/server/media/asset.service';
import { signedAssetUrl } from '@/server/media/asset-url';
import { workspaceTimeZone } from '@/server/scheduling/schedule-input';
import { recordAudit } from '@/server/services/audit.service';
import { getAdapter } from '@/server/websites/registry';
import {
  listWebsites,
  recordSiteFailure,
  recordSiteSuccess,
  siteContext,
  WebsiteError,
  type WebsiteView,
} from '@/server/websites/connection.service';
import { WebsitePublishError, type PostImage, type PublishPayload, type RemoteState } from '@/server/websites/types';

/**
 * Publishing approved blogs to connected websites.
 *
 * Rules, the same for every platform:
 *
 *   APPROVED ONLY   Nothing reaches a website unless a person approved it,
 *                   and exactly what they approved (server/approval). The
 *                   scheduler and the recurring auto-publish check again at
 *                   the moment they run.
 *
 *   ONCE PER SITE   One WebsitePublication per (blog, website), claimed with
 *                   a compare-and-swap before the site is called, so two
 *                   clicks, two tabs or a click racing the scheduler cannot
 *                   run it twice.
 *
 *   NO DUPLICATES   The site's id for the post is saved the moment the post
 *                   exists (a checkpoint inside the adapter). A retry with an
 *                   id updates that post. A retry after an attempt whose
 *                   outcome is unknown (interrupted, timed out) first asks
 *                   the site whether the post is already there.
 *
 *   PEOPLE RETRY    The scheduler starts first attempts only. A failure is
 *                   explained and waits for a person's Retry.
 *
 *   AUTH FAILURES   Refused credentials mark the site "reconnect required"
 *                   and notify its admins once; its scheduled blogs wait.
 */

export const WEBSITE_PUBLISH_LEASE_MS = 3 * 60_000;
const LOG_MAX = 20;
/** Covers the whole publish: Shopify fetches images a little after being told. */
const IMAGE_URL_TTL_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v), 'Use a full https:// address.');

export const publishOptionsSchema = z
  .object({
    title: z.string().trim().min(1, 'A title is required.').max(200),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .max(120)
      .refine((v) => v === '' || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v), 'Use lowercase letters, numbers and hyphens.'),
    seoTitle: z.string().trim().max(300),
    metaDescription: z.string().trim().max(320),
    focusKeyword: z.string().trim().max(100),
    canonicalUrl: httpUrl,
    categories: z.array(z.string().trim().min(1).max(60)).max(10),
    tags: z.array(z.string().trim().min(1).max(60)).max(20),
    author: z.string().trim().max(200),
    blogId: z.string().trim().max(200),
    featuredImageAlt: z.string().trim().max(300),
    relatedLinks: z.array(z.object({ title: z.string().trim().min(1).max(200), url: httpUrl.refine((v) => v !== '', 'A link needs an address.') })).max(10),
  })
  .partial();

export type PublishOptionsInput = z.infer<typeof publishOptionsSchema>;

function blogBody(draft: ContentDraft): BlogBody {
  const parsed = blogSchema.safeParse(draft.body);
  if (!parsed.success) throw new WebsiteError('This blog’s content is incomplete — open it in Content Studio and fix it first.', 409);
  return parsed.data;
}

/** Defaults from the draft and the site, then what was chosen before, then this request. */
function resolveOptions(draft: ContentDraft, site: WebsiteConnection, previous: unknown, input: PublishOptionsInput | undefined, featuredAlt: string | null): PublishOptions {
  const settings = (site.settings ?? {}) as { categories?: string[]; author?: string; blogId?: string };
  const base = defaultPublishOptions(blogBody(draft), { featuredAlt, site: settings });
  const prior = publishOptionsSchema.safeParse(previous ?? {});
  const merged = { ...base, ...(prior.success ? prior.data : {}), ...(input ?? {}) } as PublishOptions;
  if (!merged.slug) merged.slug = base.slug;
  if (!merged.seoTitle) merged.seoTitle = merged.title;
  return merged;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface PublicationView {
  id: string;
  draftId: string;
  draftTitle: string;
  websiteId: string;
  websiteName: string;
  platform: string;
  platformName: string;
  status: WebsitePublication['status'];
  state: BlogPublishState;
  stateLabel: string;
  mode: string;
  scheduledFor: string | null;
  publishedAt: string | null;
  externalUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  viaSchedule: boolean;
  seoReport: Record<string, { outcome: string; note?: string }>;
  options: Record<string, unknown>;
  log: { at: string; status: string; message?: string }[];
  updatedAt: string;
  /** A person can retry it now. */
  retryable: boolean;
  /** A scheduled publish that can be called off. */
  cancellable: boolean;
}

export function publishState(status: WebsitePublication['status']): BlogPublishState {
  return ({ SCHEDULED: 'scheduled', PUBLISHING: 'publishing', PUBLISHED: 'published', DRAFTED: 'drafted', FAILED: 'failed', CANCELLED: 'cancelled' } as const)[status];
}

type PubWithRefs = WebsitePublication & { websiteConnection: WebsiteConnection; contentDraft: Pick<ContentDraft, 'title' | 'body'> };

function draftTitle(d: Pick<ContentDraft, 'title' | 'body'>): string {
  return d.title ?? ((d.body as { headline?: string } | null)?.headline || 'Untitled blog');
}

export function toPublicationView(p: PubWithRefs, now = new Date()): PublicationView {
  const state = publishState(p.status);
  const stale = p.status === 'PUBLISHING' && (!p.startedAt || now.getTime() - p.startedAt.getTime() >= WEBSITE_PUBLISH_LEASE_MS);
  return {
    id: p.id,
    draftId: p.contentDraftId,
    draftTitle: draftTitle(p.contentDraft),
    websiteId: p.websiteConnectionId,
    websiteName: p.websiteConnection.name,
    platform: p.websiteConnection.platform,
    platformName: websitePlatform(p.websiteConnection.platform)?.name ?? p.websiteConnection.platform,
    status: p.status,
    state,
    stateLabel: BLOG_PUBLISH_STATE_LABEL[state],
    mode: p.mode,
    scheduledFor: p.scheduledFor?.toISOString() ?? null,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    externalUrl: p.externalUrl,
    errorCode: p.errorCode,
    errorMessage: p.errorMessage,
    attempts: p.attempts,
    viaSchedule: p.viaSchedule,
    seoReport: (p.seoReport ?? {}) as PublicationView['seoReport'],
    options: (p.options ?? {}) as Record<string, unknown>,
    log: (Array.isArray(p.log) ? p.log : []) as PublicationView['log'],
    updatedAt: p.updatedAt.toISOString(),
    retryable: p.status === 'FAILED' || p.status === 'CANCELLED' || stale,
    cancellable: p.status === 'SCHEDULED',
  };
}

const withRefs = { websiteConnection: true, contentDraft: { select: { title: true, body: true } } } as const;

export async function listWebsitePublications(companyId: string, filter: { websiteId?: string; draftId?: string; take?: number } = {}): Promise<PublicationView[]> {
  const rows = await db.websitePublication.findMany({
    where: { companyId, ...(filter.websiteId ? { websiteConnectionId: filter.websiteId } : {}), ...(filter.draftId ? { contentDraftId: filter.draftId } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: Math.min(filter.take ?? 100, 200),
    include: withRefs,
  });
  return rows.map((r) => toPublicationView(r));
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** The blog's attached images, in order: the first is the featured image. */
async function loadBlogImages(companyId: string, draftId: string, headline: string, slug: string): Promise<PostImage[]> {
  const rows = await db.contentMedia.findMany({
    where: { companyId, contentDraftId: draftId, asset: { kind: 'IMAGE' } },
    orderBy: { position: 'asc' },
    include: { asset: { select: { id: true, mimeType: true } } },
  });
  return rows.map((row, i) => ({
    assetId: row.assetId,
    mimeType: row.asset.mimeType,
    filename: `${slug || 'blog'}-${i + 1}`,
    alt: row.altText?.trim() || headline,
    bytes: async () => readAssetBytes(await getAsset(companyId, row.assetId)),
    publicUrl: () => signedAssetUrl(row.assetId, IMAGE_URL_TTL_MS, row.asset.mimeType === 'image/webp' ? { format: 'jpeg' } : {}).url,
  }));
}

/** The featured image's alt text (the first attached image), for the defaults. */
async function featuredAlt(companyId: string, draftId: string): Promise<string | null> {
  const first = await db.contentMedia.findFirst({
    where: { companyId, contentDraftId: draftId, asset: { kind: 'IMAGE' } },
    orderBy: { position: 'asc' },
    select: { altText: true },
  });
  return first?.altText?.trim() || null;
}

/** Where relative links point: the storefront for Shopify, else the site. */
function linkBase(site: WebsiteConnection): string {
  return String((site.capabilities as { storefrontUrl?: string } | null)?.storefrontUrl ?? site.siteUrl);
}

// ---------------------------------------------------------------------------
// What a blog's publish panel shows
// ---------------------------------------------------------------------------

export interface DraftWebsiteState {
  website: WebsiteView;
  state: BlogPublishState;
  stateLabel: string;
  publication: PublicationView | null;
  /** Why it can't be published there right now. */
  blockers: string[];
  options: PublishOptions;
}

export async function draftPublishingState(companyId: string, draftId: string) {
  const draft = await getDraft(companyId, draftId);
  if (!draft) throw new WebsiteError('Not found.', 404);
  if (draft.type !== 'BLOG') throw new WebsiteError('Only blogs are published to websites.', 409);
  const body = blogBody(draft);
  const approved = draft.status === 'APPROVED' || draft.status === 'PUBLISHED';
  const [websites, rows, sites] = await Promise.all([
    listWebsites(companyId),
    db.websitePublication.findMany({ where: { companyId, contentDraftId: draftId }, include: withRefs }),
    db.websiteConnection.findMany({ where: { companyId, status: { not: 'DISCONNECTED' } } }),
  ]);
  const images = await loadBlogImages(companyId, draftId, body.headline, '');
  const featured = images[0] ?? null;
  const draftBlockers: string[] = [];
  if (!approved) draftBlockers.push('Approve this blog first — only approved blogs are published.');
  if (draft.status === 'APPROVED') {
    await assertContentIntact(draft).catch(() => draftBlockers.push('It changed after it was approved. Approve it again.'));
  }

  const perSite: DraftWebsiteState[] = websites.map((w) => {
    const row = rows.find((r) => r.websiteConnectionId === w.id);
    const publication = row ? toPublicationView(row) : null;
    const site = sites.find((s) => s.id === w.id)!;
    const blockers = [...draftBlockers];
    if (w.state === 'reauth') blockers.push(`Reconnect ${w.name} first: ${w.lastError ?? 'it refused the stored credentials.'}`);
    if (!getAdapter(w.platform)) blockers.push(`${w.platformName} publishing isn’t available.`);
    if (publication?.status === 'PUBLISHING' && !publication.retryable) blockers.push('Being published right now.');
    const state: BlogPublishState = publication
      ? publication.state
      : w.state === 'reauth' || !getAdapter(w.platform)
        ? 'not_connected'
        : draftBlockers.length
          ? 'awaiting_approval'
          : 'ready';
    return {
      website: w,
      state,
      stateLabel: BLOG_PUBLISH_STATE_LABEL[state],
      publication,
      blockers,
      options: resolveOptions(draft, site, row?.options, undefined, featured?.alt ?? null),
    };
  });

  const previewHtml = blogToHtml({
    body,
    inlineImages: images.slice(1).map((img) => ({ url: img.publicUrl(), alt: img.alt })),
    siteUrl: sites[0] ? linkBase(sites[0]) : null,
  });
  return {
    draft: { id: draft.id, status: draft.status, title: draftTitle(draft) },
    approved,
    blockers: draftBlockers,
    websites: perSite,
    featuredImage: featured ? { url: featured.publicUrl(), alt: featured.alt } : null,
    inlineImages: images.length > 1 ? images.length - 1 : 0,
    previewHtml,
    timeZone: await workspaceTimeZone(companyId),
  };
}

/** The exact HTML a website would receive, with this request's links. */
export async function previewForWebsite(companyId: string, draftId: string, websiteId: string, input?: PublishOptionsInput) {
  const draft = await getDraft(companyId, draftId);
  if (!draft) throw new WebsiteError('Not found.', 404);
  const site = await db.websiteConnection.findFirst({ where: { id: websiteId, companyId } });
  if (!site) throw new WebsiteError('That website isn’t connected.', 404);
  const body = blogBody(draft);
  const images = await loadBlogImages(companyId, draftId, body.headline, '');
  const options = resolveOptions(draft, site, null, input, images[0]?.alt ?? null);
  return {
    options,
    html: blogToHtml({
      body,
      inlineImages: images.slice(1).map((img) => ({ url: img.publicUrl(), alt: img.alt })),
      siteUrl: linkBase(site),
      relatedLinks: options.relatedLinks,
    }),
  };
}

// ---------------------------------------------------------------------------
// Claiming — the one place a publication changes hands
// ---------------------------------------------------------------------------

type ClaimRefusal = 'in_progress' | 'needs_person' | 'not_due';
type Claim = { claimed: true; publication: WebsitePublication } | { claimed: false; reason: ClaimRefusal; publication: WebsitePublication };

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

function logEntry(log: unknown, status: string, message?: string | null, at = new Date()): Prisma.InputJsonValue {
  const list = Array.isArray(log) ? (log as object[]) : [];
  return [...list, { at: at.toISOString(), status, ...(message ? { message: message.slice(0, 500) } : {}) }].slice(-LOG_MAX) as Prisma.InputJsonValue;
}

interface ClaimInput {
  companyId: string;
  draftId: string;
  websiteId: string;
  userId: string | null;
  /** The scheduler: may only start a SCHEDULED publication whose time has come. */
  automatic?: boolean;
  /** Set on the claimed row (a person's request). The scheduler uses what was stored. */
  set?: { mode: 'publish' | 'draft'; options: PublishOptions; contentHash: string };
  now?: Date;
}

export async function claimWebsitePublication(input: ClaimInput): Promise<Claim> {
  const now = input.now ?? new Date();
  const key = { contentDraftId_websiteConnectionId: { contentDraftId: input.draftId, websiteConnectionId: input.websiteId } };
  // A person publishing now replaces whatever schedule it had.
  const fields = input.set
    ? { mode: input.set.mode, options: input.set.options as unknown as Prisma.InputJsonValue, contentHash: input.set.contentHash, scheduledFor: null }
    : {};
  for (let round = 0; round < 3; round++) {
    const existing = await db.websitePublication.findUnique({ where: key });
    if (!existing) {
      if (input.automatic) throw new Error('The scheduler only runs publications that exist.');
      try {
        const publication = await db.websitePublication.create({
          data: {
            companyId: input.companyId,
            contentDraftId: input.draftId,
            websiteConnectionId: input.websiteId,
            status: 'PUBLISHING',
            startedAt: now,
            attempts: 1,
            requestedById: input.userId,
            log: logEntry([], 'PUBLISHING', null, now),
            ...fields,
          },
        });
        return { claimed: true, publication };
      } catch (e) {
        if (isUnique(e)) continue; // a concurrent request created it — look again
        throw e;
      }
    }
    if (existing.status === 'PUBLISHING') {
      const fresh = existing.startedAt && now.getTime() - existing.startedAt.getTime() < WEBSITE_PUBLISH_LEASE_MS;
      if (fresh || input.automatic) return { claimed: false, reason: fresh ? 'in_progress' : 'needs_person', publication: existing };
    } else if (input.automatic) {
      if (existing.status !== 'SCHEDULED') return { claimed: false, reason: 'needs_person', publication: existing };
      if (!existing.scheduledFor || existing.scheduledFor.getTime() > now.getTime()) return { claimed: false, reason: 'not_due', publication: existing };
    }
    const won = await db.websitePublication.updateMany({
      where: { id: existing.id, status: existing.status, updatedAt: existing.updatedAt },
      data: {
        status: 'PUBLISHING',
        startedAt: now,
        attempts: existing.attempts + 1,
        errorCode: null,
        errorMessage: null,
        ...(input.automatic ? {} : { requestedById: input.userId }),
        log: logEntry(existing.log, 'PUBLISHING', existing.status === 'PUBLISHING' ? 'Resuming an interrupted attempt — the site is checked for the post first.' : null, now),
        ...fields,
      },
    });
    if (won.count === 1) return { claimed: true, publication: (await db.websitePublication.findUnique({ where: key }))! };
  }
  return { claimed: false, reason: 'in_progress', publication: (await db.websitePublication.findUnique({ where: key }))! };
}

// ---------------------------------------------------------------------------
// Running one publication
// ---------------------------------------------------------------------------

function asPublishError(err: unknown, siteName: string): WebsitePublishError {
  if (err instanceof WebsitePublishError) return err;
  if ((err as Error)?.name === 'UnsafeUrlError') return new WebsitePublishError('validation', (err as Error).message);
  logger.error('websites: unexpected publish error', { error: err instanceof Error ? err.stack ?? err.message : String(err) });
  return new WebsitePublishError('unknown', `Something went wrong publishing to ${siteName}: ${err instanceof Error ? err.message : String(err)}`);
}

/** The failure, with what to do about it. */
export function actionableMessage(err: WebsitePublishError, siteName: string): string {
  const next: Record<WebsitePublishError['code'], string> = {
    auth: `Reconnect ${siteName} in Settings → Website publishing, then press Retry.`,
    permission: 'Change the account’s permissions on the site, then press Retry.',
    validation: 'Fix that, then press Retry.',
    rate_limit: 'Press Retry in a few minutes.',
    network: 'Check the site is online, then press Retry — the post is never created twice.',
    not_found: 'Check the publishing settings for this site, then press Retry.',
    unknown: 'Press Retry — Aura checks the site first, so the post is never created twice.',
  };
  return `${err.message} ${next[err.code]}`.trim();
}

async function finish(pub: WebsitePublication, data: Prisma.WebsitePublicationUpdateManyMutationInput, status: string, message?: string | null) {
  await db.websitePublication.updateMany({
    where: { id: pub.id, status: 'PUBLISHING' },
    data: { ...data, startedAt: null, log: logEntry(pub.log, status, message) },
  });
}

async function fail(pub: WebsitePublication, site: WebsiteConnection, err: WebsitePublishError, userId: string | null) {
  const message = actionableMessage(err, site.name);
  await finish(pub, { status: 'FAILED', errorCode: err.code, errorMessage: message.slice(0, 2000) }, 'FAILED', message);
  await recordSiteFailure(site, err).catch(() => undefined);
  await recordAudit({
    action: 'WEBSITE_PUBLISH_FAILED',
    userId,
    companyId: pub.companyId,
    metadata: { publicationId: pub.id, draftId: pub.contentDraftId, websiteId: site.id, platform: site.platform, code: err.code, message: err.message.slice(0, 300) },
  });
}

/** The approval gate, checked when the publish actually runs. */
async function assertStillApproved(draft: ContentDraft | null): Promise<ContentDraft> {
  if (!draft || draft.type !== 'BLOG') throw new WebsitePublishError('not_found', 'The blog no longer exists.');
  if (draft.status !== 'APPROVED' && draft.status !== 'PUBLISHED') {
    throw new WebsitePublishError('validation', 'The blog isn’t approved any more (it was edited or sent back). Approve it again.');
  }
  if (draft.status === 'APPROVED') {
    try {
      await assertContentIntact(draft);
    } catch {
      throw new WebsitePublishError('validation', 'The blog changed after it was approved. Approve it again.');
    }
  }
  return draft;
}

async function runClaimed(pub: WebsitePublication, userId: string | null): Promise<WebsitePublication> {
  const site = await db.websiteConnection.findUniqueOrThrow({ where: { id: pub.websiteConnectionId } });
  try {
    const draft = await assertStillApproved(await getDraft(pub.companyId, pub.contentDraftId));
    const adapter = getAdapter(site.platform);
    if (!adapter) throw new WebsitePublishError('validation', `${websitePlatform(site.platform)?.name ?? site.platform} publishing isn’t available.`);
    if (site.status === 'DISCONNECTED' || site.status === 'REAUTH_REQUIRED') {
      throw new WebsitePublishError('auth', `${site.name} needs to be reconnected before Aura can publish to it.`);
    }
    const ctx = siteContext(site);
    const body = blogBody(draft);
    const loaded = await loadBlogImages(pub.companyId, draft.id, body.headline, '');
    const options = resolveOptions(draft, site, pub.options, undefined, loaded[0]?.alt ?? null);
    const images = loaded.map((img, i) => ({ ...img, filename: `${options.slug || 'blog'}-${i + 1}` }));
    const featured = images[0] ? { ...images[0], alt: options.featuredImageAlt || images[0].alt } : null;
    const payload: PublishPayload = {
      publicationId: pub.id,
      body,
      options,
      mode: pub.mode === 'draft' ? 'draft' : 'publish',
      featured,
      inline: images.slice(1),
      html: (inline: BlogImage[]) => blogToHtml({ body, inlineImages: inline, siteUrl: linkBase(site), relatedLinks: options.relatedLinks }),
      since: pub.createdAt,
    };

    // No id yet, but not the first attempt: the last one may have created
    // the post before failing. Ask the site rather than risk a duplicate.
    let existing = pub.externalId ? { externalId: pub.externalId } : null;
    if (!existing && pub.attempts > 1) {
      existing = await adapter.findExisting(ctx, { publicationId: pub.id, title: options.title, slug: options.slug, since: pub.createdAt });
    }

    const state = structuredClone((pub.remoteState ?? {}) as RemoteState);
    const checkpoint = async (patch: { externalId?: string; remoteState?: RemoteState }) => {
      await db.websitePublication.updateMany({
        where: { id: pub.id, status: 'PUBLISHING' },
        data: {
          ...(patch.externalId ? { externalId: patch.externalId } : {}),
          ...(patch.remoteState ? { remoteState: patch.remoteState as Prisma.InputJsonValue } : {}),
          // Progress renews the lease, so a slow site is not mistaken for an interrupted one.
          startedAt: new Date(),
        },
      });
    };

    const outcome = await adapter.publish(ctx, payload, existing, state, checkpoint);
    const now = new Date();
    const status = outcome.status === 'published' ? 'PUBLISHED' : 'DRAFTED';
    await finish(
      pub,
      {
        status,
        externalId: outcome.externalId,
        externalUrl: outcome.url,
        ...(status === 'PUBLISHED' ? { publishedAt: now } : {}),
        seoReport: outcome.seoReport as Prisma.InputJsonValue,
        remoteState: (outcome.remoteState ?? state) as Prisma.InputJsonValue,
        errorCode: null,
        errorMessage: null,
      },
      status,
      outcome.url,
    );
    if (site.status !== 'CONNECTED') await recordSiteSuccess(site);
    await recordAudit({
      action: 'WEBSITE_PUBLISHED',
      userId,
      companyId: pub.companyId,
      metadata: { publicationId: pub.id, draftId: draft.id, websiteId: site.id, platform: site.platform, status, url: outcome.url, updatedExisting: Boolean(existing) },
    });
    // The blog is "published" in Content Studio once it is live somewhere.
    if (status === 'PUBLISHED' && draft.status === 'APPROVED') {
      await markPublished({ companyId: pub.companyId, userId, draftId: draft.id, publishedUrl: outcome.url }).catch((err) =>
        logger.warn('websites: draft not marked published', { draftId: draft.id, error: err instanceof Error ? err.message : String(err) }),
      );
    }
  } catch (err) {
    await fail(pub, site, asPublishError(err, site.name), userId);
  }
  return (await db.websitePublication.findUnique({ where: { id: pub.id } }))!;
}

async function viewOf(id: string): Promise<PublicationView> {
  return toPublicationView(await db.websitePublication.findUniqueOrThrow({ where: { id }, include: withRefs }));
}

// ---------------------------------------------------------------------------
// A person's actions
// ---------------------------------------------------------------------------

export type PublishWhen = { kind: 'now' } | { kind: 'later'; at: Date };

export async function requestWebsitePublish(args: {
  companyId: string;
  userId: string;
  role: CompanyRole;
  draftId: string;
  websiteId: string;
  mode: 'publish' | 'draft';
  when: PublishWhen;
  options?: PublishOptionsInput;
}): Promise<PublicationView> {
  if (!can(args.role, 'content:publish')) throw new WebsiteError('Only owners and admins can publish.', 403);
  const draft = await getDraft(args.companyId, args.draftId);
  if (!draft) throw new WebsiteError('Not found.', 404);
  if (draft.type !== 'BLOG') throw new WebsiteError('Only blogs are published to websites.', 409);
  if (draft.status !== 'APPROVED' && draft.status !== 'PUBLISHED') {
    throw new WebsiteError('Approve this blog first — only approved blogs are published to websites.', 409);
  }
  if (draft.status === 'APPROVED') await assertContentIntact(draft);

  const site = await db.websiteConnection.findFirst({ where: { id: args.websiteId, companyId: args.companyId } });
  if (!site || site.status === 'DISCONNECTED') throw new WebsiteError('That website isn’t connected.', 404);
  if (site.status === 'REAUTH_REQUIRED') throw new WebsiteError(`Reconnect ${site.name} first: ${site.lastError ?? 'it refused the stored credentials.'}`, 409);
  const platform = websitePlatform(site.platform);
  if (!getAdapter(site.platform) || !platform) throw new WebsiteError(`${platform?.name ?? site.platform} publishing isn’t available.`, 409);
  if (args.mode === 'draft' && !platform.supportsDraft) throw new WebsiteError(`${platform.name} can’t hold unpublished drafts.`, 409);

  const existing = await db.websitePublication.findUnique({
    where: { contentDraftId_websiteConnectionId: { contentDraftId: draft.id, websiteConnectionId: site.id } },
  });
  const options = resolveOptions(draft, site, existing?.options, args.options, await featuredAlt(args.companyId, draft.id));
  const hash = await contentHash(draft);
  await recordAudit({
    action: 'WEBSITE_PUBLISH_REQUESTED',
    userId: args.userId,
    companyId: args.companyId,
    metadata: { draftId: draft.id, websiteId: site.id, platform: site.platform, mode: args.mode, when: args.when.kind === 'later' ? args.when.at.toISOString() : 'now' },
  });

  if (args.when.kind === 'later') {
    const check = validateScheduleTime(args.when.at);
    if (!check.ok) throw new WebsiteError(check.message, 422);
    if (existing?.status === 'PUBLISHING') throw new WebsiteError('This is being published right now — try again in a moment.', 409);
    const data = {
      status: 'SCHEDULED' as const,
      scheduledFor: args.when.at,
      mode: args.mode,
      options: options as unknown as Prisma.InputJsonValue,
      contentHash: hash,
      viaSchedule: false,
      errorCode: null,
      errorMessage: null,
      requestedById: args.userId,
    };
    const row = existing
      ? await db.websitePublication.update({ where: { id: existing.id }, data: { ...data, log: logEntry(existing.log, 'SCHEDULED', args.when.at.toISOString()) } })
      : await db.websitePublication.create({
          data: { ...data, companyId: args.companyId, contentDraftId: draft.id, websiteConnectionId: site.id, log: logEntry([], 'SCHEDULED', args.when.at.toISOString()) },
        });
    return viewOf(row.id);
  }

  const claim = await claimWebsitePublication({
    companyId: args.companyId,
    draftId: draft.id,
    websiteId: site.id,
    userId: args.userId,
    set: { mode: args.mode, options, contentHash: hash },
  });
  if (!claim.claimed) throw new WebsiteError('This is being published right now — refresh in a moment.', 409);
  const done = await runClaimed(claim.publication, args.userId);
  return viewOf(done.id);
}

/** Retry a failed (or interrupted, or cancelled) publication, as it was asked for. */
export async function retryWebsitePublication(args: { companyId: string; userId: string; role: CompanyRole; publicationId: string }): Promise<PublicationView> {
  if (!can(args.role, 'content:publish')) throw new WebsiteError('Only owners and admins can publish.', 403);
  const pub = await db.websitePublication.findFirst({ where: { id: args.publicationId, companyId: args.companyId } });
  if (!pub) throw new WebsiteError('Not found.', 404);
  if (pub.status === 'PUBLISHED' || pub.status === 'DRAFTED') throw new WebsiteError('This already went through — nothing to retry.', 409);
  const site = await db.websiteConnection.findUniqueOrThrow({ where: { id: pub.websiteConnectionId } });
  if (site.status === 'REAUTH_REQUIRED' || site.status === 'DISCONNECTED') {
    throw new WebsiteError(`Reconnect ${site.name} first, then retry.`, 409);
  }
  const claim = await claimWebsitePublication({ companyId: args.companyId, draftId: pub.contentDraftId, websiteId: pub.websiteConnectionId, userId: args.userId });
  if (!claim.claimed) throw new WebsiteError('This is being published right now — refresh in a moment.', 409);
  const done = await runClaimed(claim.publication, args.userId);
  return viewOf(done.id);
}

export async function cancelWebsitePublication(args: { companyId: string; userId: string; role: CompanyRole; publicationId: string }): Promise<PublicationView> {
  if (!can(args.role, 'content:publish')) throw new WebsiteError('Only owners and admins can change publishing.', 403);
  const pub = await db.websitePublication.findFirst({ where: { id: args.publicationId, companyId: args.companyId } });
  if (!pub) throw new WebsiteError('Not found.', 404);
  const done = await db.websitePublication.updateMany({
    where: { id: pub.id, status: 'SCHEDULED' },
    data: { status: 'CANCELLED', log: logEntry(pub.log, 'CANCELLED', 'Called off by a person.') },
  });
  if (done.count === 0) throw new WebsiteError('Only a scheduled publish can be cancelled.', 409);
  return viewOf(pub.id);
}

// ---------------------------------------------------------------------------
// Recurring auto-publish
// ---------------------------------------------------------------------------

export const scheduleInputSchema = z.object({
  enabled: z.boolean(),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7),
  timeOfDay: z.string().refine(isTimeOfDay, 'Use a 24-hour time like 09:00.'),
  mode: z.enum(['publish', 'draft']),
  postsPerSlot: z.number().int().min(1).max(5),
});

export async function getWebsiteSchedule(companyId: string, websiteId: string) {
  const site = await db.websiteConnection.findFirst({ where: { id: websiteId, companyId } });
  if (!site) throw new WebsiteError('That website isn’t connected.', 404);
  const schedule = await db.websitePublishSchedule.findUnique({ where: { websiteConnectionId: websiteId } });
  return {
    schedule: schedule
      ? { enabled: schedule.enabled, weekdays: schedule.weekdays, timeOfDay: schedule.timeOfDay, mode: schedule.mode, postsPerSlot: schedule.postsPerSlot, nextRunAt: schedule.nextRunAt?.toISOString() ?? null, lastRunAt: schedule.lastRunAt?.toISOString() ?? null }
      : { enabled: false, weekdays: [2, 4], timeOfDay: '09:00', mode: 'publish', postsPerSlot: 1, nextRunAt: null, lastRunAt: null },
    queue: await autoPublishQueue(companyId, websiteId, 5),
    timeZone: await workspaceTimeZone(companyId),
  };
}

/** Approved blogs not yet sent to this website, in the order auto-publish takes them. */
export async function autoPublishQueue(companyId: string, websiteId: string, take: number) {
  const drafts = await db.contentDraft.findMany({
    where: { companyId, type: 'BLOG', status: 'APPROVED', websitePublications: { none: { websiteConnectionId: websiteId } } },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take,
    select: { id: true, title: true, body: true, updatedAt: true },
  });
  return drafts.map((d) => ({ id: d.id, title: draftTitle(d), approvedAt: d.updatedAt.toISOString() }));
}

export async function saveWebsiteSchedule(args: { companyId: string; userId: string; role: CompanyRole; websiteId: string; input: z.infer<typeof scheduleInputSchema> }) {
  if (!can(args.role, 'content:publish')) throw new WebsiteError('Only owners and admins can set auto-publishing.', 403);
  const site = await db.websiteConnection.findFirst({ where: { id: args.websiteId, companyId: args.companyId } });
  if (!site || site.status === 'DISCONNECTED') throw new WebsiteError('That website isn’t connected.', 404);
  const { input } = args;
  if (input.enabled && input.weekdays.length === 0) throw new WebsiteError('Choose at least one day.', 422);
  const timeZone = await workspaceTimeZone(args.companyId);
  const nextRunAt = input.enabled ? nextSlot(new Date(), input.weekdays, input.timeOfDay, timeZone) : null;
  const data = { ...input, weekdays: [...new Set(input.weekdays)].sort(), nextRunAt };
  await db.websitePublishSchedule.upsert({
    where: { websiteConnectionId: site.id },
    create: { ...data, companyId: args.companyId, websiteConnectionId: site.id },
    update: data,
  });
  await recordAudit({ action: 'WEBSITE_SCHEDULE_UPDATED', userId: args.userId, companyId: args.companyId, metadata: { websiteId: site.id, ...data, nextRunAt: nextRunAt?.toISOString() ?? null } });
  return getWebsiteSchedule(args.companyId, site.id);
}

/**
 * Due recurring slots: queue the next approved blogs for each site. Each slot
 * is claimed by moving nextRunAt on (compare-and-swap), so overlapping runs
 * queue it once; the unique (blog, website) key means a blog is queued once.
 */
async function queueRecurring(now: Date): Promise<number> {
  const due = await db.websitePublishSchedule.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    include: { websiteConnection: true, company: { select: { timezone: true } } },
    take: 50,
  });
  let queued = 0;
  for (const s of due) {
    const next = nextSlot(now, s.weekdays, s.timeOfDay, s.company.timezone || 'UTC');
    const won = await db.websitePublishSchedule.updateMany({ where: { id: s.id, nextRunAt: s.nextRunAt }, data: { nextRunAt: next, lastRunAt: now } });
    if (won.count !== 1) continue;
    const site = s.websiteConnection;
    if (site.status === 'DISCONNECTED' || site.status === 'REAUTH_REQUIRED') continue;
    const picks = await db.contentDraft.findMany({
      where: { companyId: s.companyId, type: 'BLOG', status: 'APPROVED', websitePublications: { none: { websiteConnectionId: site.id } } },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: s.postsPerSlot,
    });
    for (const draft of picks) {
      try {
        await assertContentIntact(draft);
        await db.websitePublication.create({
          data: {
            companyId: s.companyId,
            contentDraftId: draft.id,
            websiteConnectionId: site.id,
            status: 'SCHEDULED',
            scheduledFor: now,
            mode: s.mode,
            viaSchedule: true,
            options: resolveOptions(draft, site, null, undefined, await featuredAlt(s.companyId, draft.id)) as unknown as Prisma.InputJsonValue,
            contentHash: await contentHash(draft),
            log: logEntry([], 'SCHEDULED', 'Queued by the auto-publish schedule.', now),
          },
        });
        queued++;
      } catch (err) {
        if (!isUnique(err)) logger.warn('websites: recurring pick skipped', { draftId: draft.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return queued;
}

/**
 * The scheduled-publish job's website part (called from /api/cron/publish).
 * Safe to run often and concurrently: every publication is claimed first.
 */
export async function runDueWebsitePublishing(
  now: Date = new Date(),
  opts: { deadline?: Date; limit?: number } = {},
): Promise<{ queued: number; attempted: number; published: number; failed: number; waiting: number; interrupted: number; deferred: number }> {
  // 1. Attempts that never finished: a person decides (Retry checks the site first).
  const stale = await db.websitePublication.findMany({
    where: { status: 'PUBLISHING', startedAt: { lt: new Date(now.getTime() - WEBSITE_PUBLISH_LEASE_MS) } },
    take: 50,
  });
  let interrupted = 0;
  for (const p of stale) {
    const r = await db.websitePublication.updateMany({
      where: { id: p.id, status: 'PUBLISHING', updatedAt: p.updatedAt },
      data: {
        status: 'FAILED',
        errorCode: 'unknown',
        errorMessage: 'The last attempt was interrupted before the site answered. Press Retry — Aura checks the site for the post first, so it is never created twice.',
        startedAt: null,
        log: logEntry(p.log, 'FAILED', 'Interrupted.', now),
      },
    });
    interrupted += r.count;
  }

  // 2. Recurring slots become scheduled publications.
  const queued = await queueRecurring(now);

  // 3. Due publications, oldest first.
  const due = await db.websitePublication.findMany({
    where: { status: 'SCHEDULED', scheduledFor: { lte: now } },
    orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
    include: { websiteConnection: { select: { status: true } } },
    take: opts.limit ?? 25,
  });
  let attempted = 0;
  let published = 0;
  let failed = 0;
  let waiting = 0;
  let deferred = 0;
  for (const p of due) {
    if (opts.deadline && Date.now() >= opts.deadline.getTime()) {
      deferred++;
      continue;
    }
    // A site that needs reconnecting: its blogs wait for it (people were told).
    if (p.websiteConnection.status === 'REAUTH_REQUIRED' || p.websiteConnection.status === 'DISCONNECTED') {
      waiting++;
      continue;
    }
    const claim = await claimWebsitePublication({ companyId: p.companyId, draftId: p.contentDraftId, websiteId: p.websiteConnectionId, userId: null, automatic: true, now });
    if (!claim.claimed) continue;
    attempted++;
    const done = await runClaimed(claim.publication, null);
    if (done.status === 'PUBLISHED' || done.status === 'DRAFTED') published++;
    else failed++;
  }
  return { queued, attempted, published, failed, waiting, interrupted, deferred };
}

