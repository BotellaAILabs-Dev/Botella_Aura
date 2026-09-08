import type { Company, Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import {
  brandAssetsSchema,
  contentFormatsSchema,
  marketingProfileSchema,
  resolveEnabledFormats,
  type BrandAssets,
  type ContentFormats,
  type MarketingProfile,
} from '@/lib/validations/profile';
import type { ContentTypeKey } from '@/lib/validations/content';

/**
 * Reading and writing the workspace profile stored in `Company.preferences`.
 *
 * Every read goes through safeParse and returns null rather than throwing. A
 * preferences bag written by an older build — or hand-edited in the database —
 * must never be able to break content generation or crash a page, which is the
 * same rule readAutopilotSettings and brandVoiceProfile already follow.
 *
 * Writes merge rather than replace, because `preferences` is shared with
 * autopilot: a PATCH of brand colours must not silently delete someone's
 * autopilot settings.
 */
type PreferencesBag = Record<string, unknown>;

function bagOf(company: Pick<Company, 'preferences'>): PreferencesBag {
  const prefs = company.preferences;
  return prefs && typeof prefs === 'object' && !Array.isArray(prefs)
    ? (prefs as PreferencesBag)
    : {};
}

export function readBrandAssets(
  company: Pick<Company, 'preferences'>,
): BrandAssets | null {
  const parsed = brandAssetsSchema.safeParse(bagOf(company).brand ?? {});
  return parsed.success ? parsed.data : null;
}

export function readMarketingProfile(
  company: Pick<Company, 'preferences'>,
): MarketingProfile | null {
  const parsed = marketingProfileSchema.safeParse(bagOf(company).marketingProfile ?? {});
  return parsed.success ? parsed.data : null;
}

export function readContentFormats(
  company: Pick<Company, 'preferences'>,
): ContentFormats | null {
  const parsed = contentFormatsSchema.safeParse(bagOf(company).contentFormats ?? {});
  return parsed.success ? parsed.data : null;
}

/**
 * The formats this workspace may create, for the composer and the API.
 *
 * Resolves an unset or empty choice to every format, so narrowing is something
 * a workspace opts into and a corrupt preferences bag can never leave someone
 * unable to create anything.
 */
export async function getEnabledContentTypes(
  companyId: string,
): Promise<ContentTypeKey[]> {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { preferences: true },
  });
  if (!company) return resolveEnabledFormats(null);
  return resolveEnabledFormats(readContentFormats(company));
}

/** Both halves in one read, for pages that show the whole profile. */
export async function getWorkspaceProfile(companyId: string): Promise<{
  brand: BrandAssets | null;
  marketing: MarketingProfile | null;
}> {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { preferences: true },
  });
  if (!company) return { brand: null, marketing: null };
  return {
    brand: readBrandAssets(company),
    marketing: readMarketingProfile(company),
  };
}

/**
 * Merge one section into `preferences` without disturbing the others.
 *
 * Read-modify-write rather than a JSON path update because Prisma does not
 * expose partial JSON writes for Postgres, and the window is a single user
 * editing their own settings form — not a contended counter.
 */
async function mergeSection(
  companyId: string,
  key: 'brand' | 'marketingProfile' | 'contentFormats',
  value: Record<string, unknown>,
): Promise<void> {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { preferences: true },
  });
  if (!company) throw new Error('Company not found');

  const bag = bagOf(company);
  const existing =
    bag[key] && typeof bag[key] === 'object' && !Array.isArray(bag[key])
      ? (bag[key] as Record<string, unknown>)
      : {};

  // undefined means "clear this field", which JSON cannot represent — strip
  // those keys so an emptied colour input actually removes the colour.
  const merged: Record<string, unknown> = { ...existing, ...value };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null || v === '') delete merged[k];
  }

  // Cast at the boundary only. Everything written here came through a Zod
  // schema, so it is genuinely JSON-safe; Prisma just cannot see that through
  // the `unknown`-valued bag we have to use to preserve sections we don't know
  // about (autopilot's, and whatever a later feature adds).
  await db.company.update({
    where: { id: companyId },
    data: { preferences: { ...bag, [key]: merged } as Prisma.InputJsonObject },
  });
}

export async function saveBrandAssets(
  companyId: string,
  assets: BrandAssets,
): Promise<void> {
  await mergeSection(companyId, 'brand', assets);
}

export async function saveMarketingProfile(
  companyId: string,
  profile: MarketingProfile,
): Promise<void> {
  await mergeSection(companyId, 'marketingProfile', profile);
}

/**
 * Persist the chosen formats.
 *
 * An empty list is a meaningful value here — it is how a workspace says "offer
 * me all of them" — so this writes the section directly instead of going
 * through mergeSection, whose empty-value stripping would delete the key and
 * make "all" indistinguishable from "never set". They resolve the same today,
 * but only one of them survives a future default that is narrower than all.
 */
export async function saveContentFormats(
  companyId: string,
  formats: ContentFormats,
): Promise<void> {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { preferences: true },
  });
  if (!company) throw new Error('Company not found');

  const bag = bagOf(company);
  await db.company.update({
    where: { id: companyId },
    data: {
      preferences: {
        ...bag,
        contentFormats: { enabled: formats.enabled },
      } as Prisma.InputJsonObject,
    },
  });
}

