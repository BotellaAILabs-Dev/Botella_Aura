import { z } from 'zod';
import type { ContentDraft } from '@prisma/client';

import { can } from '@/lib/rbac';
import { rateLimit } from '@/lib/rate-limit';
import { CONTENT_STATUS_LABELS, CONTENT_TYPE_LABELS } from '@/lib/content-ui';
import { resolvePlatform, platformSpec, SOCIAL_PLATFORMS } from '@/lib/platforms';
import { bold, clip, openInAura, plain } from '@/lib/whatsapp-format';
import type { OutboundContent } from '@/lib/whatsapp';
import type { ContentTypeKey } from '@/lib/validations/content';
import { aiFailureMessage, ClaudeNotConfiguredError } from '@/server/ai/claude';
import { getEffectivePlan, requireEntitlement } from '@/server/billing/entitlements';
import { getEnabledContentTypes } from '@/server/company/profile.service';
import { getDraft } from '@/server/content/content.service';
import { generateDraft } from '@/server/content/generator';
import { renderForManual } from '@/server/content/render';
import { claimJob, completeJob, enqueueJob, failJob } from '@/server/jobs/job.service';
import { runJob } from '@/server/jobs/runners';
import { assetsThisMonth, attachAsset } from '@/server/media/asset.service';
import { generateImagePrompt } from '@/server/media/image-prompt.service';
import { isAnyProviderConfigured } from '@/server/media/providers';
import { runReviewAction } from '@/server/review/review-actions.service';
import { readState, writeState, type SessionState } from '@/server/whatsapp/tools/state';
import { text, type Tool, type ToolContext, type ToolResult } from '@/server/whatsapp/tools/types';

/**
 * Content Studio over WhatsApp — the same services the Content Studio pages
 * call, with the same checks their routes make (role, enabled formats, image
 * provider, plan allowance, rate limits). Drafts are saved in Aura as they
 * are written; nothing is approved or published from here without the
 * explicit confirmation step (approval.ts) and the existing approval rules.
 */

/** Formats that read well in a chat and can be written from a one-line brief. */
const CHAT_TYPES = ['LINKEDIN_POST', 'IMAGE_POST', 'TWEET_THREAD', 'CAROUSEL', 'EMAIL', 'AD', 'PROMO', 'BLOG'] as const;

const typeLabel = (t: string) => CONTENT_TYPE_LABELS[t as ContentTypeKey] ?? t;

/** A thrown service error, said plainly; unknown errors are re-thrown (the queue retries). */
function serviceMessage(err: unknown): string | null {
  if (err instanceof ClaudeNotConfiguredError) return 'Aura’s writer isn’t configured on this server yet.';
  const ai = aiFailureMessage(err);
  if (ai) return ai;
  if (err && typeof err === 'object' && 'status' in err && 'message' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number' && status < 500) return String((err as { message: unknown }).message);
  }
  return null;
}

async function loadDraft(ctx: ToolContext, draftId: string | undefined): Promise<ContentDraft | null> {
  const id = draftId ?? (await readState(ctx.linkId, ctx.companyId)).draftId;
  // Scoped to the session's workspace: another business's id finds nothing.
  return id ? getDraft(ctx.companyId, id) : null;
}

/**
 * Slow work already started for this very message (a retried job): don't
 * start — and pay for — it again. A marker older than a few minutes belongs
 * to a worker that died mid-way, so it no longer blocks.
 */
function inFlightFor(state: SessionState, messageId: string): boolean {
  const f = state.inFlight;
  return Boolean(f && f.messageId === messageId && Date.now() - new Date(f.startedAt).getTime() < 3 * 60_000);
}

const noDraft = (): ToolResult => ({
  contents: [text('Which post do you mean? Say “show my drafts” to pick one, or “write a LinkedIn post about …” to start a new one.')],
});

