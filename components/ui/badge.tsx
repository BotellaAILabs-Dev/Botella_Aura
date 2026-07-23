import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Status badge. Variants intentionally cover the ContentStatus lifecycle
 * (DRAFT / PENDING_APPROVAL / APPROVED / REJECTED / PUBLISHED) that Content
 * Studio needs in Sprint 3 — see `statusBadgeVariant` below.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/10 text-primary',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-foreground',
        success:
          'border-transparent bg-success/10 text-success-foreground/90 [color:hsl(var(--success))]',
        warning:
          'border-transparent bg-warning/15 [color:hsl(38_92%_35%)] dark:[color:hsl(var(--warning))]',
        destructive:
          'border-transparent bg-destructive/10 [color:hsl(var(--destructive))]',
        muted: 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

/** Map a ContentStatus to a badge variant for consistent status styling. */
export function statusBadgeVariant(
  status:
    | 'DRAFT'
    | 'PENDING_APPROVAL'
    | 'APPROVED'
    | 'REJECTED'
    | 'PUBLISHED',
): BadgeProps['variant'] {
  switch (status) {
    case 'DRAFT':
      return 'muted';
    case 'PENDING_APPROVAL':
      return 'warning';
    case 'APPROVED':
      return 'default';
    case 'REJECTED':
      return 'destructive';
    case 'PUBLISHED':
      return 'success';
  }
}

export { Badge, badgeVariants };
