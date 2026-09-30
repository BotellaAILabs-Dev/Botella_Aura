import {
  REQUIRED_FIELDS,
  SOURCE_TYPE_INFO,
  storedFactMetaSchema,
  type SourceType,
} from '@/lib/business-context';
import type { BrandVoiceProfile } from '@/lib/validations/content';
import { brandVoiceProfileSchema } from '@/lib/validations/content';
import {
  BusinessContextUpdateError,
  type BusinessContextPatch,
  type ContextUpdateIssue,
  type UpdateOrigin,
} from '@/lib/validations/business-context';

/**
 * The update rules for the trusted Business Context, as a pure function.
 *
 * Given what is stored and a patch that already passed the shape schema, work
 * out exactly which fields change, apply the rules to those changes, and
 * return the database write. The service wraps this in a transaction; the
 * onboarding flow uses it directly to build the new company's row. Either way
 * the same rules decide what may enter the context.
 *
 * THE RULES
 *   R1  Only writable fields — enforced by the patch schema.
 *   R2  Shape: types, enums, formats, caps — enforced by the patch schema.
 *   R3  Quality applies to CHANGED values only. A value already stored is not
 *       re-judged, so a workspace with an older, shorter description can still
 *       save an unrelated edit from a form that re-sends every field.
 *   R4  A required field cannot be cleared, and onboarding must supply all of
 *       them.
 *   R5  References must belong to the workspace (checked by the service,
 *       which has the database — this returns what to check).
 *   R6  An AI-originated write may only set AI-maintained fields. A model may
 *       rewrite the voice profile; it may never rewrite what the business
 *       said about itself.
 *   R7  A write that changes nothing is not a write: no update, no audit.
 *   R8  Merge, never replace — other `preferences` sections (autopilot and
 *       anything added later) survive every write.
 *   R9  Optimistic concurrency via `expectedRevision` (checked by the service).
 */

/** The stored columns the context's writable fields live in. */
export interface StoredBusinessContext {
  name: string;
  website: string | null;
  industry: string | null;
  brandVoiceNotes: string | null;
  brandVoiceProfile: unknown;
  preferences: unknown;
}

export const EMPTY_STORED_CONTEXT: StoredBusinessContext = {
  name: '',
  website: null,
  industry: null,
  brandVoiceNotes: null,
  brandVoiceProfile: null,
  preferences: {},
};

export interface BusinessContextWrite {
  name?: string;
  website?: string | null;
  industry?: string | null;
  brandVoiceNotes?: string | null;
  /** `null` clears the profile; the service maps it to a database null. */
  brandVoiceProfile?: BrandVoiceProfile | null;
  preferences?: Record<string, unknown>;
}

export interface WritePlan {
  data: BusinessContextWrite;
  /** Field paths that actually change, e.g. `identity.visual.primaryColor`. */
  changed: string[];
  /** References the service must confirm belong to the workspace (R5). */
  references: { logoAssetId?: string };
  /** Fields a person reviewed and confirmed without changing them. */
  confirmed: string[];
}

/** The source type each kind of write records against the fields it sets. */
export const ORIGIN_SOURCE_TYPE: Record<UpdateOrigin, SourceType> = {
  onboarding: 'onboarding',
  settings: 'user_provided',
  api: 'user_provided',
  ai: 'ai_derived',
};

/**
 * Fields that can be confirmed: every stored writable field. Confirming marks
 * a value as reviewed by a person — it turns an AI-drafted voice profile into
 * the business's own and resets the freshness clock on anything else.
 */
export const CONFIRMABLE_FIELDS = [
  'identity.name',
  'identity.website',
  'identity.industry',
  'identity.description',
  'identity.offerings',
  'audience.marketMode',
  'audience.stated',
  'objectives.goals',
  'objectives.contentFormats',
  'channels.preferred',
  'voice.notes',
  'voice.profile',
] as const;

/** Fields an AI-originated write may set (R6). */
export const AI_WRITABLE_FIELDS = ['voice.profile'];

/** Minimum length for a changed value, where a short one is useless (R3). */
const MIN_LENGTH: Record<string, { min: number; message: string }> = {
  'identity.name': {
    min: 2,
    message: 'Company name must be at least 2 characters.',
  },
  'identity.description': {
    min: 20,
    message:
      'Tell Aura what the business does in a sentence or two (at least 20 characters).',
  },
  'audience.stated': {
    min: 10,
    message:
      'Describe who you sell to in a little more detail (at least 10 characters).',
  },
};

/** Fields where a placeholder answer would be trusted as fact (R3). */
const PROSE_FIELDS = new Set([
  'identity.name',
  'identity.description',
  'identity.offerings',
  'identity.industry',
  'audience.stated',
  'objectives.goals',
  'voice.notes',
]);

const PLACEHOLDER =
  /^(n\/?a|na|none|nil|null|undefined|tbd|tba|todo|test(ing)?|asdf+|qwerty|lorem ipsum.*|x+|-+|\.+|\?+|placeholder|same|idk|nothing)$/i;

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim());
}

