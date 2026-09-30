import { z } from 'zod';

import { CONTENT_CHANNELS } from '@/lib/validations/planner';
import {
  brandVoiceProfileSchema,
  CONTENT_TYPES,
} from '@/lib/validations/content';
import { websiteSchema } from '@/lib/validations/company';
import {
  AUDIENCE_MAX,
  GOALS_MAX,
  hexColor,
  MARKET_MODES,
} from '@/lib/validations/profile';

/**
 * Writing to the trusted Business Context.
 *
 * Every screen that edits business information — onboarding, company profile,
 * audience, brand, formats, brand voice — sends its change through this one
 * patch shape, so a value can only enter the context by passing the same
 * checks wherever it was typed.
 *
 * Validation happens in two layers:
 *
 *   1. SHAPE (this schema): types, enums, length caps, URL and colour formats,
 *      stripping control characters. Anything unsupported is rejected here,
 *      including fields that exist in the context but are owned elsewhere.
 *   2. RULES (server/business-context/update.ts): checks that need the current
 *      value — minimum quality of a CHANGED value, required fields that cannot
 *      be cleared, references that must belong to the workspace, and what an
 *      AI-originated write may touch.
 *
 * Patch semantics: a missing key leaves the field unchanged; `null` or an empty
 * string clears it.
 */

/** Control characters other than tab and newline. Pasted text carries these. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function clean(value: string): string {
  return value
    .replace(CONTROL_CHARS, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Text that may be cleared: '' and null both mean "clear". */
const text = (max: number, label: string) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? clean(v) || null : v),
    z
      .string()
      .max(max, `${label} must be ${max} characters or fewer.`)
      .nullable(),
  );

const nullableHex = z.preprocess(
  (v) => (v === '' ? null : v),
  z.union([z.null(), hexColor]),
);

/** A de-duplicated list of allowed values. */
const enumList = <T extends readonly [string, ...string[]]>(
  values: T,
  max: number,
) =>
  z
    .array(z.enum(values))
    .max(max)
    .transform((list) => [...new Set(list)]);

const identityPatch = z
  .object({
    name: text(80, 'Company name'),
    website: z.preprocess(
      (v) => (v === '' ? null : v),
      z.union([z.null(), websiteSchema.pipe(z.string())]),
    ),
    industry: text(80, 'Industry'),
    description: text(600, 'The description'),
    offerings: text(400, 'What you sell'),
    visual: z
      .object({
        logoAssetId: z.preprocess(
          (v) => (v === '' ? null : v),
          z
            .string()
            .trim()
            .max(64)
            .regex(/^[A-Za-z0-9_-]+$/, 'Not a valid asset id.')
            .nullable(),
        ),
        primaryColor: nullableHex,
        secondaryColor: nullableHex,
        accentColor: nullableHex,
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();

const audiencePatch = z
  .object({
    marketMode: z.enum(MARKET_MODES).nullable(),
    stated: text(AUDIENCE_MAX, 'The audience description'),
  })
  .partial()
  .strict(
    'Buyer role titles, industries and company stages come from Outreach targeting and Lead discovery — edit them there.',
  );

const objectivesPatch = z
  .object({
    goals: text(GOALS_MAX, 'Goals'),
    contentFormats: enumList(CONTENT_TYPES, CONTENT_TYPES.length),
  })
  .partial()
  .strict();

const channelsPatch = z
  .object({ preferred: enumList(CONTENT_CHANNELS, CONTENT_CHANNELS.length) })
  .partial()
  .strict(
    'Connected channels come from Settings → Connections — connect or disconnect them there.',
  );

const voicePatch = z
  .object({
    notes: text(2000, 'Brand voice notes'),
    profile: brandVoiceProfileSchema.nullable(),
  })
  .partial()
  .strict('Only brand voice notes and the voice profile can be edited.');

export const businessContextPatchSchema = z
  .object({
    identity: identityPatch,
    audience: audiencePatch,
    objectives: objectivesPatch,
    channels: channelsPatch,
    voice: voicePatch,
  })
  .partial()
  .strict(
    'Only identity, audience, objectives, channels and voice can be updated here. Competitors, trend keywords, knowledge, memory and connections are managed by their own modules.',
  );

export type BusinessContextPatch = z.infer<typeof businessContextPatchSchema>;

/** Who is making a change. Decides which rules apply. */
export const UPDATE_ORIGINS = ['onboarding', 'settings', 'api', 'ai'] as const;
export type UpdateOrigin = (typeof UPDATE_ORIGINS)[number];

/** Body of PATCH /api/business-context. */
export const businessContextUpdateSchema = z
  .object({
    patch: businessContextPatchSchema,
    /**
     * The `meta.revision` the caller last read. When given and the workspace
     * has changed since, the update is refused rather than silently
     * overwriting someone else's edit.
     */
    expectedRevision: z.string().max(40).optional(),
    /**
     * Field paths the caller has reviewed and confirms as correct, e.g.
     * ['voice.profile'] to accept an AI-drafted voice as the business's own.
     */
    confirm: z.array(z.string().max(60)).max(20).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ContextUpdateIssue {
  /** Context field path, e.g. `audience.stated`. */
  field: string;
  message: string;
}

/**
 * A change was refused by an update rule.
 *
 * Carries `status` and `details` so handleRouteError returns it as a 422 with
 * per-field messages. `aliases` renames context paths to the field names a
 * particular form uses (`audience.stated` → `audience`), so the form can put
 * each message next to its own input.
 */
export class BusinessContextUpdateError extends Error {
  readonly status = 422;
  readonly issues: ContextUpdateIssue[];
  readonly details: Record<string, string[]>;

  constructor(
    issues: ContextUpdateIssue[],
    aliases: Record<string, string> = {},
  ) {
    super(issues.map((i) => i.message).join(' '));
    this.name = 'BusinessContextUpdateError';
    this.issues = issues;
    this.details = {};
    for (const issue of issues) {
      const key = aliases[issue.field] ?? issue.field;
      (this.details[key] ??= []).push(issue.message);
    }
  }
}

/** The workspace changed after the caller read it. */
export class BusinessContextConflictError extends Error {
  readonly status = 409;
  constructor() {
    super(
      'This business information was changed by someone else since you opened it. Reload to see the latest, then make your change again.',
    );
    this.name = 'BusinessContextConflictError';
  }
}
