import { z } from 'zod';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import {
  completeStructured,
  isClaudeConfigured,
  DEFAULT_MODEL,
} from '@/server/ai/claude';
import { generateBrandVoiceProfile } from '@/server/content/brand-voice.service';
import {
  businessContextToPrompt,
  getBusinessContext,
} from '@/server/business-context/business-context.service';

/**
 * Engagement comment drafting (Sprint 4, Module 4).
 *
 * CRITICAL: the post text arrives FROM the extension (captured client-side from
 * the DOM the user is already viewing). The backend never fetches LinkedIn post
 * content — there is no server-side LinkedIn read anywhere in this module. We
 * only turn the provided text into an on-brand comment draft; the human edits
 * and posts it with one click in the extension.
 */
const commentSchema = z.object({ comment: z.string().max(1200) });
const MAX_EXCERPT = 2000;

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function draftComment(args: {
  companyId: string;
  userId: string;
  postUrl: string;
  postText: string;
  author?: string | null;
  requestMeta?: Meta;
}): Promise<{ commentId: string; text: string; model: string }> {
  const { companyId, userId, postUrl, postText, author, requestMeta } = args;
  const excerpt = postText.trim().slice(0, MAX_EXCERPT);

  const { text, model } = await buildComment(companyId, userId, excerpt, author);

  const comment = await db.engagementComment.create({
    data: {
      companyId,
      createdById: userId,
      targetPostUrl: postUrl,
      targetAuthor: author || null,
      postExcerpt: excerpt,
      draftText: text,
      status: 'DRAFT',
      aiMetadata: { model, brandVoiceApplied: model !== 'none' },
    },
  });

  await recordAudit({
    action: 'ENGAGEMENT_COMMENT_DRAFTED',
    userId,
    companyId,
    metadata: { commentId: comment.id, postUrl, model },
    ...requestMeta,
  });

  return { commentId: comment.id, text, model };
}

async function buildComment(
  companyId: string,
  userId: string,
  postText: string,
  author?: string | null,
): Promise<{ text: string; model: string }> {
  if (!isClaudeConfigured()) {
    return { text: deterministicComment(postText), model: 'none' };
  }
  try {
    const company = await db.company.findUnique({ where: { id: companyId } });
    await generateBrandVoiceProfile({ company: company!, userId });
    /**
     * What we do and how we sound, so the comment can add a real perspective.
     *
     * A model told only the brand's name and tone, and asked for a "thoughtful,
     * specific, NON-generic" comment, has nothing specific to be thoughtful
     * FROM — which is how you get the agreeable filler this prompt spends four
     * lines forbidding. Knowing the company's actual field is what makes a
     * genuine point possible.
     *
     * The `engagement` preset is identity and voice only: a comment replies
     * to someone else's post, so the workspace's own audience is not the
     * reader here.
     */
    const context = await getBusinessContext(companyId, { sections: [] });
    const result = await completeStructured({
      schema: commentSchema,
      system: [
        `You are commenting on LinkedIn as ${company?.name ?? 'our brand'}.`,
        businessContextToPrompt(context, 'engagement'),
        'Write a thoughtful, specific, NON-generic comment (1-3 sentences) that ' +
          'adds a genuine perspective to the post. No flattery cliches, no "Great ' +
          'post!", no hashtags, no self-promotion. Respond with ONLY JSON: ' +
          '{"comment": string}.',
      ].join('\n'),
      prompt: `${author ? `Post by ${author}:` : 'Post:'}\n"""\n${postText}\n"""\n\nWrite our comment.`,
      maxTokens: 400,
      effort: 'medium',
      tier: 'standard',
    });
    const text = result.comment.trim();
    return { text: text || deterministicComment(postText), model: DEFAULT_MODEL };
  } catch (err) {
    logger.warn('engagement: draft failed, using fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { text: deterministicComment(postText), model: 'none' };
  }
}

function deterministicComment(postText: string): string {
  const first = postText.split(/[.!?\n]/)[0]?.trim().slice(0, 80) ?? 'this';
  return `Really resonates — especially the point about "${first}". Curious how you're seeing this play out in practice.`;
}

export async function listComments(companyId: string) {
  return db.engagementComment.findMany({
    where: { companyId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}
