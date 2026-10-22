import type { ContentDraft } from '@prisma/client';

import { db } from '@/lib/db';
import { visualFor } from '@/lib/content-brief';
import { CONTENT_TYPE_LABELS } from '@/lib/content-ui';
import { platformSpec, type SocialPlatformKey } from '@/lib/platforms';
import {
  buildVisualBrief,
  visualBriefSchema,
  type VisualBrief,
} from '@/lib/visual-brief';
import {
  brandVoiceProfileSchema,
  type ContentTypeKey,
} from '@/lib/validations/content';
import { getBusinessContext } from '@/server/business-context/business-context.service';
import {
  readBrandAssets,
  readMarketingProfile,
} from '@/server/company/profile.service';
import { renderForManual } from '@/server/content/render';

/**
 * The visual brief for a draft (lib/visual-brief.ts), for the image workflow.
 *
 *   Written from a recommendation → the brief it kept (aiMetadata.brief.visual):
 *   the recommendation's key message, product, audience, brand and shape.
 *   Otherwise → built now from the business context, the brand and the post
 *   itself (its opening line is the subject), so every image is briefed the
 *   same way.
 *
 * When the image is for a different network than the brief named, the shape
 * and size follow the network chosen; everything else stays.
 */
export async function visualBriefForDraft(
  draft: ContentDraft,
  platform: SocialPlatformKey | null,
): Promise<{
  brief: VisualBrief;
  source: 'content_brief' | 'business_context';
}> {
  const type = draft.type as ContentTypeKey;
  const meta = (draft.aiMetadata ?? {}) as { brief?: { visual?: unknown } };
  const stored = visualBriefSchema.safeParse(meta.brief?.visual);
  if (stored.success) {
    return {
      brief: forPlatform(stored.data, type, platform),
      source: 'content_brief',
    };
  }

  const [company, ctx] = await Promise.all([
    db.company.findUnique({
      where: { id: draft.companyId },
      select: { preferences: true, brandVoiceProfile: true },
    }),
    getBusinessContext(draft.companyId, { sections: ['targeting'] }),
  ]);
  const assets = company ? readBrandAssets(company) : null;
  const marketing = company ? readMarketingProfile(company) : null;
  const voice = brandVoiceProfileSchema.safeParse(company?.brandVoiceProfile);
  const req = visualFor(type, platform);
  const hook = firstLine(renderForManual(draft, { details: false }));

  return {
    brief: buildVisualBrief({
      need: req.need,
      count: req.count,
      formatLabel: CONTENT_TYPE_LABELS[type],
      aspectRatio: req.aspectRatio,
      platform,
      channel: platform ? platformSpec(platform).label : null,
      keyMessage: hook ? { value: hook, source: 'post' } : null,
      offerings: ctx?.identity.offerings ?? null,
      description: ctx?.identity.description ?? null,
      audience: ctx?.audience.stated ?? null,
      marketMode: marketing?.marketMode ?? ctx?.audience.marketMode ?? null,
      brand: {
        colors: [
          assets?.primaryColor,
          assets?.secondaryColor,
          assets?.accentColor,
        ].filter((c): c is string => Boolean(c)),
        hasLogo: Boolean(assets?.logoAssetId),
      },
      voice: voice.success
        ? { tone: voice.data.toneDescriptors, avoid: voice.data.topicsToAvoid }
        : null,
    }),
    source: 'business_context',
  };
}

/** The same brief, with the shape and size of another network. */
function forPlatform(
  v: VisualBrief,
  type: ContentTypeKey,
  platform: SocialPlatformKey | null,
): VisualBrief {
  if (!platform || v.format.platform === platform || v.format.platform === null)
    return v;
  const req = visualFor(type, platform);
  return buildVisualBrief({
    need: v.need,
    count: v.count,
    formatLabel: CONTENT_TYPE_LABELS[type],
    aspectRatio: req.aspectRatio,
    platform,
    channel: platformSpec(platform).label,
    keyMessage: v.subject,
    offerings:
      v.product?.source === 'business_profile' ? v.product.value : null,
    description: null,
    audience: v.audience,
    marketMode: v.setting.startsWith('Consumer')
      ? 'B2C'
      : v.setting.startsWith('Business')
        ? 'B2B'
        : null,
    brand: { colors: v.brand.palette, hasLogo: v.brand.logoOnFile },
    voice: { tone: v.brand.mood, avoid: v.brand.avoid },
  });
}

/** The post's first real line — its hook, in practice. */
function firstLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^(Subject|Tagline|Headline|Primary text):\s*/i, '')
      .trim();
    if (line.length < 12 || line.startsWith('#')) continue;
    return line.replace(/\s+/g, ' ').slice(0, 180);
  }
  return '';
}
