import { z } from 'zod';
import type { ContentDraft } from '@prisma/client';

import { can } from '@/lib/rbac';
import type { OutboundContent } from '@/lib/whatsapp';
import { bold, clip, openInAura, plain } from '@/lib/whatsapp-format';
import { SOCIAL_NETWORKS } from '@/lib/whatsapp-intent';
import type { ContentTypeKey } from '@/lib/validations/content';
import { getEnabledContentTypes } from '@/server/company/profile.service';
import { getDraft } from '@/server/content/content.service';
import { previewPublishing, type MultiPlatform, type PlatformResult } from '@/server/content/multi-publish.service';
import { generatePostTool } from '@/server/whatsapp/tools/content';
import { newPending, readState, writeState } from '@/server/whatsapp/tools/state';
import { text, type Tool, type ToolContext, type ToolResult } from '@/server/whatsapp/tools/types';

/**
 * Social publishing from WhatsApp — the conversation around Content Studio's
 * one-click publishing (server/content/multi-publish.service.ts), never a
 * second implementation of it:
 *
 *   "Create a marketing post for all my social media accounts"
 *   → which networks?  → the post, written by Content Studio
 *   → each network's preview: exactly what it receives, whether it can go
 *   → "Approve & publish" → a confirmation naming the exact networks
 *   → the same approval and publishing as the web page → results per network
 *
 * Publishing needs OWNER/ADMIN (content:publish, and content:approve when it
 * isn't approved yet) and an explicit yes. Members can write and submit.
 */

