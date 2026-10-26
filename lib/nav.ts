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
  CalendarRange,
  Building2,
  Telescope,
  Sparkles,
  ClipboardCheck,
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
  /** Which primary group this belongs to. */
  group: NavGroupId;
}

/**
 * Primary navigation groups, in order.
 *
 * Twenty-one links in a sidebar is a menu of separate tools, not an assistant.
 * Labelled sections helped them read in an order, but every one of the
 * twenty-one was still on screen at once — so the page still asked the user to
 * find their own way around, and the review was blunt about it: too many tabs,
 * too much on every page.
 *
 * So the sidebar now shows SIX things. A group's children appear only when you
 * are in that group, which is the only time they are the answer to anything.
 * Every page keeps its URL — this moves nothing and deletes nothing, so no
 * link anywhere in the app, in an email, or in a bookmark breaks.
 *
 * `href` is where the group itself goes: its most useful child, not a landing
 * page that exists only to list the others.
 */
export const NAV_GROUPS = [
  {
    id: 'home',
    label: 'Home',
    href: '/dashboard',
    icon: LayoutDashboard,
    description: 'What needs you today, and what Aura suggests doing next.',
  },
  {
    id: 'market',
    label: 'Your market',
    href: '/dashboard/intelligence',
    icon: Radar,
    description: 'How your marketing is doing, what your market is talking about, and what to act on.',
  },
  {
    id: 'create',
    label: 'Create',
    href: '/dashboard/content',
    icon: PenLine,
    description: 'Plan, write and publish your content and campaigns.',
  },
  {
    id: 'customers',
    label: 'Customers',
    href: '/dashboard/leads',
    icon: Target,
    description: 'Find people worth contacting, reach out, and reply to them.',
  },
  {
    id: 'results',
    label: 'Results',
    href: '/dashboard/analytics',
    icon: BarChart3,
    description: 'Real numbers from what you published, and what works for you.',
  },
  {
    id: 'setup',
    label: 'Setup',
    href: '/dashboard/settings',
    icon: Settings,
    description: 'What Aura knows about your business, and the tools it is connected to.',
  },
] as const;

export type NavGroupId = (typeof NAV_GROUPS)[number]['id'];

