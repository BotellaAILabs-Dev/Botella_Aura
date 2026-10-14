import type { WhatsAppConversation, WhatsAppMessage } from '@prisma/client';

import { db } from '@/lib/db';
import { absoluteUrl } from '@/lib/app-url';
import { optKeyword, type OutboundContent, type WhatsAppConfig } from '@/lib/whatsapp';
import {
  LINK_TTL_MS,
  MAX_CODE_ATTEMPTS,
  parseCommand,
  parseLinkCode,
  REPLY_IDS,
  ROLE_LABEL,
} from '@/lib/whatsapp-link';
import { recordAudit } from '@/server/services/audit.service';
import {
  completeWithCode,
  issueChallenge,
  pendingCodeChallenge,
  resolveSession,
  selectWorkspace,
  unlinkConversation,
  type Session,
} from '@/server/whatsapp/link.service';
import { route } from '@/server/whatsapp/router';
import { mainMenu } from '@/server/whatsapp/tools/registry';
import { writeState } from '@/server/whatsapp/tools/state';

/**
 * What the assistant says to one inbound message.
 *
 * Order matters, and every private step re-checks the session:
 *   1. STOP / START — always honoured, signed in or not
 *   2. opted out → silence
 *   3. a 6-digit code while a website confirmation waits → finish linking
 *   4. not linked, or the link expired → the welcome and a sign-in link
 *   5. account commands: log out, switch workspace, pick a workspace
 *   6. no workspace chosen → ask which one
 *   7. signed in with a workspace → the assistant: menus, typed requests
 *      and Aura's features, through the tool router (router.ts)
 *
 * Side effects (opt-out, linking, workspace choice) happen here; sending is
 * the caller's job (handler.ts).
 */

export interface AgentReply {
  contents: OutboundContent[];
  /** The workspace the message was handled in, when there was one. */
  companyId?: string;
  /** Send even though they have opted out (only the opt-out confirmation). */
  allowOptedOut?: boolean;
}

const silent: AgentReply = { contents: [] };
const text = (t: string): OutboundContent => ({ kind: 'text', text: t });

export const OPT_OUT_TEXT =
  'You won’t receive any more messages from Botella Aura on WhatsApp. Reply START at any time to turn them back on.';
export const OPT_IN_TEXT = 'You’re back on. Send “Hi” to continue — reply STOP at any time to stop messages.';
export const WELCOME_TEXT =
  'Welcome to Botella Aura!\n\nYour AI-powered marketing assistant.\n\nPlease log in to access your Aura workspace.';
export const EXPIRED_TEXT = 'Your Aura sign-in on WhatsApp has expired. Please log in again to continue.';
export const LOGGED_OUT_TEXT =
  'You’ve been logged out of Aura on this WhatsApp number. Send “Hi” whenever you want to log in again.';

const minutes = Math.round(LINK_TTL_MS / 60_000);

function signInMessage(lead: string, url: string): OutboundContent {
  return {
    kind: 'cta',
    body: `${lead}\n\nTap the button, sign in to Aura as usual, and confirm. You’ll get a code to send back here. Never share your password on WhatsApp — Aura will never ask for it here.`,
    buttonText: 'Log in to Aura',
    url,
    footer: `Single-use link · expires in ${minutes} minutes`,
  };
}

async function signIn(conversationId: string, lead: string): Promise<AgentReply> {
  const issued = await issueChallenge(conversationId);
  if ('rateLimited' in issued) {
    return {
      contents: [
        text('You’ve asked for several sign-in links in the last hour. Please use the most recent one, or try again later.'),
      ],
    };
  }
  return { contents: [signInMessage(lead, issued.url)] };
}

function workspacePicker(session: Extract<Session, { state: 'linked' }>, lead?: string): OutboundContent {
  if (session.companies.length === 0) {
    return text(
      `${lead ? `${lead}\n\n` : ''}Your Aura account isn’t part of any workspace yet. Create one at ${absoluteUrl('/onboarding')} and then send “Hi” here.`,
    );
  }
  return {
    kind: 'list',
    body: `${lead ? `${lead}\n\n` : ''}Which business workspace would you like to use?`,
    button: 'Choose workspace',
    sections: [
      {
        rows: session.companies.slice(0, 10).map((c) => ({
          id: `${REPLY_IDS.workspacePrefix}${c.id}`,
          title: c.name,
          description: `You’re ${ROLE_LABEL[c.role] ?? c.role}`,
        })),
      },
    ],
  };
}

function home(session: Extract<Session, { state: 'linked' }>, lead?: string): OutboundContent {
  return mainMenu(session.active!.name, session.active!.role, lead);
}

