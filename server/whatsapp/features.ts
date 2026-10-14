import type { CompanyRole } from '@prisma/client';

import { CATEGORIES, mayUse, TOOLS } from '@/server/whatsapp/tools/registry';

/**
 * What a person can do with Aura on WhatsApp, in their role — read from the
 * same tool registry the assistant runs on (server/whatsapp/tools/registry.ts),
 * so this list and the WhatsApp menu cannot drift apart.
 */

/** Tools that change something: they ask, then need an explicit yes. */
const CONFIRMED = new Set(['approve_draft', 'reject_draft', 'publish_draft']);

export interface FeatureCategory {
  id: string;
  label: string;
  description: string;
  tools: {
    id: string;
    label: string;
    description: string;
    /** In the WhatsApp menu; the others are reached by asking ("approve this"). */
    inMenu: boolean;
    needsConfirmation: boolean;
  }[];
}

export function whatsAppFeatures(role: CompanyRole): FeatureCategory[] {
  return CATEGORIES.map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description,
    tools: TOOLS.filter((t) => t.category === c.id && mayUse(t, role)).map((t) => ({
      id: t.id,
      label: t.label,
      description: t.description,
      inMenu: t.inMenu,
      needsConfirmation: CONFIRMED.has(t.id),
    })),
  })).filter((c) => c.tools.length > 0);
}

/** Words that work anywhere in the conversation. */
export const WHATSAPP_COMMANDS = [
  { word: 'MENU', does: 'Show the menu.' },
  { word: 'SWITCH', does: 'Choose another of your workspaces.' },
  { word: 'LOGOUT', does: 'Unlink this number from your Aura account.' },
  { word: 'STOP', does: 'Stop all messages from Aura (START to resume).' },
] as const;
