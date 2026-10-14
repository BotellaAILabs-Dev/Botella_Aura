import { z } from 'zod';

import { absoluteUrl } from '@/lib/app-url';
import { bold } from '@/lib/whatsapp-format';
import { providerReadiness } from '@/server/connectors/providers';
import { isLinkedInConfigured } from '@/server/services/linkedin.service';
import { CONNECT_PROVIDERS, signIntent } from '@/server/whatsapp/connect-intent';
import { text, type Tool } from '@/server/whatsapp/tools/types';

/**
 * Start connecting a social account from WhatsApp. The person gets a button
 * to Aura's own site, where the provider's official sign-in runs (signed
 * intent: server/whatsapp/connect-intent.ts). No credential ever passes
 * through WhatsApp, and Aura confirms here when the connection completes
 * (server/whatsapp/notify.ts).
 */

const args = z.object({ provider: z.enum(CONNECT_PROVIDERS) }).strict();

const NAMES = { linkedin: 'LinkedIn', meta: 'Facebook & Instagram' } as const;

export const connectTool: Tool<typeof args> = {
  id: 'connect_account',
  category: 'connections',
  label: 'Connect an account',
  description: 'Connect LinkedIn, or Facebook & Instagram, to this workspace (opens the official sign-in in your browser).',
  // OWNER/ADMIN — the same people who can connect accounts in Settings.
  permission: 'company:update',
  inMenu: false,
  args,
  async run(ctx, { provider }) {
    const ready = provider === 'linkedin' ? isLinkedInConfigured() : providerReadiness('meta').connectable;
    if (!ready) {
      return { contents: [text(`${NAMES[provider]} isn’t set up on this Aura server yet, so it can’t be connected.`)] };
    }
    const url = absoluteUrl(`/whatsapp/connect/${signIntent({ userId: ctx.userId, companyId: ctx.companyId, provider })}`);
    return {
      contents: [
        {
          kind: 'cta',
          body: `Connect ${NAMES[provider]} to ${bold(ctx.companyName)}.\n\nThe button opens Aura in your browser; sign in to Aura if asked, then approve access on ${NAMES[provider]}’s own page. Never send passwords or codes from ${NAMES[provider]} here. I’ll confirm here when it’s connected.`,
          buttonText: `Connect ${provider === 'linkedin' ? 'LinkedIn' : 'Facebook'}`,
          url,
          footer: 'Link expires in 15 minutes',
        },
      ],
    };
  },
};

export const CONNECT_TOOLS = [connectTool];
