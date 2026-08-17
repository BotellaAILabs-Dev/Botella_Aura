import type { BadgeProps } from '@/components/ui/badge';

/**
 * Client-safe presentation helpers for Outreach — mirrors lib/content-ui.ts so
 * the Outreach queue reuses the same status-badge vocabulary as Content Studio.
 */
export type OutreachStatusKey =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SENT'
  | 'REJECTED';
export const OUTREACH_STATUS_LABELS: Record<OutreachStatusKey, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  SENT: 'Sent',
  REJECTED: 'Rejected',
};
export const OUTREACH_TYPE_LABELS: Record<string, string> = {
  CONNECTION_NOTE: 'Connection note',
  FOLLOWUP: 'Follow-up',
};
export const SIGNAL_LABELS: Record<string, string> = {
  FUNDING: 'Funding',
  HIRING: 'Hiring',
  GITHUB_ACTIVITY: 'GitHub activity',
  NEWS: 'News',
  LEADERSHIP_CHANGE: 'Leadership change',
};
/** Map an outreach status to a badge variant (same palette as content). */
export function outreachStatusVariant(
  status: OutreachStatusKey,
): BadgeProps['variant'] {
  switch (status) {
    case 'DRAFT':
      return 'muted';
    case 'PENDING_APPROVAL':
      return 'warning';
    case 'APPROVED':
      return 'default';
    case 'SENT':
      return 'success';
    case 'REJECTED':
      return 'destructive';
  }
}

/**
 * The visible progression a message moves through, surfaced as a stepper so the
 * workflow is legible at a glance. "Queued" is not a stored status — approving a
 * message immediately places it in the extension's send queue, so APPROVED lights
 * both the Approved and Queued steps. A human still sends each one manually.
 */
export const OUTREACH_STEPS = [
  'Draft',
  'Pending',
  'Approved',
  'Queued',
  'Sent',
] as const;

/** How far along the stepper a status has reached (and whether it was rejected). */
export function outreachStepState(status: OutreachStatusKey): {
  reached: number;
  rejected: boolean;
} {
  switch (status) {
    case 'DRAFT':
      return { reached: 0, rejected: false };
    case 'PENDING_APPROVAL':
      return { reached: 1, rejected: false };
    case 'APPROVED':
      // Approved messages are immediately queued in the extension.
      return { reached: 3, rejected: false };
    case 'SENT':
      return { reached: 4, rejected: false };
    case 'REJECTED':
      return { reached: 0, rejected: true };
  }
}
