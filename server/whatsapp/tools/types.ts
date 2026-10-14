import type { CompanyRole } from '@prisma/client';
import type { z } from 'zod';

import type { OutboundContent, WhatsAppConfig } from '@/lib/whatsapp';
import type { Permission } from '@/lib/rbac';

/**
 * The WhatsApp agent's tools — a fixed, typed registry over EXISTING Aura
 * services. The AI router may only name a tool from this registry and pass
 * arguments its schema accepts; the server decides whether the person may run
 * it (their current role in their active workspace) and runs it with the
 * workspace from their session — never from the message or the model.
 */

/** Who is asking, resolved fresh from the session for this one message. */
export interface ToolContext {
  conversationId: string;
  linkId: string;
  userId: string;
  companyId: string;
  companyName: string;
  role: CompanyRole;
  /** The inbound message being answered (idempotency markers key on it). */
  messageId: string;
  config: WhatsAppConfig;
  fetchImpl?: typeof fetch;
  /** Send something now (e.g. "Writing…") before a slow step finishes. */
  sendNow: (content: OutboundContent) => Promise<void>;
}

export interface ToolResult {
  contents: OutboundContent[];
}

export type ToolCategory =
  | 'dashboard'
  | 'content'
  | 'campaigns'
  | 'opportunities'
  | 'suggestions'
  | 'business'
  | 'calendar'
  | 'approvals'
  | 'analytics'
  | 'connections'
  | 'account';

export interface Tool<A extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;
  category: ToolCategory;
  /** Short label for a menu row (≤ 24 chars). */
  label: string;
  /** One line for the menu and for the AI router. */
  description: string;
  /** Needed to run it; null = anyone in the workspace (read-only). */
  permission: Permission | null;
  /** Shown in menus; false for tools reached only from another tool. */
  inMenu: boolean;
  args: A;
  // Method syntax (bivariant), so tools with different argument schemas sit
  // in one registry; runTool validates arguments with `args` before calling.
  run(ctx: ToolContext, args: z.infer<A>): Promise<ToolResult>;
}

export const text = (t: string): OutboundContent => ({ kind: 'text', text: t });