/** The draft as a WhatsApp message, with the actions this person may take on it. */
export function draftMessage(ctx: ToolContext, draft: ContentDraft, lead?: string): OutboundContent {
  const body = renderForManual(draft);
  const platform = resolvePlatform(draft.type as ContentTypeKey, draft.platform);
  const head = `${lead ? `${lead}\n\n` : ''}${bold(typeLabel(draft.type))} · ${platformSpec(platform).label} · ${CONTENT_STATUS_LABELS[draft.status]}`;
  const buttons: { id: string; title: string }[] = [];
  const mayCreate = can(ctx.role, 'content:create');
  const mayApprove = can(ctx.role, 'content:approve');
  if (draft.status === 'DRAFT' || draft.status === 'REJECTED') {
    if (mayApprove) buttons.push({ id: `act:approve:${draft.id}`, title: 'Approve' });
    else if (mayCreate) buttons.push({ id: `act:submit:${draft.id}`, title: 'Submit for approval' });
  }
  // Approved: straight to publishing (the networks are chosen next).
  if (draft.status === 'APPROVED' && can(ctx.role, 'content:publish')) {
    buttons.push({ id: `act:publish:${draft.id}`, title: 'Publish' });
  }
  if (draft.status === 'PENDING_APPROVAL' && mayApprove) {
    buttons.push({ id: `act:approve:${draft.id}`, title: 'Approve' }, { id: `act:reject:${draft.id}`, title: 'Reject' });
  }
  if (mayCreate && draft.status !== 'PUBLISHED' && buttons.length < 3) buttons.push({ id: `act:image:${draft.id}`, title: 'Create image' });
  if (mayCreate && draft.status !== 'PUBLISHED' && buttons.length < 3) buttons.push({ id: `act:edit:${draft.id}`, title: 'Edit' });
  const footer = mayCreate && draft.status !== 'PUBLISHED' ? '\n\nTo change it, reply with what to change (e.g. “make it shorter”).' : '';
  const message = `${head}\n\n${clip(body, 850)}${footer}\n\n${openInAura(`/dashboard/content/${draft.id}`)}`;
  return buttons.length ? { kind: 'buttons', body: message, buttons } : { kind: 'text', text: message };
}

// ---------------------------------------------------------------------------

const showArgs = z.object({ draftId: z.string().min(1).max(40).optional() }).strict();

export const showDraftTool: Tool<typeof showArgs> = {
  id: 'show_draft',
  category: 'content',
  label: 'Show a draft',
  description: 'Show one draft in full, with what can be done with it.',
  permission: null,
  inMenu: false,
  args: showArgs,
  async run(ctx, args) {
    const draft = await loadDraft(ctx, args.draftId);
    if (!draft) return noDraft();
    await writeState(ctx.linkId, ctx.companyId, { draftId: draft.id });
    return { contents: [draftMessage(ctx, draft)] };
  },
};

const generateArgs = z
  .object({
    topic: z.string().trim().min(3).max(500),
    type: z.enum(CHAT_TYPES).optional(),
    platform: z.enum(SOCIAL_PLATFORMS).optional(),
  })
  .strict();

export const generatePostTool: Tool<typeof generateArgs> = {
  id: 'generate_post',
  category: 'content',
  label: 'Write a post',
  description: 'Write a new post (LinkedIn, Instagram, X thread, email, ad…) about a topic, saved as a draft.',
  permission: 'content:create',
  inMenu: true,
  args: generateArgs,
  async run(ctx, args) {
    const type: ContentTypeKey =
      args.type ?? (args.platform === 'INSTAGRAM' || args.platform === 'FACEBOOK' ? 'IMAGE_POST' : args.platform === 'X' ? 'TWEET_THREAD' : 'LINKEDIN_POST');
    const enabled = await getEnabledContentTypes(ctx.companyId);
    if (!enabled.includes(type)) {
      return { contents: [text(`${typeLabel(type)} is turned off for ${bold(ctx.companyName)}. It can be enabled in Settings → Content formats.`)] };
    }
    // A retried job must not write (and pay for) the same post twice.
    const state = await readState(ctx.linkId, ctx.companyId);
    if (inFlightFor(state, ctx.messageId)) {
      return { contents: [text('I’m still finishing that post — it will be in your drafts in Content Studio.')] };
    }
    await writeState(ctx.linkId, ctx.companyId, {
      inFlight: { messageId: ctx.messageId, tool: 'generate_post', startedAt: new Date().toISOString() },
    });
    await ctx.sendNow(text(`✍️ Writing your ${typeLabel(type)} for ${plain(ctx.companyName)}… this takes about half a minute.`));
    try {
      const draft = await generateDraft({
        companyId: ctx.companyId,
        userId: ctx.userId,
        type,
        source: { kind: 'BRIEF', brief: args.topic },
        ...(args.platform ? { platform: args.platform } : {}),
        variations: 1,
      });
      await writeState(ctx.linkId, ctx.companyId, { draftId: draft.id, inFlight: undefined });
      return { contents: [draftMessage(ctx, draft, '✅ Saved as a draft in Content Studio.')] };
    } catch (err) {
      await writeState(ctx.linkId, ctx.companyId, { inFlight: undefined });
      const said = serviceMessage(err);
      if (said) return { contents: [text(`I couldn’t write that: ${said}`)] };
      throw err;
    }
  },
};

