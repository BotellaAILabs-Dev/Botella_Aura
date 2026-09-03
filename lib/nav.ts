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
  /**
   * What a marketer would call this, not what the team building it calls it.
   *
   * Labels used to be product names — "Marketing Memory", "AI Trend Insights",
   * "Connectors". Those describe the machinery. A user scanning a sidebar is
   * asking "which of these gets me what I need right now", and a name that only
   * makes sense once you already know the feature cannot answer that.
   */
  label: string;
  href: string;
  icon: LucideIcon;
  ready: boolean;
  sprint?: number;
  /**
   * One line, in the second person, describing what the USER gets.
   *
   * Rendered as the sidebar tooltip and available to page headers. Written as
   * an outcome ("what your market is talking about") rather than a mechanism
   * ("daily digests aggregated from four sources").
   */
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
  { id: 'intelligence', label: 'Know your market' },
  { id: 'create', label: 'Create content' },
  { id: 'grow', label: 'Find customers' },
  { id: 'measure', label: 'See what worked' },
  { id: 'setup', label: 'Setup' },
] as const;

export type NavSection = (typeof NAV_SECTIONS)[number]['id'];

export const NAV_ITEMS: NavItem[] = [
  {
    label: 'Home',
    href: '/dashboard',
    icon: LayoutDashboard,
    ready: true,
    section: 'overview',
  },
  {
    label: 'Marketing health',
    href: '/dashboard/intelligence',
    section: 'intelligence',
    icon: Gauge,
    ready: true,
    description:
      'One score for how your marketing is doing, and what to fix first.',
  },
  {
    label: 'Market trends',
    href: '/dashboard/trends',
    section: 'intelligence',
    icon: Radar,
    ready: true,
    sprint: 2,
    description: 'What your market is talking about right now, and an angle for each topic.',
  },
  {
    label: 'Opportunities',
    href: '/dashboard/advisor',
    section: 'intelligence',
    icon: Lightbulb,
    ready: true,
    description:
      'Campaign ideas worth your time, with the evidence behind each one.',
  },
  {
    label: 'Content plan',
    href: '/dashboard/planner',
    section: 'create',
    icon: CalendarRange,
    ready: true,
    description: 'Turn your goals into a month of dated, ready-to-write posts.',
  },
  {
    label: 'Content Studio',
    href: '/dashboard/content',
    section: 'create',
    icon: PenLine,
    ready: true,
    sprint: 3,
    description: 'Write posts in your voice, add a graphic, and queue them up.',
  },
  {
    label: 'Campaigns',
    href: '/dashboard/campaigns',
    section: 'create',
    icon: Megaphone,
    ready: true,
    sprint: 6,
    description: 'Run one of your goals across content, outreach and leads at once.',
  },
  {
    label: 'Leads',
    href: '/dashboard/leads',
    section: 'grow',
    icon: Target,
    ready: true,
    sprint: 5,
    description: 'Find people worth contacting, scored against who you sell to.',
  },
  {
    label: 'Outreach',
    href: '/dashboard/outreach',
    section: 'grow',
    icon: Send,
    ready: true,
    sprint: 4,
    description: 'Personalised messages to those people — you approve every one.',
  },
  {
    label: 'Comments & replies',
    href: '/dashboard/engagement',
    section: 'grow',
    icon: MessageCircle,
    ready: true,
    sprint: 4,
    description: 'Suggested replies for posts you want to be seen commenting on.',
  },
  {
    label: 'Competitors',
    href: '/dashboard/competitors',
    section: 'intelligence',
    icon: Users,
    ready: true,
    sprint: 4,
    description: 'What your competitors changed this week, and what it means for you.',
  },
  {
    label: 'What works for you',
    href: '/dashboard/memory',
    section: 'measure',
    icon: Brain,
    ready: true,
    sprint: 5,
    description: 'Patterns learned from your own results — what to do more of.',
  },
  {
    label: 'Results',
    href: '/dashboard/analytics',
    section: 'measure',
    icon: BarChart3,
    ready: true,
    sprint: 6,
    description: 'Real numbers from what you published — reach, replies, and trends.',
  },
  {
    label: 'Your tools',
    href: '/dashboard/connectors',
    section: 'setup',
    icon: Plug,
    ready: true,
    description: 'Connect LinkedIn, analytics and your CRM so Aura uses real data.',
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
