import type {
  CompanyRole,
  ContentDraft,
  OutreachMessage,
} from '@prisma/client';

import { db } from '@/lib/db';
import { can } from '@/lib/rbac';
import { CONTENT_TYPE_LABELS, CONTENT_STATUS_LABELS } from '@/lib/content-ui';
import { visualFor, type ContentBrief } from '@/lib/content-brief';
import { DIMENSION_INFO, isReviewCurrent } from '@/lib/content-review';
import { claimsToReview } from '@/lib/fact-check';
import { platformSpec, resolvePlatform } from '@/lib/platforms';
import { isCopyOnlyType, type ContentTypeKey } from '@/lib/validations/content';
import type { QualityReport } from '@/lib/content-quality';
import type { CreationProvenance } from '@/lib/recommendation-creation';
import {
  bodyToFields,
  reviewHref,
  STATE_LABEL,
  type ActionState,
  type ReviewActionKey,
  type ReviewFlag,
  type ReviewItem,
  type ReviewKind,
  type ReviewState,
} from '@/lib/review-item';
import { getAttachedMedia } from '@/server/media/asset.service';
import { factCheckDraft } from '@/server/content/fact-check.service';
import { getPolicyContext } from '@/server/content/compliance.service';
import { storedReview } from '@/server/content/review.service';
import { getWorkspaceProfile } from '@/server/company/profile.service';
import { checkOutreachMessage } from '@/server/outreach/outreach-checks.service';

/**
 * Each module's generated work as a ReviewItem (lib/review-item.ts), so one
 * screen reviews all of it the same way.
 */

const QUEUE_HREF = '/dashboard/review';

const off = (reason: string): ActionState => ({ available: false, reason });
const on: ActionState = { available: true, reason: null };

// ---------------------------------------------------------------------------
// Content Studio drafts
// ---------------------------------------------------------------------------

const CONTENT_STATE: Record<ContentDraft['status'], ReviewState> = {
  DRAFT: 'draft',
  PENDING_APPROVAL: 'in_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PUBLISHED: 'done',
};

type DraftMeta = {
  source?: { kind?: string; brief?: string | null };
  recommendation?: Partial<CreationProvenance> & {
    id?: string;
    title?: string;
  };
  brief?: Partial<ContentBrief> | null;
  quality?: QualityReport;
};

