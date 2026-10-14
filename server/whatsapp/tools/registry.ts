import type { CompanyRole } from '@prisma/client';

import { can } from '@/lib/rbac';
import type { OutboundContent } from '@/lib/whatsapp';
import { bold, plain } from '@/lib/whatsapp-format';
import { ROLE_LABEL } from '@/lib/whatsapp-link';
import { APPROVAL_TOOLS } from '@/server/whatsapp/tools/approval';
import { CONNECT_TOOLS } from '@/server/whatsapp/tools/connect';
import { CONTENT_TOOLS } from '@/server/whatsapp/tools/content';
import { READ_TOOLS } from '@/server/whatsapp/tools/read';
import { SOCIAL_TOOLS } from '@/server/whatsapp/tools/social';
import type { Tool, ToolCategory } from '@/server/whatsapp/tools/types';

/**
 * The tool registry and the feature menu.
 *
 * Built from the features that exist in Aura (lib/nav.ts) and mapped to the
 * services behind them. Menus are hierarchical because a WhatsApp list holds
 * at most 10 rows: categories first, then a category's actions. Only what
 * the person's CURRENT role allows is ever offered — and the router checks
 * again before running anything.
 */

export const TOOLS: Tool[] = [...READ_TOOLS, ...CONTENT_TOOLS, ...SOCIAL_TOOLS, ...APPROVAL_TOOLS, ...CONNECT_TOOLS];

const BY_ID = new Map(TOOLS.map((t) => [t.id, t]));

export function toolById(id: string): Tool | undefined {
  return BY_ID.get(id);
}

export function mayUse(tool: Tool, role: CompanyRole): boolean {
  return !tool.permission || can(role, tool.permission);
}

export const CATEGORIES: { id: ToolCategory; label: string; description: string }[] = [
  { id: 'dashboard', label: 'Dashboard', description: 'What matters today' },
  { id: 'content', label: 'Content Studio', description: 'Drafts, new posts, images' },
  { id: 'campaigns', label: 'Campaigns', description: 'Active campaigns and what they need' },
  { id: 'opportunities', label: 'AI Opportunities', description: 'What Aura has spotted' },
  { id: 'suggestions', label: 'Recommendations', description: 'What Aura suggests doing' },
  { id: 'business', label: 'Business Context', description: 'What Aura knows about you' },
  { id: 'calendar', label: 'Content Calendar', description: 'Scheduled in the next 2 weeks' },
  { id: 'approvals', label: 'Pending Approvals', description: 'Waiting for review' },
  { id: 'analytics', label: 'Analytics', description: 'Last 30 days of results' },
  { id: 'connections', label: 'Connected Accounts', description: 'LinkedIn, Facebook, Instagram' },
  // An 11th category does not fit a list (10 rows): reached by "account".
  { id: 'account', label: 'Account Settings', description: 'Workspace, role, log out' },
];

/** The top-level menu: up to 10 categories this person can use. */
export function mainMenu(companyName: string, role: CompanyRole, lead?: string): OutboundContent {
  const usable = CATEGORIES.filter((c) => TOOLS.some((t) => t.category === c.id && t.inMenu && mayUse(t, role)));
  const rows = usable.slice(0, 10);
  return {
    kind: 'list',
    body: `${lead ? `${lead}\n\n` : ''}What would you like to do in ${bold(companyName)}? (${ROLE_LABEL[role] ?? role})\n\nPick from the menu or just ask — e.g. “show my latest opportunities” or “write a LinkedIn post about our new menu”.`,
    button: 'Menu',
    sections: [{ title: 'Aura', rows: rows.map((c) => ({ id: `cat:${c.id}`, title: c.label, description: c.description })) }],
    footer: usable.length > 10 ? 'Say “account” for account settings' : undefined,
  };
}

/**
 * A category's actions. One action → null (the caller runs it); several →
 * buttons (WhatsApp allows 3).
 */
export function categoryMenu(category: ToolCategory, role: CompanyRole): OutboundContent | null {
  if (category === 'content') {
    const buttons = [{ id: 'tool:drafts', title: 'Recent drafts' }];
    if (can(role, 'content:create')) {
      buttons.push({ id: 'tool:generate_post', title: 'Write a post' }, { id: 'tool:plan_social_post', title: 'Post to socials' });
    }
    if (buttons.length === 1) return null;
    return { kind: 'buttons', body: `${bold('Content Studio')} — what would you like to do?`, buttons };
  }
  if (category === 'connections') {
    const buttons = [{ id: 'tool:connections', title: 'See connections' }];
    if (can(role, 'company:update')) {
      buttons.push({ id: 'connect:linkedin', title: 'Connect LinkedIn' }, { id: 'connect:meta', title: 'Connect Facebook' });
    }
    if (buttons.length === 1) return null;
    return { kind: 'buttons', body: `${bold('Connected accounts')} — ${plain('see what is connected, or connect one.')}`, buttons };
  }
  return null;
}

/** The menu tool a category runs when it has only one action. */
export function categoryTool(category: ToolCategory, role: CompanyRole): Tool | undefined {
  return TOOLS.find((t) => t.category === category && t.inMenu && mayUse(t, role));
}
