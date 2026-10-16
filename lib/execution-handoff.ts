import { z } from 'zod';

import type { ApprovalRecord } from '@/lib/approval';
import type { VersionLog } from '@/lib/versions';

/**
 * APPROVAL → EXECUTION HANDOFF — the structured package the Execution Engine
 * (Sprint 10) consumes once content is approved.
 *
 * One versioned, validated payload per approved piece and target network:
 *
 *   asset · recommendationId · opportunityId · channel · provider ·
 *   account/page · audience · CTA · scheduled time · content version ·
 *   approval record · execution requirements · readiness
 *
 * Built from the APPROVED snapshot and the approval record (lib/approval.ts),
 * so it is exactly what a person approved — and it is stale the moment the
 * content's fingerprint moves. Readiness is checked here, never left to the
 * executor to discover: a missing or expired connection, a missing Page or
 * Instagram account, missing posting permission, a channel Aura cannot
 * execute on, or media the network will refuse is an ISSUE with a code, a
 * plain message and where to fix it — never a silent failure.
 *
 * No secrets: an account is identified by ids and labels, never a token.
 * Pure and client-safe; server/execution/execution-handoff.service.ts gathers
 * the facts and keeps the record (ExecutionHandoff).
 */

export const EXECUTION_HANDOFF_VERSION = 1 as const;

export const EXECUTION_PLATFORMS = ['LINKEDIN', 'FACEBOOK', 'INSTAGRAM', 'X'] as const;
export type ExecutionPlatform = (typeof EXECUTION_PLATFORMS)[number];