const LABEL: Record<MultiPlatform, string> = { FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', LINKEDIN: 'LinkedIn' };
const AWAIT_TTL_MS = 10 * 60_000;
const platformsArg = z.array(z.enum(SOCIAL_NETWORKS)).min(1).max(3);

export const listNames = (ps: string[]) => {
  const names = ps.map((p) => LABEL[p as MultiPlatform] ?? p);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

/** Which networks? All combinations fit one list (7 rows). */
export function platformPicker(lead: string): OutboundContent {
  const F = 'FACEBOOK', I = 'INSTAGRAM', L = 'LINKEDIN';
  const combos: [string[], string][] = [
    [[F, I, L], 'All three'],
    [[F, I], 'Facebook + Instagram'],
    [[F, L], 'Facebook + LinkedIn'],
    [[I, L], 'Instagram + LinkedIn'],
    [[F], 'Facebook only'],
    [[I], 'Instagram only'],
    [[L], 'LinkedIn only'],
  ];
  return {
    kind: 'list',
    body: `${lead}\n\nOr type them, e.g. “Facebook and Instagram”.`,
    button: 'Choose networks',
    sections: [{ rows: combos.map(([ps, title]) => ({ id: `plat:${ps.join(',')}`, title })) }],
  };
}

/** Each chosen network's preview, and the next step this person may take. */
async function previewMessage(ctx: ToolContext, draft: ContentDraft, targets: string[], lead?: string): Promise<OutboundContent> {
  const preview = (await previewPublishing(ctx.companyId, draft)).filter((p) => targets.includes(p.platform));
  const parts = preview.map((p) => {
    const state = p.publication?.status === 'PUBLISHED' ? '✅ already published' : p.ready ? '✅ ready' : `⚠️ ${p.blockers.join(' ')}`;
    return `${bold(p.label)} — ${plain(state)}\n${clip(plain(p.text), 200)}`;
  });
  const approved = draft.status === 'APPROVED' || draft.status === 'PUBLISHED';
  const mayPublish = can(ctx.role, 'content:publish') && (approved || can(ctx.role, 'content:approve'));
  const anyReady = preview.some((p) => p.ready);
  const needsImage = preview.some((p) => p.platform === 'INSTAGRAM' && p.blockers.some((b) => /need an image/.test(b)));
  const buttons: { id: string; title: string }[] = [];
  if (mayPublish && anyReady) buttons.push({ id: 'pub:go', title: approved ? 'Publish' : 'Approve & publish' });
  if (needsImage && can(ctx.role, 'content:create')) buttons.push({ id: `act:image:${draft.id}`, title: 'Create image' });
  if (!mayPublish && can(ctx.role, 'content:create') && !approved && draft.status !== 'PENDING_APPROVAL') {
    buttons.push({ id: `act:submit:${draft.id}`, title: 'Submit for approval' });
  }
  if (can(ctx.role, 'content:create') && draft.status !== 'PUBLISHED' && buttons.length < 3) buttons.push({ id: `act:edit:${draft.id}`, title: 'Edit' });
  const body = `${lead ? `${lead}\n\n` : ''}${bold('How it will look')}\n\n${parts.join('\n\n')}`;
  const footer = mayPublish ? '' : can(ctx.role, 'content:create') ? '\n\nAn owner or admin approves and publishes it.' : '';
  const message = `${body}${footer}`;
  return buttons.length ? { kind: 'buttons', body: message, buttons: buttons.slice(0, 3) } : text(message);
}

// ---------------------------------------------------------------------------

const planArgs = z.object({ topic: z.string().trim().min(3).max(500).optional(), platforms: platformsArg.optional() }).strict();

export const planSocialPostTool: Tool<typeof planArgs> = {
  id: 'plan_social_post',
  category: 'content',
  label: 'Post to socials',
  description: 'Create one post for several social networks (Facebook, Instagram, LinkedIn), with a preview for each.',
  permission: 'content:create',
  inMenu: false,
  args: planArgs,
  async run(ctx, args) {
    const expiresAt = new Date(Date.now() + AWAIT_TTL_MS).toISOString();
    if (!args.platforms) {
      await writeState(ctx.linkId, ctx.companyId, { awaiting: { kind: 'platforms', ...(args.topic ? { topic: args.topic } : {}), expiresAt } });
      return { contents: [platformPicker('Which platforms?')] };
    }
    const platforms = SOCIAL_NETWORKS.filter((p) => args.platforms!.includes(p));
    if (!args.topic) {
      await writeState(ctx.linkId, ctx.companyId, { awaiting: { kind: 'social_topic', platforms, expiresAt } });
      return { contents: [text(`What should the post for ${listNames(platforms)} be about?`)] };
    }
    // One post that suits every chosen network: a caption-and-image post when
    // the workspace has that format (Instagram needs an image), else a LinkedIn post.
    const enabled = await getEnabledContentTypes(ctx.companyId);
    const type: ContentTypeKey = enabled.includes('IMAGE_POST') ? 'IMAGE_POST' : 'LINKEDIN_POST';
    const before = (await readState(ctx.linkId, ctx.companyId)).draftId;
    const written = await generatePostTool.run(ctx, {
      topic: args.topic,
      type,
      platform: platforms.includes('INSTAGRAM') ? 'INSTAGRAM' : platforms[0]!,
    });
    const after = await readState(ctx.linkId, ctx.companyId);
    // Not written (an error, a duplicate request): say what the writer said.
    if (!after.draftId || after.draftId === before || after.inFlight) return written;
    const draft = await getDraft(ctx.companyId, after.draftId);
    if (!draft) return written;
    await writeState(ctx.linkId, ctx.companyId, { targets: platforms });
    return { contents: [await previewMessage(ctx, draft, platforms, `✅ Written and saved as a draft in Content Studio, for ${listNames(platforms)}.`)] };
  },
};

const previewArgs = z.object({ platforms: platformsArg.optional(), draftId: z.string().max(40).optional() }).strict();

export const publishPreviewTool: Tool<typeof previewArgs> = {
  id: 'publish_preview',
  category: 'content',
  label: 'Preview per network',
  description: 'Show how the current post will look on each social network, and whether it can be published there.',
  permission: null,
  inMenu: false,
  args: previewArgs,
  async run(ctx, args) {
    const state = await readState(ctx.linkId, ctx.companyId);
    const draft = (args.draftId ?? state.draftId) ? await getDraft(ctx.companyId, (args.draftId ?? state.draftId)!) : null;
    if (!draft) return { contents: [text('Which post? Say “show my drafts” to pick one.')] };
    return { contents: [await previewMessage(ctx, draft, args.platforms ?? state.targets ?? [...SOCIAL_NETWORKS])] };
  },
};

const publishArgs = z.object({ platforms: platformsArg.optional(), draftId: z.string().max(40).optional() }).strict();

export const publishTool: Tool<typeof publishArgs> = {
  id: 'publish_draft',
  category: 'content',
  label: 'Publish',
  description: 'Publish the current post to the chosen social networks (asks for confirmation first).',
  permission: 'content:publish',
  inMenu: false,
  args: publishArgs,
  async run(ctx, args) {
    const state = await readState(ctx.linkId, ctx.companyId);
    const draftId = args.draftId ?? state.draftId;
    const draft = draftId ? await getDraft(ctx.companyId, draftId) : null;
    if (!draft) return { contents: [text('Which post? Say “show my drafts” to pick one.')] };
    const targets = args.platforms ?? state.targets;
    if (!targets?.length) {
      await writeState(ctx.linkId, ctx.companyId, {
        draftId: draft.id,
        awaiting: { kind: 'platforms', draftId: draft.id, expiresAt: new Date(Date.now() + AWAIT_TTL_MS).toISOString() },
      });
      return { contents: [platformPicker('Publish to which platforms?')] };
    }
    const approved = draft.status === 'APPROVED' || draft.status === 'PUBLISHED';
    if (!approved && !can(ctx.role, 'content:approve')) {
      return { contents: [text('It has to be approved first, and only owners and admins can approve.')] };
    }
    const preview = (await previewPublishing(ctx.companyId, draft)).filter((p) => targets.includes(p.platform));
    const ready = preview.filter((p) => p.ready).map((p) => p.platform);
    const notReady = preview.filter((p) => !p.ready);
    const skipped = notReady.length ? `\n\nNot included:\n${notReady.map((p) => `• ${p.label} — ${plain(p.blockers.join(' '))}`).join('\n')}` : '';
    if (!ready.length) return { contents: [text(`Nothing can be published right now.${skipped}`)] };

    const pending = newPending('publish', draft.id, false, ready);
    await writeState(ctx.linkId, ctx.companyId, { draftId: draft.id, targets, pending });
    return {
      contents: [
        {
          kind: 'buttons',
          body: `${approved ? 'Publish' : 'Approve and publish'} this post to ${bold(listNames(ready))} now?\n\nEach network gets exactly the text in the preview, through its official API, one after another.${skipped}`,
          buttons: [
            { id: `confirm:${pending.nonce}`, title: approved ? 'Yes, publish' : 'Yes, approve & publish' },
            { id: `cancel:${pending.nonce}`, title: 'Cancel' },
          ],
          footer: 'This confirmation expires in 10 minutes',
        },
      ],
    };
  },
};

/** The outcome, network by network. */
export function resultsMessage(results: PlatformResult[], draftId: string): ToolResult {
  const line = (r: PlatformResult) => {
    const name = LABEL[r.platform];
    if (r.status === 'published') return `✅ ${name} — published${r.url ? `: ${r.url}` : ''}`;
    if (r.status === 'processing') return `⏳ ${name} — processing the video. I’ll message you here when it’s live.`;
    if (r.status === 'failed') return `❌ ${name} — failed: ${plain(clip(r.message, 200))}`;
    if (r.status === 'manual') return `⚠️ ${name} — post it by hand: ${plain(clip(r.message, 200))}`;
    return `⏭ ${name} — ${plain(clip(r.message, 200))}`;
  };
  const retry = results.some((r) => r.status === 'failed' || r.status === 'manual')
    ? '\n\nTo try the ones that didn’t go again, say “publish”. Networks already published are never posted twice.'
    : '';
  return { contents: [text(`${results.map(line).join('\n')}${retry}\n\n${openInAura(`/dashboard/content/${draftId}`)}`)] };
}

export const SOCIAL_TOOLS = [planSocialPostTool, publishPreviewTool, publishTool];
