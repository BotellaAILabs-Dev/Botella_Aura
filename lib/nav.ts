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
  Brain,
  Megaphone,
  Plug,
  Gauge,
  Lightbulb,
  CalendarRange,
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
    label: 'Dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
    ready: true,
  },
  {
    label: 'Marketing Intelligence',
    href: '/dashboard/intelligence',
    icon: Gauge,
    ready: true,
    description:
      'Overall marketing health, content quality, and brand consistency in one score.',
  },
  {
    label: 'AI Trend Insights',
    href: '/dashboard/trends',
    icon: Radar,
    ready: true,
    sprint: 2,
    description: 'Daily digests of what your market is talking about.',
  },
  {
    label: 'Marketing Advisor',
    href: '/dashboard/advisor',
    icon: Lightbulb,
    ready: true,
    description:
      'Campaign opportunities inspired by competitor activity and market trends.',
  },
  {
    label: 'Marketing Planner',
    href: '/dashboard/planner',
    icon: CalendarRange,
    ready: true,
    description: 'Turn your goals into a dated monthly content calendar.',
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
    label: 'Campaigns',
    href: '/dashboard/campaigns',
    icon: Megaphone,
    ready: true,
    sprint: 6,
    description: 'Orchestrate content, outreach, and discovery into one plan.',
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
    label: 'Marketing Memory',
    href: '/dashboard/memory',
    icon: Brain,
    ready: true,
    sprint: 5,
    description: 'What we’ve learned about your audience — smarter every week.',
  },
  {
    label: 'Analytics',
    href: '/dashboard/analytics',
    icon: BarChart3,
    ready: true,
    sprint: 6,
    description: 'Measure what your marketing is actually doing.',
  },
  {
    label: 'Connectors',
    href: '/dashboard/connectors',
    icon: Plug,
    ready: true,
    description: 'Connect your marketing tools and data sources.',
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