type Bag = Record<string, unknown>;

function asBag(value: unknown): Bag {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Bag) }
    : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function sameList(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) =>
    Array.isArray(v) ? [...new Set(v.map(String))].sort().join('|') : '';
  return norm(a) === norm(b);
}

/**
 * Plan a write, or throw BusinessContextUpdateError listing every refused
 * field at once — a form should be able to show all its problems in one pass.
 */
export function planBusinessContextWrite(
  current: StoredBusinessContext,
  patch: BusinessContextPatch,
  origin: UpdateOrigin,
  aliases: Record<string, string> = {},
  options: { confirm?: readonly string[]; now?: Date } = {},
): WritePlan {
  const issues: ContextUpdateIssue[] = [];
  const changed: string[] = [];
  const data: BusinessContextWrite = {};
  const references: WritePlan['references'] = {};

  const bag = asBag(current.preferences);
  const business = asBag(bag.business);
  const marketing = asBag(bag.marketingProfile);
  const brand = asBag(bag.brand);
  const touched = new Set<
    'business' | 'marketingProfile' | 'brand' | 'contentFormats'
  >();

  /**
   * Record a text change after the quality rules. Returns true when the value
   * really changes, so the caller writes it.
   */
  const textChange = (
    path: string,
    before: string | null,
    after: string | null | undefined,
  ) => {
    if (after === undefined) return false;
    if ((before ?? null) === (after ?? null)) return false;
    if (after !== null) {
      const rule = MIN_LENGTH[path];
      if (rule && after.length < rule.min) {
        issues.push({ field: path, message: rule.message });
        return false;
      }
      if (PROSE_FIELDS.has(path) && isPlaceholder(after)) {
        issues.push({
          field: path,
          message: `“${after}” looks like a placeholder. Enter the real answer, or leave it blank.`,
        });
        return false;
      }
    }
    changed.push(path);
    return true;
  };

  // --- identity -----------------------------------------------------------
  const id = patch.identity ?? {};
  if (textChange('identity.name', current.name || null, id.name))
    data.name = id.name ?? '';
  if (textChange('identity.website', current.website, id.website))
    data.website = id.website ?? null;
  if (textChange('identity.industry', current.industry, id.industry))
    data.industry = id.industry ?? null;
  for (const key of ['description', 'offerings'] as const) {
    if (textChange(`identity.${key}`, str(business[key]), id[key])) {
      business[key] = id[key];
      touched.add('business');
    }
  }
  for (const [key, value] of Object.entries(id.visual ?? {})) {
    if (value === undefined || (str(brand[key]) ?? null) === value) continue;
    brand[key] = value;
    touched.add('brand');
    changed.push(`identity.visual.${key}`);
    if (key === 'logoAssetId' && value) references.logoAssetId = value;
  }

  // --- audience & objectives ---------------------------------------------
  const au = patch.audience ?? {};
  if (
    au.marketMode !== undefined &&
    (str(marketing.marketMode) ?? null) !== au.marketMode
  ) {
    marketing.marketMode = au.marketMode;
    touched.add('marketingProfile');
    changed.push('audience.marketMode');
  }
  if (textChange('audience.stated', str(marketing.audience), au.stated)) {
    marketing.audience = au.stated;
    touched.add('marketingProfile');
  }
  const ob = patch.objectives ?? {};
  if (textChange('objectives.goals', str(marketing.goals), ob.goals)) {
    marketing.goals = ob.goals;
    touched.add('marketingProfile');
  }
  if (
    ob.contentFormats !== undefined &&
    !sameList(asBag(bag.contentFormats).enabled ?? [], ob.contentFormats)
  ) {
    touched.add('contentFormats');
    changed.push('objectives.contentFormats');
  }
  const ch = patch.channels ?? {};
  if (
    ch.preferred !== undefined &&
    !sameList(marketing.channels ?? [], ch.preferred)
  ) {
    marketing.channels = ch.preferred;
    touched.add('marketingProfile');
    changed.push('channels.preferred');
  }

  // --- voice --------------------------------------------------------------
  const vo = patch.voice ?? {};
  if (textChange('voice.notes', current.brandVoiceNotes, vo.notes))
    data.brandVoiceNotes = vo.notes ?? null;
  if (vo.profile !== undefined) {
    const parsed = current.brandVoiceProfile
      ? brandVoiceProfileSchema.safeParse(current.brandVoiceProfile)
      : null;
    const before = parsed?.success ? JSON.stringify(parsed.data) : null;
    const after = vo.profile ? JSON.stringify(vo.profile) : null;
    if (before !== after) {
      data.brandVoiceProfile = vo.profile;
      changed.push('voice.profile');
    }
  }

  // --- R4: required fields -------------------------------------------------
  const requiredAfter: Record<string, string | null> = {
    'identity.name':
      data.name !== undefined ? data.name || null : current.name || null,
    'identity.description': str(business.description),
    'audience.marketMode': str(marketing.marketMode),
    'audience.stated': str(marketing.audience),
  };
  const refusedAlready = new Set(issues.map((i) => i.field));
  for (const path of REQUIRED_FIELDS) {
    if (requiredAfter[path] || refusedAlready.has(path)) continue;
    if (origin === 'onboarding') {
      issues.push({
        field: path,
        message: `${REQUIRED_LABELS[path]} is required to finish setting up.`,
      });
    } else if (changed.includes(path)) {
      issues.push({
        field: path,
        message: `${REQUIRED_LABELS[path]} is required and cannot be removed. Change it instead.`,
      });
    }
  }

  // --- R6: what an AI may write -------------------------------------------
  if (origin === 'ai') {
    for (const path of changed) {
      if (!AI_WRITABLE_FIELDS.includes(path)) {
        issues.push({
          field: path,
          message:
            'Only a person can change this. AI may only update the voice profile.',
        });
      }
    }
  }

  // --- Confirmation: a person vouching for a value as it stands -------------
  const valueAfter = (path: string): unknown => {
    if (path.startsWith('identity.visual.')) return brand[path.slice(16)];
    switch (path) {
      case 'identity.name':
        return data.name !== undefined ? data.name : current.name;
      case 'identity.website':
        return data.website !== undefined ? data.website : current.website;
      case 'identity.industry':
        return data.industry !== undefined ? data.industry : current.industry;
      case 'identity.description':
        return business.description;
      case 'identity.offerings':
        return business.offerings;
      case 'audience.marketMode':
        return marketing.marketMode;
      case 'audience.stated':
        return marketing.audience;
      case 'objectives.goals':
        return marketing.goals;
      case 'objectives.contentFormats':
        // An empty list is a real choice ("all formats"), so never blank.
        return 'set';
      case 'channels.preferred':
        return marketing.channels;
      case 'voice.notes':
        return data.brandVoiceNotes !== undefined
          ? data.brandVoiceNotes
          : current.brandVoiceNotes;
      case 'voice.profile':
        return data.brandVoiceProfile !== undefined
          ? data.brandVoiceProfile
          : current.brandVoiceProfile;
      default:
        return undefined;
    }
  };
  const isBlank = (v: unknown) =>
    v === null ||
    v === undefined ||
    v === '' ||
    (Array.isArray(v) && v.length === 0);

  const confirmed: string[] = [];
  for (const path of new Set(options.confirm ?? [])) {
    if (!(CONFIRMABLE_FIELDS as readonly string[]).includes(path)) {
      issues.push({
        field: path,
        message: 'This field cannot be confirmed here.',
      });
    } else if (origin === 'ai') {
      issues.push({
        field: path,
        message: 'Only a person can confirm a business fact.',
      });
    } else if (isBlank(valueAfter(path))) {
      issues.push({
        field: path,
        message: 'There is no value to confirm yet.',
      });
    } else if (!changed.includes(path)) {
      confirmed.push(path);
    }
  }

  if (issues.length) throw new BusinessContextUpdateError(issues, aliases);

  // --- Capture metadata: who set each fact, and when -------------------------
  const now = (options.now ?? new Date()).toISOString();
  const factMeta = asBag(bag.factMeta);
  for (const path of changed) {
    if (isBlank(valueAfter(path))) delete factMeta[path];
    else
      factMeta[path] = {
        sourceType: ORIGIN_SOURCE_TYPE[origin],
        capturedAt: now,
      };
  }
  for (const path of confirmed) {
    const prior = storedFactMetaSchema.safeParse(factMeta[path]);
    const keepType =
      prior.success && SOURCE_TYPE_INFO[prior.data.sourceType].trusted
        ? prior.data.sourceType
        : 'user_provided';
    factMeta[path] = {
      sourceType: keepType,
      capturedAt: prior.success ? prior.data.capturedAt : now,
      confirmedAt: now,
    };
  }
  const metaChanged = changed.length > 0 || confirmed.length > 0;

  // --- R8: merge, stripping cleared keys the way the old writers did --------
  if (touched.size || metaChanged) {
    const strip = (section: Bag) => {
      for (const [k, v] of Object.entries(section)) {
        if (v === null || v === undefined || v === '') delete section[k];
      }
      return section;
    };
    const next: Bag = { ...bag };
    if (touched.has('business')) next.business = strip(business);
    if (touched.has('marketingProfile'))
      next.marketingProfile = strip(marketing);
    if (touched.has('brand')) next.brand = strip(brand);
    // An empty list is meaningful here ("offer all formats"), so no stripping.
    if (touched.has('contentFormats'))
      next.contentFormats = { enabled: ob.contentFormats };
    if (metaChanged) next.factMeta = factMeta;
    data.preferences = next;
  }

  return { data, changed, references, confirmed };
}

const REQUIRED_LABELS: Record<string, string> = {
  'identity.name': 'Company name',
  'identity.description': 'What the business does',
  'audience.marketMode': 'Whether you sell to businesses or consumers',
  'audience.stated': 'Who you sell to',
};
