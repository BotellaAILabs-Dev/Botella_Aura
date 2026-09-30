import type {
  CreateCompanyInput,
  UpdateCompanyInput,
} from '@/lib/validations/company';
import type {
  BrandAssets,
  ContentFormats,
  MarketingProfile,
} from '@/lib/validations/profile';

/**
 * How each existing screen's input becomes a Business Context patch.
 *
 * The screens keep their own request shapes and schemas, so their forms and
 * error messages are unchanged. Each adapter translates the parsed input into
 * the one patch shape the service accepts, and each alias map sends the
 * service's per-field errors back under the form's own field names.
 *
 * Patch semantics: an omitted key is unchanged; null clears.
 */

type Raw = Record<string, unknown>;

/** True when the request body actually carried this key. */
function sent(raw: unknown, key: string): boolean {
  return Boolean(raw && typeof raw === 'object' && key in (raw as Raw));
}

// --- Onboarding wizard (POST /api/companies) --------------------------------

export function onboardingPatch(input: CreateCompanyInput) {
  return {
    identity: {
      name: input.name,
      website: input.website ?? null,
      industry: input.industry || null,
      description: input.description,
      offerings: input.offerings || null,
    },
    audience: { marketMode: input.marketMode, stated: input.audience },
    objectives: { goals: input.goals || null },
    voice: { notes: input.brandVoiceNotes || null },
  };
}

export const ONBOARDING_ALIASES: Record<string, string> = {
  'identity.name': 'name',
  'identity.website': 'website',
  'identity.industry': 'industry',
  'identity.description': 'description',
  'identity.offerings': 'offerings',
  'audience.marketMode': 'marketMode',
  'audience.stated': 'audience',
  'objectives.goals': 'goals',
  'voice.notes': 'brandVoiceNotes',
};

// --- Company profile (PATCH /api/companies/:id) -----------------------------

/**
 * `updateCompanySchema` turns an emptied website into undefined, so clearing
 * the website there has always meant "unchanged". Kept as-is: this adapter
 * connects the screen, it does not change what the screen does.
 */
export function companyProfilePatch(input: UpdateCompanyInput) {
  const identity: Raw = {};
  if (input.name !== undefined) identity.name = input.name;
  if (input.website !== undefined) identity.website = input.website;
  if (input.industry !== undefined) identity.industry = input.industry || null;
  if (input.description !== undefined)
    identity.description = input.description || null;
  if (input.offerings !== undefined)
    identity.offerings = input.offerings || null;
  return {
    identity,
    ...(input.brandVoiceNotes !== undefined
      ? { voice: { notes: input.brandVoiceNotes || null } }
      : {}),
  };
}

export const COMPANY_PROFILE_ALIASES: Record<string, string> = {
  'identity.name': 'name',
  'identity.website': 'website',
  'identity.industry': 'industry',
  'identity.description': 'description',
  'identity.offerings': 'offerings',
  'voice.notes': 'brandVoiceNotes',
};

// --- Audience & goals (PATCH /api/company/audience) -------------------------

/**
 * The form always sends every field, and an emptied textarea arrives as ''
 * which the schema turns into undefined — so "was the key sent" is what
 * separates "clear it" from "leave it".
 */
export function audiencePatch(input: MarketingProfile, raw: unknown) {
  return {
    audience: {
      ...(input.marketMode ? { marketMode: input.marketMode } : {}),
      ...(sent(raw, 'audience') ? { stated: input.audience ?? null } : {}),
    },
    objectives: sent(raw, 'goals') ? { goals: input.goals ?? null } : {},
    channels: sent(raw, 'channels') ? { preferred: input.channels ?? [] } : {},
  };
}

export const AUDIENCE_ALIASES: Record<string, string> = {
  'audience.marketMode': 'marketMode',
  'audience.stated': 'audience',
  'objectives.goals': 'goals',
  'channels.preferred': 'channels',
};

// --- Brand assets (PATCH /api/company/brand, logo upload) -------------------

export function brandPatch(input: BrandAssets, raw: unknown) {
  const visual: Raw = {};
  for (const key of [
    'logoAssetId',
    'primaryColor',
    'secondaryColor',
    'accentColor',
  ] as const) {
    if (sent(raw, key)) visual[key] = input[key] ?? null;
  }
  return { identity: { visual } };
}

export const BRAND_ALIASES: Record<string, string> = {
  'identity.visual.logoAssetId': 'logoAssetId',
  'identity.visual.primaryColor': 'primaryColor',
  'identity.visual.secondaryColor': 'secondaryColor',
  'identity.visual.accentColor': 'accentColor',
};

// --- Content formats (PATCH /api/company/formats) ---------------------------

export function formatsPatch(input: ContentFormats) {
  return { objectives: { contentFormats: input.enabled } };
}

export const FORMATS_ALIASES: Record<string, string> = {
  'objectives.contentFormats': 'enabled',
};
