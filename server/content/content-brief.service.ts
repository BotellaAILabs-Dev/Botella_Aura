import { db } from '@/lib/db';
import {
  buildContentBrief,
  type BriefOpportunity,
  type BuildBriefInput,
  type ContentBrief,
} from '@/lib/content-brief';
import {
  OPPORTUNITY_TYPE_INFO,
  type OpportunityType,
} from '@/lib/opportunities';
import type { SocialPlatformKey } from '@/lib/platforms';
import type { ContentTypeKey } from '@/lib/validations/content';
import {
  getEnabledContentTypes,
  readBrandAssets,
  readMarketingProfile,
} from '@/server/company/profile.service';
import { getContextHandoff } from '@/server/recommendations/context-handoff.service';

/**
 * The Content Brief for a recommendation (lib/content-brief.ts): its Context
 * Handoff — recommendation, business context, goal, audience, evidence, CTA,
 * brand voice, learned patterns — plus the opportunity behind it and the
 * workspace's enabled formats.
 *
 * Scoped to the workspace: another workspace's recommendation is null.
 */
export async function getBriefInput(
  companyId: string,
  recommendationId: string,
): Promise<Omit<BuildBriefInput, 'choice'> | null> {
  const handoff = await getContextHandoff(companyId, recommendationId);
  if (!handoff) return null;
  const [o, enabledTypes, company] = await Promise.all([
    db.opportunity.findFirst({
      where: { id: handoff.opportunityId, companyId },
      select: { id: true, title: true, type: true, summary: true, angle: true },
    }),
    getEnabledContentTypes(companyId),
    db.company.findUnique({
      where: { id: companyId },
      select: { preferences: true },
    }),
  ]);
  // For the visual brief: the brand's colours and logo, and whether it sells
  // to consumers or businesses.
  const assets = company ? readBrandAssets(company) : null;
  const marketing = company ? readMarketingProfile(company) : null;
  const opportunity: BriefOpportunity | null = o
    ? {
        id: o.id,
        title: o.title,
        type: o.type,
        typeLabel: OPPORTUNITY_TYPE_INFO[o.type as OpportunityType].label,
        summary: o.summary,
        angle: o.angle,
      }
    : null;
  return {
    handoff,
    opportunity,
    enabledTypes,
    brand: {
      colors: [assets?.primaryColor, assets?.secondaryColor, assets?.accentColor].filter(
        (c): c is string => Boolean(c),
      ),
      hasLogo: Boolean(assets?.logoAssetId),
    },
    marketMode: marketing?.marketMode ?? null,
  };
}

export async function getContentBrief(
  companyId: string,
  recommendationId: string,
  choice?: { type?: ContentTypeKey; platform?: SocialPlatformKey } | null,
): Promise<ContentBrief | null> {
  const input = await getBriefInput(companyId, recommendationId);
  return input ? buildContentBrief({ ...input, choice: choice ?? null }) : null;
}
