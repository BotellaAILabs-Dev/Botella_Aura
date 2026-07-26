import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Radar,
  PenLine,
  Send,
  MessageCircle,
  Users,
  BarChart3,
  Settings,
  Target,
} from 'lucide-react';

/**
 * Single source of truth for the dashboard sidebar. Each future sprint flips
 * its item from `ready: false` (renders a "Coming in Sprint N" placeholder) to
 * `ready: true` when the feature ships. Keeping this centralized means nav,
 * placeholder pages, and breadcrumbs never drift.
 */
export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  ready: boolean;
  sprint?: number;
  description?: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    label: 'Overview',
    href: '/dashboard',
    icon: LayoutDashboard,
    ready: true,
  },
  {
    label: 'Trend Intelligence',
    href: '/dashboard/trends',
    icon: Radar,
    ready: true,
    sprint: 2,
    description: 'Daily digests of what your market is talking about.',
  },
  {
    label: 'Content Studio',
    href: '/dashboard/content',
    icon: PenLine,
    ready: true,
    sprint: 3,
    description: 'Generate on-brand posts, carousels, and threads.',
  },
  {
    label: 'Leads',
    href: '/dashboard/leads',
    icon: Target,
    ready: true,
    sprint: 5,
    description: 'Discover and qualify prospects from public sources.',
  },
  {
    label: 'Outreach',
    href: '/dashboard/outreach',
    icon: Send,
    ready: true,
    sprint: 4,
    description: 'Draft personalized outreach — reviewed before it sends.',
  },
  {
    label: 'Engagement',
    href: '/dashboard/engagement',
    icon: MessageCircle,
    ready: true,
    sprint: 4,
    description: 'Suggested replies and comments, approved by you.',
  },
  {
    label: 'Competitors',
    href: '/dashboard/competitors',
    icon: Users,
    ready: true,
    sprint: 4,
    description: 'Track competitor activity and positioning.',
  },
  {
    label: 'Analytics',
    href: '/dashboard/analytics',
    icon: BarChart3,
    ready: false,
    sprint: 7,
    description: 'Measure what your marketing is actually doing.',
  },
  {
    label: 'Settings',
    href: '/dashboard/settings',
    icon: Settings,
    ready: true,
  },
];

export function findNavItem(href: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.href === href);
}