export async function contentReviewItem(
  companyId: string,
  draftId: string,
  role: CompanyRole,
): Promise<ReviewItem | null> {
  const draft = await db.contentDraft.findFirst({
    where: { id: draftId, companyId },
    include: {
      campaign: { select: { name: true, goal: true, targetAudience: true } },
    },
  });
  if (!draft) return null;
  const type = draft.type as ContentTypeKey;
  const platform = resolvePlatform(type, draft.platform);
  const copyOnly = isCopyOnlyType(type);
  const meta = (draft.aiMetadata ?? {}) as DraftMeta;
  const brief = meta.brief ?? null;
  const rec = meta.recommendation ?? null;

  const [media, factCheck, policy, profile] = await Promise.all([
    getAttachedMedia({
      companyId,
      draftId: draft.id,
      type,
      platform: draft.platform,
    }),
    factCheckDraft(draft),
    getPolicyContext(companyId),
    getWorkspaceProfile(companyId),
  ]);
  const review = storedReview(draft);
  const current = isReviewCurrent(review, draft.body, policy.hash);
  const state = CONTENT_STATE[draft.status];

  // Quality flags: the current review carries the rules, compliance and fact
  // check; without one, the fact check and the stored rule check speak.
  const flags: ReviewFlag[] = [];
  if (review && current) {
    for (const i of review.issues) {
      flags.push({
        severity:
          i.severity === 'blocker'
            ? 'block'
            : i.severity === 'major'
              ? 'review'
              : 'info',
        label: DIMENSION_INFO[i.dimension].label,
        message: i.message,
        quote: i.quote,
        source:
          i.source === 'policy'
            ? 'compliance rules'
            : i.source === 'fact_check'
              ? 'fact check'
              : i.source === 'rules'
                ? 'Aura’s rules'
                : 'reviewer',
      });
    }
    if (!review.reviewer.ran) {
      flags.push({
        severity: 'review',
        label: 'Review',
        message: `The independent reviewer did not run${review.reviewer.unavailable ? ` (${review.reviewer.unavailable})` : ''} — relevance, voice and audience fit were not assessed.`,
        source: 'reviewer',
      });
    }
  } else {
    if (state === 'draft' || state === 'in_review') {
      flags.push({
        severity: 'info',
        label: 'Review',
        message: review
          ? 'This version (or the compliance rules) changed since the last review — it is reviewed again before approval.'
          : 'Not reviewed yet — it is reviewed before approval.',
        source: 'reviewer',
      });
    }
    for (const c of factCheck.claims) {
      if (c.status === 'supported') continue;
      flags.push({
        severity: c.mustFix ? 'block' : 'review',
        label: 'Accuracy',
        message: c.reason,
        quote: c.text,
        source: 'fact check',
      });
    }
    for (const i of meta.quality?.issues ?? []) {
      if (i.severity !== 'block') continue;
      flags.push({
        severity: 'block',
        label: 'Rules',
        message: i.message,
        source: 'Aura’s rules',
      });
    }
  }

  const need =
    (brief?.assetRequirements?.visual?.need as
      'required' | 'recommended' | 'none' | undefined) ??
    visualFor(type, copyOnly ? null : platform).need;
  if (need === 'required' && media.length === 0) {
    flags.push({
      severity: 'review',
      label: 'Image',
      message: `${platform ? platformSpec(platform).label : 'This format'} needs an image and none is attached.`,
      source: 'format',
    });
  }
  if (draft.rejectionReason && state !== 'approved') {
    flags.push({
      severity: 'info',
      label: 'Rejected',
      message: draft.rejectionReason,
      source: 'approver',
    });
  }
  const order = { block: 0, review: 1, info: 2 } as const;
  flags.sort((a, b) => order[a.severity] - order[b.severity]);

  // What approval needs.
  const blockedBy =
    review && current && review.status === 'fail'
      ? `The review failed${review.failed.length ? ` on ${review.failed.map((d) => DIMENSION_INFO[d].label).join(', ')}` : ''} — fix it or regenerate with the review’s feedback.`
      : factCheck.claims.some((c) => c.mustFix)
        ? 'A claim must be fixed first (see the flags).'
        : (meta.quality?.issues ?? []).some((i) => i.severity === 'block') &&
            !(review && current)
          ? 'A rule is broken — fix it first (see the flags).'
          : null;
  const toReview = claimsToReview(factCheck).length;
  const needsConfirmation =
    (review && current && review.status === 'review_required') ||
    factCheck.status === 'needs_review' ||
    (need === 'required' && media.length === 0);

  const canEdit = can(role, 'content:create');
  const canApprove = can(role, 'content:approve');
  const open = state === 'draft' || state === 'in_review';
  const actions: Record<ReviewActionKey, ActionState> = {
    back: on,
    edit: !canEdit
      ? off('Your role is read-only.')
      : state === 'done'
        ? off('Published content cannot be edited.')
        : on,
    save: !canEdit
      ? off('Your role is read-only.')
      : state === 'done'
        ? off('Published content cannot be edited.')
        : on,
    regenerate: !canEdit
      ? off('Your role is read-only.')
      : state === 'done'
        ? off('Published content cannot be regenerated.')
        : on,
    submit: !canEdit
      ? off('Your role is read-only.')
      : state !== 'draft'
        ? off(
            state === 'in_review'
              ? 'Already awaiting approval.'
              : 'Only a draft is submitted.',
          )
        : on,
    approve: !canApprove
      ? off('Only owners and admins can approve.')
      : !open
        ? off(
            state === 'approved'
              ? 'Already approved.'
              : state === 'done'
                ? 'Already published.'
                : 'Rejected — edit or regenerate it first.',
          )
        : blockedBy
          ? off(blockedBy)
          : on,
    reject: !canApprove
      ? off('Only owners and admins can reject.')
      : state === 'rejected' || state === 'done'
        ? off(state === 'done' ? 'Already published.' : 'Already rejected.')
        : on,
    schedule: copyOnly
      ? off(
          `${CONTENT_TYPE_LABELS[type]} is copied into your ${type === 'EMAIL' ? 'email tool' : 'ad manager or site'}, not scheduled by Aura.`,
        )
      : !can(role, 'content:publish')
        ? off('Only owners and admins can schedule.')
        : state !== 'approved'
          ? off('Approve it first, then schedule it.')
          : on,
  };

  const channel =
    (brief?.channel?.name as string | undefined) ??
    rec?.channel ??
    (copyOnly ? CONTENT_TYPE_LABELS[type] : platformSpec(platform).label);
  const evidence = (Array.isArray(brief?.evidence) ? brief!.evidence : []).map(
    (e) => ({
      label: e?.label ?? '',
      detail: e?.detail || null,
      url: e?.url ?? null,
      observedAt: e?.observedAt ?? null,
    }),
  );
  const recEvidence = (rec?.evidence ?? []).map((e) => ({
    label: e.label,
    detail: null,
    url: e.url,
    observedAt: null,
  }));

  return {
    kind: 'content',
    id: draft.id,
    title: draft.title ?? CONTENT_TYPE_LABELS[type],
    module: 'Content Studio',
    typeLabel: copyOnly
      ? CONTENT_TYPE_LABELS[type]
      : `${CONTENT_TYPE_LABELS[type]} · ${platformSpec(platform).label}`,
    state,
    statusLabel: CONTENT_STATUS_LABELS[draft.status],
    rejectionReason: draft.rejectionReason,
    scheduledFor: draft.scheduledFor?.toISOString() ?? null,
    updatedAt: draft.updatedAt.toISOString(),
    fields: bodyToFields(draft.body),
    asset: {
      need,
      images: media.map((m) => ({ url: m.url, alt: m.altText ?? '' })),
      manageHref: copyOnly ? null : `/dashboard/content/${draft.id}`,
      note:
        need === 'none'
          ? 'This format does not use an image.'
          : media.length
            ? null
            : need === 'required'
              ? 'An image is required before this can be posted.'
              : 'An image is recommended.',
    },
    context: {
      recommendation: rec?.title
        ? {
            title: rec.title,
            why: rec.why ?? brief?.reason?.why ?? null,
            href: '/dashboard/suggestions/history',
          }
        : null,
      goal:
        (brief?.marketingGoal?.value as string | undefined) ??
        rec?.goal ??
        draft.campaign?.goal ??
        profile.marketing?.goals ??
        null,
      audience:
        (brief?.targetAudience?.value as string | undefined) ??
        rec?.audience ??
        draft.campaign?.targetAudience ??
        profile.marketing?.audience ??
        null,
      channel,
      keyMessage: (brief?.keyMessage?.value as string | undefined) ?? null,
      source: rec?.title ? null : (meta.source?.brief ?? null),
      evidence: evidence.length ? evidence : recEvidence,
      extra: [
        ...(draft.campaign
          ? [{ label: 'Campaign', value: draft.campaign.name }]
          : []),
        ...(rec?.expectedOutcome
          ? [{ label: 'Expected outcome', value: rec.expectedOutcome }]
          : []),
        ...(toReview
          ? [{ label: 'Claims to check', value: String(toReview) }]
          : []),
      ],
    },
    flags,
    reviewer: review
      ? {
          status: review.status,
          score: review.score,
          summary: review.summary,
          current,
          ran: review.reviewer.ran,
          unavailable: review.reviewer.unavailable,
          issues: review.issues.slice(0, 12).map((i) => ({
            severity: i.severity,
            area: DIMENSION_INFO[i.dimension].label,
            message: i.message,
            quote: i.quote,
            suggestion: i.suggestion,
          })),
        }
      : null,
    approval: {
      needsConfirmation: Boolean(needsConfirmation),
      confirmLabel: needsConfirmation
        ? 'I’ve checked what is flagged for review — the claims, the review’s points and the image — and this is fine to approve.'
        : null,
      blockedBy,
    },
    actions,
    regenerate: {
      fixReview: Boolean(
        review && current && review.status !== 'pass' && review.issues.length,
      ),
      instructions: true,
    },
    backHref: QUEUE_HREF,
    moduleHref: `/dashboard/content/${draft.id}`,
  };
}