export async function decide(input: {
  conversation: WhatsAppConversation;
  message: Pick<WhatsAppMessage, 'id' | 'body' | 'type' | 'payload'>;
  config: WhatsAppConfig;
  fetchImpl?: typeof fetch;
  /** Send something at once (before a slow step finishes), for a workspace. */
  sendNow: (content: OutboundContent, companyId?: string) => Promise<void>;
}): Promise<AgentReply> {
  const { conversation, message } = input;
  const replyId = (message.payload as { replyId?: string } | null)?.replyId ?? null;

  // 1–2. Opt-out and opt-in, before anything else.
  const keyword = optKeyword(message.body);
  if (keyword) {
    const optedOut = keyword === 'stop';
    if (conversation.optedOut !== optedOut) {
      await db.whatsAppConversation.update({
        where: { id: conversation.id },
        data: { optedOut, optedOutAt: optedOut ? new Date() : null },
      });
      await recordAudit({
        action: optedOut ? 'WHATSAPP_OPTED_OUT' : 'WHATSAPP_OPTED_IN',
        metadata: { conversationId: conversation.id },
      });
    }
    return optedOut ? { contents: [text(OPT_OUT_TEXT)], allowOptedOut: true } : { contents: [text(OPT_IN_TEXT)] };
  }
  if (conversation.optedOut) return silent;

  // 3. Finishing a link: the code shown on the website, sent from this number.
  const code = parseLinkCode(message.body);
  if (code && (await pendingCodeChallenge(conversation.id))) {
    const outcome = await completeWithCode({ conversationId: conversation.id, code });
    if (!outcome.ok) {
      const reply = {
        wrong: 'That code isn’t right. Check the code on the Aura page and send it again.',
        locked: `That was ${MAX_CODE_ATTEMPTS} wrong codes, so this sign-in has been cancelled for your safety. Send “Hi” for a new link.`,
        expired: 'That code has expired. Send “Hi” for a new sign-in link.',
        no_pending: 'There’s no sign-in waiting for a code. Send “Hi” to start.',
      }[outcome.reason];
      return { contents: [text(reply)] };
    }
    const session = await resolveSession(conversation.id);
    if (session.state !== 'linked') return signIn(conversation.id, EXPIRED_TEXT);
    const lead = `✅ This WhatsApp number is now linked to your Aura account (${outcome.email}).`;
    return { contents: [session.active ? home(session, lead) : workspacePicker(session, lead)] };
  }

  // 4. Not signed in.
  const session = await resolveSession(conversation.id);
  if (session.state === 'unlinked') return signIn(conversation.id, WELCOME_TEXT);
  if (session.state === 'expired') return signIn(conversation.id, EXPIRED_TEXT);

  // 5. Account commands.
  const command = parseCommand(message.body, replyId);
  // Any account command (menu, switch, logout, a workspace) means they moved
  // on: a pending approve/publish lapses, so a later "ok" cannot run it.
  if (command && session.active) {
    await writeState(session.link.id, session.active.companyId, { pending: undefined });
  }
  if (command?.kind === 'logout') {
    await unlinkConversation(conversation.id);
    return { contents: [text(LOGGED_OUT_TEXT)] };
  }
  if (command?.kind === 'switch') return { contents: [workspacePicker(session)] };
  if (command?.kind === 'select_workspace') {
    try {
      const chosen = await selectWorkspace({ conversationId: conversation.id, companyId: command.companyId });
      const fresh = await resolveSession(conversation.id);
      if (fresh.state !== 'linked' || !fresh.active) return { contents: [workspacePicker(session)] };
      return { contents: [home(fresh, `You’re now working in *${chosen.name}*.`)], companyId: chosen.companyId };
    } catch {
      return { contents: [workspacePicker(session, 'That workspace isn’t available to you.')] };
    }
  }

  // 6. No workspace yet (or access to the last one was removed).
  if (!session.active) {
    return {
      contents: [
        workspacePicker(
          session,
          session.lostAccess === 'turned_off'
            ? 'WhatsApp access has been turned off for the workspace you were using.'
            : session.lostAccess
              ? 'You no longer have access to the workspace you were using.'
              : undefined,
        ),
      ],
    };
  }

  // 7. Signed in, workspace chosen: the assistant. Who, where and with which
  // role come from the session just resolved — never from the message.
  const companyId = session.active.companyId;
  if (command?.kind === 'menu') return { contents: [home(session)], companyId };
  const result = await route(
    {
      conversationId: conversation.id,
      linkId: session.link.id,
      userId: session.user.id,
      companyId: session.active.companyId,
      companyName: session.active.name,
      role: session.active.role,
      messageId: message.id,
      config: input.config,
      fetchImpl: input.fetchImpl,
      sendNow: (content) => input.sendNow(content, companyId),
    },
    { body: message.body, replyId },
  );
  return { contents: result.contents, companyId };
}