export const NAV_ITEMS: NavItem[] = [
  {
    label: 'Home',
    href: '/dashboard',
    icon: LayoutDashboard,
    ready: true,
    group: 'home',
  },
  {
    label: 'Aura Suggests',
    href: '/dashboard/suggestions',
    icon: Sparkles,
    ready: true,
    group: 'home',
    description: 'What Aura thinks you should do next, why, and the evidence behind it.',
  },
  {
    label: 'Review & approve',
    href: '/dashboard/review',
    icon: ClipboardCheck,
    ready: true,
    group: 'home',
    description: 'Everything Aura made that is waiting on you, reviewed and approved in one place.',
  },
  {
    label: 'Marketing health',
    href: '/dashboard/intelligence',
    group: 'market',
    icon: Gauge,
    ready: true,
    description:
      'One score for how your marketing is doing, and what to fix first.',
  },
  {
    label: 'Market trends',
    href: '/dashboard/trends',
    group: 'market',
    icon: Radar,
    ready: true,
    sprint: 2,
    description: 'What your market is talking about right now, and an angle for each topic.',
  },
  {
    label: 'Opportunities',
    href: '/dashboard/opportunities',
    group: 'market',
    icon: Telescope,
    ready: true,
    description:
      'What Aura noticed you could act on, why, and the evidence behind each one.',
  },
  {
    label: 'Content plan',
    href: '/dashboard/planner',
    group: 'create',
    icon: CalendarRange,
    ready: true,
    description: 'Turn your goals into a month of dated, ready-to-write posts.',
  },
  {
    label: 'Content Studio',
    href: '/dashboard/content',
    group: 'create',
    icon: PenLine,
    ready: true,
    sprint: 3,
    description: 'Write posts in your voice, add a graphic, and queue them up.',
  },
  {
    label: 'Publishing',
    href: '/dashboard/executions',
    group: 'create',
    icon: Send,
    ready: true,
    description: 'Everything approved to publish: scheduled, publishing, published, and what needs you.',
  },
  {
    label: 'Campaigns',
    href: '/dashboard/campaigns',
    group: 'create',
    icon: Megaphone,
    ready: true,
    sprint: 6,
    description: 'Run one of your goals across content, outreach and leads at once.',
  },
  {
    label: 'Leads',
    href: '/dashboard/leads',
    group: 'customers',
    icon: Target,
    ready: true,
    sprint: 5,
    description: 'Find people worth contacting, scored against who you sell to.',
  },
  {
    label: 'Outreach',
    href: '/dashboard/outreach',
    group: 'customers',
    icon: Send,
    ready: true,
    sprint: 4,
    description: 'Personalised messages to those people — you approve every one.',
  },
  {
    label: 'Comments & replies',
    href: '/dashboard/engagement',
    group: 'customers',
    icon: MessageCircle,
    ready: true,
    sprint: 4,
    description: 'Suggested replies for posts you want to be seen commenting on.',
  },
  {
    label: 'Competitors',
    href: '/dashboard/competitors',
    group: 'market',
    icon: Users,
    ready: true,
    sprint: 4,
    description: 'What your competitors changed this week, and what it means for you.',
  },
  {
    label: 'Results',
    href: '/dashboard/analytics',
    group: 'results',
    icon: BarChart3,
    ready: true,
    sprint: 6,
    description: 'Real numbers from what you published — reach, replies, and trends.',
  },
  {
    label: 'What works for you',
    href: '/dashboard/memory',
    group: 'results',
    icon: Brain,
    ready: true,
    sprint: 5,
    description: 'Patterns learned from your own results — what to do more of.',
  },
  {
    label: 'About my business',
    href: '/dashboard/business',
    group: 'setup',
    icon: Building2,
    ready: true,
    description: 'What Aura knows about your business, and what you still need to tell it.',
  },
  {
    label: 'Your tools',
    href: '/dashboard/connectors',
    group: 'setup',
    icon: Plug,
    ready: true,
    description: 'Connect LinkedIn, analytics and your CRM so Aura uses real data.',
  },
  {
    label: 'WhatsApp assistant',
    href: '/dashboard/whatsapp-assistant',
    group: 'setup',
    icon: MessageCircle,
    ready: true,
    description: 'Use Aura from WhatsApp, link your number, and see how your team uses it.',
  },
  {
    label: 'Settings',
    href: '/dashboard/settings',
    icon: Settings,
    ready: true,
    group: 'setup',
  },
];

export function findNavItem(href: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.href === href);
}

export interface NavGroupView {
  id: NavGroupId;
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
  items: NavItem[];
}

/** The six groups with their pages, in NAV_GROUPS order. */
export function navByGroup(): NavGroupView[] {
  return NAV_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    href: group.href,
    icon: group.icon,
    description: group.description,
    items: NAV_ITEMS.filter((i) => i.group === group.id),
  })).filter((group) => group.items.length > 0);
}

/**
 * Which group a path belongs to — the group whose own href or any of whose
 * pages matches it.
 *
 * Longest match wins, because `/dashboard` is a prefix of every route: a
 * `startsWith` scan in declaration order would put every page in Home and the
 * sidebar would never open the group the user is actually in.
 */
export function groupForPath(pathname: string): NavGroupId {
  let best: { group: NavGroupId; length: number } | null = null;
  for (const item of NAV_ITEMS) {
    const matches =
      item.href === '/dashboard'
        ? pathname === '/dashboard'
        : pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (matches && (!best || item.href.length > best.length)) {
      best = { group: item.group, length: item.href.length };
    }
  }
  // A page with no nav entry of its own (a detail route, say) still belongs
  // somewhere; fall back to the group whose href it sits under.
  if (!best) {
    for (const group of NAV_GROUPS) {
      // The same boundary check as above, and for the same reason: a bare
      // `startsWith` lets /dashboard/content claim /dashboard/contentfoo.
      if (group.href !== '/dashboard' && pathname.startsWith(`${group.href}/`)) {
        return group.id;
      }
    }
  }
  return best?.group ?? 'home';
}