const editArgs = z.object({ instructions: z.string().trim().min(2).max(1000), draftId: z.string().max(40).optional() }).strict();

export const editDraftTool: Tool<typeof editArgs> = {
  id: 'edit_draft',
  category: 'content',
  label: 'Edit a draft',
  description: 'Rewrite the current draft following instructions (shorter, friendlier, add a call to action…).',
  permission: 'content:create',
  inMenu: false,
  args: editArgs,
  async run(ctx, args) {
    const draft = await loadDraft(ctx, args.draftId);
    if (!draft) return noDraft();
    const state = await readState(ctx.linkId, ctx.companyId);
    if (inFlightFor(state, ctx.messageId)) {
      return { contents: [text('I’m still rewriting it — open it in Content Studio in a moment.')] };
    }
    await writeState(ctx.linkId, ctx.companyId, {
      draftId: draft.id,
      inFlight: { messageId: ctx.messageId, tool: 'edit_draft', startedAt: new Date().toISOString() },
    });
    await ctx.sendNow(text('✍️ Rewriting it…'));
    try {
      const r = await runReviewAction({
        kind: 'content',
        id: draft.id,
        companyId: ctx.companyId,
        userId: ctx.userId,
        role: ctx.role,
        input: { action: 'regenerate', mode: 'instructions', instructions: args.instructions },
      });
      await writeState(ctx.linkId, ctx.companyId, { inFlight: undefined });
      const fresh = (await getDraft(ctx.companyId, draft.id))!;
      return { contents: [draftMessage(ctx, fresh, `✅ ${r.message}`)] };
    } catch (err) {
      await writeState(ctx.linkId, ctx.companyId, { inFlight: undefined });
      const said = serviceMessage(err);
      if (said) return { contents: [text(`I couldn’t rewrite it: ${said}`)] };
      throw err;
    }
  },
};

const draftArg = z.object({ draftId: z.string().max(40).optional() }).strict();

export const submitDraftTool: Tool<typeof draftArg> = {
  id: 'submit_draft',
  category: 'content',
  label: 'Submit for approval',
  description: 'Send the current draft for approval.',
  permission: 'content:create',
  inMenu: false,
  args: draftArg,
  async run(ctx, args) {
    const draft = await loadDraft(ctx, args.draftId);
    if (!draft) return noDraft();
    try {
      const r = await runReviewAction({
        kind: 'content',
        id: draft.id,
        companyId: ctx.companyId,
        userId: ctx.userId,
        role: ctx.role,
        input: { action: 'submit' },
      });
      return { contents: [text(`✅ ${r.message} An owner or admin will review it.\n\n${openInAura(`/dashboard/content/${draft.id}`)}`)] };
    } catch (err) {
      const said = serviceMessage(err);
      if (said) return { contents: [text(`It wasn’t submitted: ${said}`)] };
      throw err;
    }
  },
};