// ---------------------------------------------------------------------------
// Outreach messages
// ---------------------------------------------------------------------------

const OUTREACH_STATE: Record<OutreachMessage['status'], ReviewState> = {
  DRAFT: 'draft',
  PENDING_APPROVAL: 'in_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SENT: 'done',
};
const OUTREACH_LABEL: Record<OutreachMessage['type'], string> = {
  CONNECTION_NOTE: 'Connection note',
  FOLLOWUP: 'Follow-up message',
};

export async function outreachReviewItem(
  companyId: string,
  messageId: string,
  role: CompanyRole,
): Promise<ReviewItem | null> {
  const msg = await db.outreachMessage.findFirst({
    where: { id: messageId, companyId },
    include: { lead: true },
  });
  if (!msg) return null;
  const meta = (msg.aiMetadata ?? {}) as { signalId?: string | null };
  const [signal, flags, profile] = await Promise.all([
    meta.signalId
      ? db.leadSignal.findFirst({
          where: { id: meta.signalId, leadId: msg.leadId },
        })
      : db.leadSignal.findFirst({
          where: { leadId: msg.leadId },
          orderBy: { detectedAt: 'desc' },
        }),
    checkOutreachMessage(msg),
    getWorkspaceProfile(companyId),
  ]);
  const state = OUTREACH_STATE[msg.status];
  if (msg.rejectionReason && state !== 'approved') {
    flags.push({
      severity: 'info',
      label: 'Rejected',
      message: msg.rejectionReason,
      source: 'approver',
    });
  }
  const blocking = flags.filter((f) => f.severity === 'block');
  const needsConfirmation = flags.some((f) => f.severity === 'review');
  const allowed = can(role, 'content:approve');
  const open = state === 'draft' || state === 'in_review';
  const lead = msg.lead;
  const who = [lead.name, lead.title].filter(Boolean).join(', ');

  const actions: Record<ReviewActionKey, ActionState> = {
    back: on,
    edit: !allowed
      ? off('Only owners and admins can edit outreach.')
      : state === 'done'
        ? off('Already sent.')
        : on,
    save: !allowed
      ? off('Only owners and admins can edit outreach.')
      : state === 'done'
        ? off('Already sent.')
        : on,
    regenerate: !allowed
      ? off('Only owners and admins can regenerate outreach.')
      : state === 'done'
        ? off('Already sent.')
        : on,
    submit: !allowed
      ? off('Only owners and admins can submit outreach.')
      : state !== 'draft'
        ? off(
            state === 'in_review'
              ? 'Already awaiting approval.'
              : 'Only a draft is submitted.',
          )
        : on,
    approve: !allowed
      ? off('Only owners and admins can approve.')
      : !open
        ? off(
            state === 'approved'
              ? 'Already approved.'
              : state === 'done'
                ? 'Already sent.'
                : 'Rejected — edit or regenerate it first.',
          )
        : blocking.length
          ? off(`Fix first: ${blocking[0]!.message}`)
          : on,
    reject: !allowed
      ? off('Only owners and admins can reject.')
      : state === 'rejected' || state === 'done'
        ? off(state === 'done' ? 'Already sent.' : 'Already rejected.')
        : on,
    schedule: off(
      'Outreach is sent by you from the browser extension once approved — it is not scheduled.',
    ),
  };

  return {
    kind: 'outreach',
    id: msg.id,
    title: `${OUTREACH_LABEL[msg.type]} to ${lead.name ?? lead.companyName}`,
    module: 'Outreach',
    typeLabel: `${OUTREACH_LABEL[msg.type]} · LinkedIn`,
    state,
    statusLabel: state === 'done' ? 'Sent' : STATE_LABEL[state],
    rejectionReason: msg.rejectionReason,
    scheduledFor: null,
    updatedAt: msg.updatedAt.toISOString(),
    fields: [
      {
        key: 'draftText',
        label: msg.type === 'CONNECTION_NOTE' ? 'Connection note' : 'Message',
        value: msg.draftText,
        multiline: true,
        maxLength: msg.type === 'CONNECTION_NOTE' ? 300 : 3000,
      },
    ],
    asset: null,
    context: {
      recommendation: null,
      goal: profile.marketing?.goals ?? null,
      audience: [who, lead.companyName].filter(Boolean).join(' at ') || null,
      channel:
        msg.type === 'CONNECTION_NOTE'
          ? 'LinkedIn connection request'
          : 'LinkedIn message',
      keyMessage: null,
      source: signal ? `Written from: ${signal.description}` : null,
      evidence: signal
        ? [
            {
              label: signal.description,
              detail: null,
              url: signal.sourceUrl,
              observedAt: signal.detectedAt.toISOString(),
            },
          ]
        : [],
      extra: [
        ...(lead.category
          ? [{ label: 'Lead category', value: lead.category }]
          : []),
        ...(lead.fitScore !== null
          ? [{ label: 'Fit score', value: `${lead.fitScore}/100` }]
          : []),
        ...(lead.fitRationale
          ? [{ label: 'Why this lead', value: lead.fitRationale }]
          : []),
      ],
    },
    flags,
    reviewer: null,
    approval: {
      needsConfirmation,
      confirmLabel: needsConfirmation
        ? 'I’ve checked what is flagged for review and this is fine to send.'
        : null,
      blockedBy: blocking.length ? blocking[0]!.message : null,
    },
    actions,
    regenerate: { fixReview: false, instructions: false },
    backHref: QUEUE_HREF,
    moduleHref: '/dashboard/outreach',
  };
}

