import type { BlogImage, PublishOptions } from '@/lib/blog-html';
import type { SeoField } from '@/lib/website-platforms';
import type { BlogBody } from '@/lib/validations/content';

/**
 * The contract every website platform implements (server/websites/adapters).
 *
 * An adapter only talks to its platform. Everything around it — which drafts
 * may go, claiming a publication so it runs once, retries, scheduling,
 * history, what happens to the connection when credentials are refused — is
 * shared (server/websites/publish.service.ts), so a new platform is one file.
 */

/**
 * Why a publish failed, as the person needs to act on it:
 *   auth        credentials refused / revoked / expired → reconnect
 *   permission  connected, but the account may not do this (role, scope)
 *   validation  the site rejected what was sent (a field, a size)
 *   rate_limit  the site said slow down → retry later
 *   network     the site could not be reached / timed out / 5xx
 *   not_found   the thing referred to is gone (a blog, an author)
 *   unknown     anything else
 */
export type PublishErrorCode = 'auth' | 'permission' | 'validation' | 'rate_limit' | 'network' | 'not_found' | 'unknown';

export class WebsitePublishError extends Error {
  constructor(
    readonly code: PublishErrorCode,
    message: string,
    readonly providerStatus?: number,
  ) {
    super(message);
    this.name = 'WebsitePublishError';
  }
}

/** Decrypted credentials + non-secret state for one connected site. */
export interface SiteContext {
  siteUrl: string;
  /** How it authenticated (WebsiteConnection.authKind). */
  authKind?: string;
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
  capabilities: Record<string, unknown>;
}

export interface ConnectResult {
  siteUrl: string;
  accountLabel: string;
  authKind: string;
  /** Encrypted before storage; never leaves the server. */
  credentials: Record<string, string>;
  capabilities: Record<string, unknown>;
  /** Initial publishing defaults (the connecting user as author…). */
  settings?: Record<string, unknown>;
}

export interface Choice {
  id: string;
  name: string;
}

/** Live choices from the site for the publish form. */
export interface SiteOptions {
  categories?: Choice[];
  authors?: Choice[];
  blogs?: Choice[];
  /** The site's own recent posts — internal-link suggestions. */
  recentPosts?: { title: string; url: string }[];
}

export interface PostImage {
  assetId: string;
  mimeType: string;
  filename: string;
  alt: string;
  bytes: () => Promise<Buffer | null>;
  /** A short-lived public URL, for platforms that fetch the image themselves. */
  publicUrl: () => string;
}

/** What earlier attempts already created on the site, reused on retry. */
export interface RemoteState {
  /** assetId → the site's media id and URL. */
  media?: Record<string, { id: string; url: string }>;
  /** "category:Name" / "tag:Name" → the site's term id. */
  terms?: Record<string, string>;
  [key: string]: unknown;
}

export type SeoOutcome = 'applied' | 'fallback' | 'unsupported' | 'empty';

export type SeoReport = Partial<Record<SeoField, { outcome: SeoOutcome; note?: string }>>;

export interface PublishPayload {
  publicationId: string;
  body: BlogBody;
  options: PublishOptions;
  mode: 'publish' | 'draft';
  featured: PostImage | null;
  inline: PostImage[];
  /** The body as HTML, once the adapter knows where the inline images live. */
  html: (inlineImages: BlogImage[]) => string;
  /** When this publication was first attempted — for finding it on the site. */
  since: Date;
}

export interface PublishOutcome {
  externalId: string;
  url: string | null;
  status: 'published' | 'drafted';
  seoReport: SeoReport;
  /** Anything worth keeping for a later update (the final slug, …). */
  remoteState?: RemoteState;
}

/**
 * Save progress the moment the site has created something, so a crash or
 * timeout after that point is resumed as an update, never a second post.
 */
export type Checkpoint = (patch: { externalId?: string; remoteState?: RemoteState }) => Promise<void>;

export interface WebsiteAdapter {
  id: string;
  /** Verify what the person entered and describe the site. */
  connect(input: Record<string, string>): Promise<ConnectResult>;
  /** Re-check a stored connection ("Test connection", before publishing). */
  verify(ctx: SiteContext): Promise<{ accountLabel: string; capabilities: Record<string, unknown> }>;
  listOptions(ctx: SiteContext): Promise<SiteOptions>;
  /**
   * An earlier attempt whose outcome is unknown (interrupted, timed out) may
   * have created the post. Look for it before creating another.
   */
  findExisting(ctx: SiteContext, marker: { publicationId: string; title: string; slug: string; since: Date }): Promise<{ externalId: string } | null>;
  /** Create the post (existing = null) or update the one already there. */
  publish(ctx: SiteContext, payload: PublishPayload, existing: { externalId: string } | null, state: RemoteState, checkpoint: Checkpoint): Promise<PublishOutcome>;
  /** Withdraw access at the platform on disconnect, where it has a way. */
  revoke?(ctx: SiteContext): Promise<void>;
}

/** A fetch failure (DNS, refused, timeout) as a publish error. */
export function networkError(site: string, err: unknown): WebsitePublishError {
  if (err instanceof WebsitePublishError) return err;
  const reason = err instanceof Error ? err.message : String(err);
  if ((err as { status?: number })?.status === 400 && (err as Error)?.name === 'UnsafeUrlError') {
    return new WebsitePublishError('validation', reason);
  }
  return new WebsitePublishError('network', `Could not reach ${site}: ${reason}`);
}

/** Read a JSON body without throwing on HTML error pages. */
export async function readJson(res: Response): Promise<{ data: unknown; text: string }> {
  const text = await res.text();
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: null, text };
  }
}
