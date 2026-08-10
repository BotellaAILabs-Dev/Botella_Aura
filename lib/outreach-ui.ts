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
