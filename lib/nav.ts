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
  /** Which sidebar section this belongs to. */
  section: NavSection;
}

/**
 * Sidebar sections, in order.
 *
 * Fourteen flat links read as a menu of separate tools rather than one
 * assistant. Grouping them by what the user is trying to DO — see how things
 * are going, make something, grow the pipeline, check the result — gives the
 * sidebar a clear top (the score) and an obvious reading order, without moving
 * or removing any page.
 */
export const NAV_SECTIONS = [
  { id: 'overview', label: '' },
  { id: 'intelligence', label: 'Understand' },
  { id: 'create', label: 'Create' },
  { id: 'grow', label: 'Grow' },
  { id: 'measure', label: 'Measure' },
  { id: 'setup', label: 'Setup' },
] as const;

export type NavSection = (typeof NAV_SECTIONS)[number]['id'];

export const NAV_ITEMS: NavItem[] = [
  {
    label: 'Dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
    ready: true,
    section: 'overview',
  },
  {
    label: 'Marketing Intelligence',
    href: '/dashboard/intelligence',
    section: 'intelligence',
    icon: Gauge,
    ready: true,
    description:
      'Overall marketing health, content quality, and brand consistency in one score.',
  },
  {
    label: 'AI Trend Insights',
    href: '/dashboard/trends',
    section: 'intelligence',
    icon: Radar,
    ready: true,
    sprint: 2,
    description: 'Daily digests of what your market is talking about.',
  },
  {
    label: 'Marketing Advisor',
    href: '/dashboard/advisor',
    section: 'intelligence',
    icon: Lightbulb,
    ready: true,
    description:
      'Campaign opportunities inspired by competitor activity and market trends.',
  },
  {
    label: 'Marketing Planner',
    href: '/dashboard/planner',
    section: 'create',
    icon: CalendarRange,
    ready: true,
    description: 'Turn your goals into a dated monthly content calendar.',
  },
  {
    label: 'Content Studio',
    href: '/dashboard/content',
    section: 'create',
    icon: PenLine,
    ready: true,
    sprint: 3,
    description: 'Generate on-brand posts, carousels, and threads.',
  },
  {
    label: 'Campaigns',
    href: '/dashboard/campaigns',
    section: 'create',
    icon: Megaphone,
    ready: true,
    sprint: 6,
    description: 'Orchestrate content, outreach, and discovery into one plan.',
  },
  {
    label: 'Leads',
    href: '/dashboard/leads',
    section: 'grow',
    icon: Target,
    ready: true,
    sprint: 5,
    description: 'Discover and qualify prospects from public sources.',
  },
  {
    label: 'Outreach',
    href: '/dashboard/outreach',
    section: 'grow',
    icon: Send,
    ready: true,
    sprint: 4,
    description: 'Draft personalized outreach — reviewed before it sends.',
  },
  {
    label: 'Engagement',
    href: '/dashboard/engagement',
    section: 'grow',
    icon: MessageCircle,
    ready: true,
    sprint: 4,
    description: 'Suggested replies and comments, approved by you.',
  },
  {
    label: 'Competitors',
    href: '/dashboard/competitors',
    section: 'intelligence',
    icon: Users,
    ready: true,
    sprint: 4,
    description: 'Track competitor activity and positioning.',
  },
  {
    label: 'Marketing Memory',
    href: '/dashboard/memory',
    section: 'measure',
    icon: Brain,
    ready: true,
    sprint: 5,
    description: 'What we’ve learned about your audience — smarter every week.',
  },
  {
    label: 'Analytics',
    href: '/dashboard/analytics',
    section: 'measure',
    icon: BarChart3,
    ready: true,
    sprint: 6,
    description: 'Measure what your marketing is actually doing.',
  },
  {
    label: 'Connectors',
    href: '/dashboard/connectors',
    section: 'setup',
    icon: Plug,
    ready: true,
    description: 'Connect your marketing tools and data sources.',
  },
  {
    label: 'Settings',
    href: '/dashboard/settings',
    icon: Settings,
    ready: true,
    section: 'setup',
  },
];

export function findNavItem(href: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.href === href);
}

/** Nav items grouped into sections, preserving NAV_SECTIONS order. */
export function navBySection(): { id: NavSection; label: string; items: NavItem[] }[] {
  return NAV_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    items: NAV_ITEMS.filter((i) => i.section === section.id),
  })).filter((section) => section.items.length > 0);
}