export const generateImageTool: Tool<typeof draftArg> = {
  id: 'generate_image',
  category: 'content',
  label: 'Create an image',
  description: 'Create a realistic marketing image for the current draft, from its visual brief.',
  permission: 'content:create',
  inMenu: false,
  args: draftArg,
  async run(ctx, args) {
    const draft = await loadDraft(ctx, args.draftId);
    if (!draft) return noDraft();
    if (draft.status === 'PUBLISHED') return { contents: [text('That post is already published.')] };
    if (!isAnyProviderConfigured()) return { contents: [text('Image generation isn’t configured on this server yet.')] };
    if (!rateLimit(`graphic-generate:${ctx.userId}`, { limit: 6, windowMs: 60_000 }).allowed) {
      return { contents: [text('That’s a lot of images in a minute — try again shortly.')] };
    }
    try {
      await requireEntitlement(ctx.companyId, 'imageGeneration');
    } catch (err) {
      return { contents: [text(serviceMessage(err) ?? 'Your plan doesn’t include image generation.')] };
    }
    const plan = await getEffectivePlan(ctx.companyId);
    if ((await assetsThisMonth(ctx.companyId)) >= plan.limits.maxImagesPerMonth) {
      return { contents: [text(`Your ${plan.limits.label} plan’s ${plan.limits.maxImagesPerMonth} images this month are used up. Existing images stay available.`)] };
    }

    await ctx.sendNow(text('🎨 Creating a realistic image for this post… usually 10–30 seconds.'));
    const platform = resolvePlatform(draft.type as ContentTypeKey, draft.platform);
    // The prompt from the draft's visual brief (the same as Graphic Studio).
    const prompt = await generateImagePrompt({ draft, platform, style: 'photo', userId: ctx.userId });
    const { job, reused } = await enqueueJob({
      companyId: ctx.companyId,
      userId: ctx.userId,
      kind: 'IMAGE_GENERATION',
      inputs: { draftId: draft.id, prompt: prompt.prompt, negativePrompt: prompt.negativePrompt, style: 'photo', variations: 1 },
      dedupeOn: { draftId: draft.id },
    });
    const claimed = await claimJob(job.id);
    if (!claimed) {
      return {
        contents: [text(`${reused ? 'An image is already being made for this post' : 'That image is being made'} — it will appear in Content Studio.\n\n${openInAura(`/dashboard/content/${draft.id}`)}`)],
      };
    }
    let assetId: string | undefined;
    try {
      const result = (await runJob(claimed)) as { assets?: { id: string }[] };
      await completeJob(claimed.id, result as Record<string, never>);
      assetId = result.assets?.[0]?.id;
    } catch (err) {
      await failJob(claimed.id, err);
      return { contents: [text(`I couldn’t create the image: ${serviceMessage(err) ?? 'the image service didn’t respond. Try again in a minute.'}`)] };
    }
    if (!assetId) return { contents: [text('The image service returned nothing. Try again in a minute.')] };
    await writeState(ctx.linkId, ctx.companyId, { draftId: draft.id, assetId });
    return {
      contents: [
        { kind: 'image', assetId, caption: clip(prompt.subject || 'Your image', 200) },
        {
          kind: 'buttons',
          body: draft.status === 'APPROVED' ? 'Use it on the post? This sends the post back for approval.' : 'Use it on the post?',
          buttons: [
            { id: `act:useimage:${draft.id}`, title: 'Use this image' },
            { id: `act:image:${draft.id}`, title: 'Another one' },
          ],
        },
      ],
    };
  },
};

const useImageArgs = z.object({ draftId: z.string().max(40).optional() }).strict();

export const useImageTool: Tool<typeof useImageArgs> = {
  id: 'use_image',
  category: 'content',
  label: 'Use this image',
  description: 'Attach the image just created to the current draft.',
  permission: 'content:create',
  inMenu: false,
  args: useImageArgs,
  async run(ctx, args) {
    const draft = await loadDraft(ctx, args.draftId);
    if (!draft) return noDraft();
    const { assetId } = await readState(ctx.linkId, ctx.companyId);
    if (!assetId) return { contents: [text('There’s no new image to use — say “create an image” first.')] };
    try {
      // attachAsset checks the asset belongs to this workspace and reopens an approval.
      await attachAsset({ companyId: ctx.companyId, userId: ctx.userId, draftId: draft.id, assetId, replace: true });
    } catch (err) {
      const said = serviceMessage(err);
      if (said) return { contents: [text(`It wasn’t attached: ${said}`)] };
      throw err;
    }
    await writeState(ctx.linkId, ctx.companyId, { assetId: undefined });
    const fresh = (await getDraft(ctx.companyId, draft.id))!;
    return { contents: [draftMessage(ctx, fresh, '✅ Image attached.')] };
  },
};

export const CONTENT_TOOLS = [generatePostTool, showDraftTool, editDraftTool, submitDraftTool, generateImageTool, useImageTool];