export async function getReviewItem(
  kind: ReviewKind,
  companyId: string,
  id: string,
  role: CompanyRole,
): Promise<ReviewItem | null> {
  return kind === 'content'
    ? contentReviewItem(companyId, id, role)
    : outreachReviewItem(companyId, id, role);
}

// ---------------------------------------------------------------------------
// The review queue
// ---------------------------------------------------------------------------

export interface ReviewQueueRow {
  kind: ReviewKind;
  id: string;
  href: string;
  module: string;
  typeLabel: string;
  title: string;
  snippet: string;
  state: ReviewState;
  /** The review's verdict when known ("Needs human review", "Review failed"). */
  verdict: 'pass' | 'review_required' | 'fail' | null;
  updatedAt: string;
}

/** Everything waiting on a person: drafts and items awaiting approval, across modules. */
export async function listReviewQueue(
  companyId: string,
  options: { includeDecided?: boolean } = {},
): Promise<ReviewQueueRow[]> {
  const states = options.includeDecided
    ? undefined
    : { in: ['DRAFT', 'PENDING_APPROVAL'] as const };
  const [drafts, messages, policy] = await Promise.all([
    db.contentDraft.findMany({
      where: {
        companyId,
        ...(states ? { status: { in: [...states.in] } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        type: true,
        platform: true,
        status: true,
        title: true,
        body: true,
        aiMetadata: true,
        updatedAt: true,
      },
    }),
    db.outreachMessage.findMany({
      where: {
        companyId,
        ...(states ? { status: { in: [...states.in] } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      include: { lead: { select: { name: true, companyName: true } } },
    }),
    getPolicyContext(companyId),
  ]);

  const snippet = (s: string) => (s.length > 140 ? `${s.slice(0, 137)}…` : s);
  const rows: ReviewQueueRow[] = [
    ...drafts.map((d) => {
      const type = d.type as ContentTypeKey;
      const review = storedReview(d);
      const first =
        bodyToFields(d.body).find((f) => !f.list && f.value.trim())?.value ??
        '';
      return {
        kind: 'content' as const,
        id: d.id,
        href: reviewHref('content', d.id),
        module: 'Content Studio',
        typeLabel: isCopyOnlyType(type)
          ? CONTENT_TYPE_LABELS[type]
          : `${CONTENT_TYPE_LABELS[type]} · ${platformSpec(resolvePlatform(type, d.platform)).label}`,
        title: d.title ?? CONTENT_TYPE_LABELS[type],
        snippet: snippet(first),
        state: CONTENT_STATE[d.status],
        verdict:
          review && isReviewCurrent(review, d.body, policy.hash)
            ? review.status
            : null,
        updatedAt: d.updatedAt.toISOString(),
      };
    }),
    ...messages.map((m) => ({
      kind: 'outreach' as const,
      id: m.id,
      href: reviewHref('outreach', m.id),
      module: 'Outreach',
      typeLabel: `${OUTREACH_LABEL[m.type]} · LinkedIn`,
      title: `${OUTREACH_LABEL[m.type]} to ${m.lead.name ?? m.lead.companyName}`,
      snippet: snippet(m.draftText),
      state: OUTREACH_STATE[m.status],
      verdict: null,
      updatedAt: m.updatedAt.toISOString(),
    })),
  ];
  // Awaiting approval first, then most recently changed.
  return rows.sort(
    (a, b) =>
      Number(b.state === 'in_review') - Number(a.state === 'in_review') ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}