export const ISSUE_CODES = [
  'not_approved',
  'content_changed',
  'unsupported_channel',
  'missing_connection',
  'connection_expired',
  'missing_permission',
  'missing_account',
  'missing_media',
  'invalid_media',
  'missing_field',
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

/**
 *   ready        everything the executor needs is here and valid
 *   blocked      approved, but something must be fixed first (issues)
 *   superseded   no longer what was approved (edited, reopened, rejected)
 *   executed     already published
 */
export const HANDOFF_STATUSES = ['ready', 'blocked', 'superseded', 'executed'] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

const text = z.string().trim().min(1);

export const executionIssueSchema = z.object({
  code: z.enum(ISSUE_CODES),
  message: text,
  fix: z.object({ label: text, href: text }).nullable(),
});
export type ExecutionIssue = z.infer<typeof executionIssueSchema>;

export const executionHandoffSchema = z.object({
  version: z.literal(EXECUTION_HANDOFF_VERSION),
  item: z.object({ type: z.literal('content_draft'), id: text, companyId: text }),
  /** The approved asset: the text the network receives and the media, in order. */
  asset: z.object({
    contentType: text,
    title: z.string().nullable(),
    text: z.string(),
    body: z.unknown(),
    media: z.array(
      z.object({
        assetId: text,
        kind: z.enum(['IMAGE', 'VIDEO']),
        mimeType: text,
        width: z.number(),
        height: z.number(),
        altText: z.string().nullable(),
        position: z.number(),
      }),
    ),
  }),
  recommendationId: z.string().nullable(),
  opportunityId: z.string().nullable(),
  channel: z.object({ platform: z.enum(EXECUTION_PLATFORMS), label: text }),
  provider: z.object({
    id: z.enum(['linkedin', 'meta', 'none']),
    label: text,
    /** Aura posts through the provider's API, or a person posts it by hand. */
    mode: z.enum(['api', 'manual']),
  }),
  /** The account or Page it goes to. Ids and labels only — never a token. */
  account: z
    .object({
      label: text,
      kind: z.enum(['linkedin_member', 'linkedin_organization', 'facebook_page', 'instagram_account']),
      id: z.string().nullable(),
      pageId: z.string().nullable(),
      pageName: z.string().nullable(),
    })
    .nullable(),
  audience: z.string().nullable(),
  cta: z.object({ text: z.string().nullable(), destination: z.string().nullable() }),
  /** When to publish; null = as soon as the executor is told to. */
  scheduledFor: z.string().nullable(),
  contentVersion: z.object({
    /** The approval record's content version and fingerprint. */
    version: z.number(),
    hash: text,
    /** The numbered version in the version history (lib/versions.ts). */
    versionNumber: z.number().nullable(),
  }),
  approval: z.object({
    id: z.string().nullable(),
    by: z.string().nullable(),
    via: z.enum(['person', 'autopilot']),
    at: text,
    version: z.number(),
    hash: text,
  }),
  requirements: z.object({
    mediaRequired: z.boolean(),
    maxMedia: z.number(),
    acceptedMimeTypes: z.array(text),
    captionLimit: z.number().nullable(),
    /** What the provider connection must allow. */
    permissions: z.array(text),
  }),
  readiness: z.object({
    status: z.enum(HANDOFF_STATUSES),
    issues: z.array(executionIssueSchema),
  }),
  preparedAt: text,
});
export type ExecutionHandoff = z.infer<typeof executionHandoffSchema>;

// ---------------------------------------------------------------------------
// The facts it is built from (gathered on the server)
// ---------------------------------------------------------------------------

export interface HandoffFacts {
  companyId: string;
  draft: {
    id: string;
    type: string;
    status: string;
    title: string | null;
    scheduledFor: Date | null;
    /** The body as it is now, and its fingerprint. */
    body: unknown;
    currentHash: string;
    cta: string | null;
  };
  approval: ApprovalRecord | null;
  versions: VersionLog | null;
  platform: ExecutionPlatform;
  /** The text the network receives (rendered for the platform). */
  text: string;
  media: ExecutionHandoff['asset']['media'];
  /** Media problems found by the platform validators (server/media/validate.ts). */
  mediaProblems: string[];
  /** Can this format go to this network through an API at all (canAutoPublishTo). */
  formatSupported: boolean;
  /** An email or ad: copied out, never executed on a network. */
  copyOnly: boolean;
  recommendation: { recommendationId: string | null; opportunityId: string | null; audience: string | null } | null;
  businessWebsite: string | null;
  connections: {
    linkedin: { connected: boolean; expired: boolean; scopes: string[]; memberName: string | null; memberId: string | null; orgUrn: string | null } | null;
    meta: { connected: boolean; expired: boolean; pageId: string | null; pageName: string | null; igUserId: string | null; igUsername: string | null } | null;
  };
}

const LABEL: Record<ExecutionPlatform, string> = {
  LINKEDIN: 'LinkedIn',
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  X: 'X',
};

const CONNECTORS_FIX = { label: 'Open Connections', href: '/dashboard/connectors' };
const LINKEDIN_FIX = { label: 'Connect LinkedIn', href: '/dashboard/settings/connections' };

/** What each network requires of a post (from its publisher). */
const REQUIREMENTS: Record<ExecutionPlatform, ExecutionHandoff['requirements']> = {
  LINKEDIN: { mediaRequired: false, maxMedia: 1, acceptedMimeTypes: ['image/png', 'image/jpeg'], captionLimit: 3000, permissions: ['w_member_social or w_organization_social'] },
  FACEBOOK: { mediaRequired: false, maxMedia: 1, acceptedMimeTypes: ['image/png', 'image/jpeg'], captionLimit: 2200, permissions: ['pages_manage_posts', 'pages_read_engagement'] },
  INSTAGRAM: {
    mediaRequired: true,
    maxMedia: 10,
    acceptedMimeTypes: ['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime'],
    captionLimit: 2200,
    permissions: ['instagram_basic', 'instagram_content_publish'],
  },
  X: { mediaRequired: false, maxMedia: 0, acceptedMimeTypes: [], captionLimit: null, permissions: [] },
};

function provider(platform: ExecutionPlatform): ExecutionHandoff['provider'] {
  if (platform === 'LINKEDIN') return { id: 'linkedin', label: 'LinkedIn', mode: 'api' };
  if (platform === 'X') return { id: 'none', label: 'Posted by hand', mode: 'manual' };
  return { id: 'meta', label: 'Meta', mode: 'api' };
}

function issue(code: IssueCode, message: string, fix: ExecutionIssue['fix'] = null): ExecutionIssue {
  return { code, message, fix };
}

/** The provider connection and account for a network, and what is wrong with it. */
function accountFor(f: HandoffFacts): { account: ExecutionHandoff['account']; issues: ExecutionIssue[] } {
  const issues: ExecutionIssue[] = [];
  if (f.platform === 'LINKEDIN') {
    const li = f.connections.linkedin;
    if (!li?.connected) return { account: null, issues: [issue('missing_connection', 'LinkedIn isn’t connected for this workspace.', LINKEDIN_FIX)] };
    if (li.expired) return { account: null, issues: [issue('connection_expired', 'The LinkedIn connection has expired — reconnect it.', LINKEDIN_FIX)] };
    const org = li.scopes.includes('w_organization_social') && li.orgUrn;
    if (!org && !li.scopes.includes('w_member_social')) {
      issues.push(issue('missing_permission', 'LinkedIn is connected without posting permission — reconnect and allow “Share on LinkedIn”.', LINKEDIN_FIX));
    }
    return {
      account: org
        ? { label: 'LinkedIn Page', kind: 'linkedin_organization', id: li.orgUrn, pageId: li.orgUrn, pageName: null }
        : { label: li.memberName ?? 'LinkedIn profile', kind: 'linkedin_member', id: li.memberId, pageId: null, pageName: null },
      issues,
    };
  }
  if (f.platform === 'FACEBOOK' || f.platform === 'INSTAGRAM') {
    const m = f.connections.meta;
    const name = f.platform === 'FACEBOOK' ? 'Facebook' : 'Instagram';
    if (!m?.connected) return { account: null, issues: [issue('missing_connection', `${name} isn’t connected — connect Facebook & Instagram.`, CONNECTORS_FIX)] };
    if (m.expired) return { account: null, issues: [issue('connection_expired', 'The Facebook & Instagram connection has expired — reconnect it.', CONNECTORS_FIX)] };
    if (!m.pageId) return { account: null, issues: [issue('missing_account', 'No Facebook Page is chosen for publishing.', CONNECTORS_FIX)] };
    if (f.platform === 'FACEBOOK') {
      return { account: { label: m.pageName ?? 'Facebook Page', kind: 'facebook_page', id: m.pageId, pageId: m.pageId, pageName: m.pageName }, issues };
    }
    if (!m.igUserId) {
      return {
        account: null,
        issues: [issue('missing_account', 'No Instagram Business or Creator account is linked to the chosen Facebook Page.', CONNECTORS_FIX)],
      };
    }
    return {
      account: { label: m.igUsername ? `@${m.igUsername}` : 'Instagram account', kind: 'instagram_account', id: m.igUserId, pageId: m.pageId, pageName: m.pageName },
      issues,
    };
  }
  return { account: null, issues };
}

/**
 * The execution package for one approved piece and network, with its
 * readiness. Throws only when there is no approval to hand over at all.
 */
export function buildExecutionHandoff(f: HandoffFacts, now: Date = new Date()): ExecutionHandoff {
  const approved = f.approval?.approved;
  if (!approved) throw new Error('Only approved work can be handed to execution.');
  const issues: ExecutionIssue[] = [];

  // Exactly what was approved, still — or nothing.
  let status: HandoffStatus | null = null;
  if (f.draft.status === 'PUBLISHED') status = 'executed';
  else if (f.draft.status !== 'APPROVED') {
    status = 'superseded';
    issues.push(issue('not_approved', 'This is no longer approved — approve it again to hand it to execution.'));
  } else if (approved.hash !== f.draft.currentHash) {
    status = 'superseded';
    issues.push(issue('content_changed', 'It changed after it was approved — approve it again.'));
  }

  // Can it be executed on this network at all?
  if (f.copyOnly) {
    issues.push(issue('unsupported_channel', 'Emails and ads are copied out to your email tool or ad manager — not executed on a social network.'));
  } else if (f.platform === 'X') {
    issues.push(issue('unsupported_channel', 'Aura has no X publishing integration — this is posted by hand.'));
  } else if (!f.formatSupported) {
    issues.push(issue('unsupported_channel', `${LABEL[f.platform]}’s API doesn’t take this format — it is posted by hand.`));
  }

  const { account, issues: accountIssues } = f.copyOnly || f.platform === 'X' ? { account: null, issues: [] } : accountFor(f);
  issues.push(...accountIssues);

  const req = REQUIREMENTS[f.platform];
  if (!f.copyOnly && f.platform !== 'X') {
    if (req.mediaRequired && f.media.length === 0) {
      issues.push(issue('missing_media', `${LABEL[f.platform]} posts need an image or a video — attach one.`));
    }
    for (const p of f.mediaProblems) issues.push(issue('invalid_media', p));
  }
  // Required fields: something to publish.
  if (!f.text.trim() && f.media.length === 0) issues.push(issue('missing_field', 'There is nothing to publish — the post has no text and no media.'));

  const unique = issues.filter((x, i) => issues.findIndex((y) => y.code === x.code && y.message === x.message) === i);
  const ctaText = f.draft.cta?.trim() || null;
  return executionHandoffSchema.parse({
    version: EXECUTION_HANDOFF_VERSION,
    item: { type: 'content_draft', id: f.draft.id, companyId: f.companyId },
    asset: {
      contentType: f.draft.type,
      title: f.draft.title,
      text: f.text,
      // The approved content itself (what was approved, even if edited since).
      body: approved.snapshot ?? f.draft.body,
      media: f.media,
    },
    recommendationId: f.recommendation?.recommendationId ?? null,
    opportunityId: f.recommendation?.opportunityId ?? null,
    channel: { platform: f.platform, label: LABEL[f.platform] },
    provider: provider(f.platform),
    account,
    audience: f.recommendation?.audience ?? null,
    // Where a CTA sends people: the business's own site — never invented.
    cta: { text: ctaText, destination: ctaText ? f.businessWebsite : null },
    scheduledFor: f.draft.scheduledFor ? f.draft.scheduledFor.toISOString() : null,
    contentVersion: { version: f.approval!.version, hash: f.draft.currentHash, versionNumber: f.versions?.approved?.n ?? f.versions?.current ?? null },
    approval: { id: approved.id ?? null, by: approved.by, via: approved.via, at: approved.at, version: approved.version, hash: approved.hash },
    requirements: req,
    readiness: { status: status ?? (unique.length ? 'blocked' : 'ready'), issues: unique },
    preparedAt: now.toISOString(),
  });
}

/** A stored handoff payload, if valid (anything else is treated as absent). */
export function readExecutionHandoff(value: unknown): ExecutionHandoff | null {
  const r = executionHandoffSchema.safeParse(value);
  return r.success ? r.data : null;
}

export const HANDOFF_STATUS_LABEL: Record<HandoffStatus, string> = {
  ready: 'Ready for execution',
  blocked: 'Blocked — needs fixing',
  superseded: 'No longer approved',
  executed: 'Executed',
};
