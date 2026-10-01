import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Business Context service: one validated way in, one way out.
 *
 * Covers the patch schema (what may be sent), the update rules (what may be
 * stored), the adapters that connect the existing screens, the transactional
 * write, and the workflow retrieval interface — ending with the round trip the
 * acceptance criteria ask for: onboarding data written through the rules and
 * read back through the service.
 */

const { tx, db } = vi.hoisted(() => {
  const tx = {
    company: { findUnique: vi.fn(), updateMany: vi.fn() },
    generatedAsset: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };

  const db = {
    $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
    company: { findUnique: vi.fn() },
    outreachConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    discoveryProfile: { findMany: vi.fn().mockResolvedValue([]) },
    competitorProfile: { findMany: vi.fn().mockResolvedValue([]) },
    companyTrendConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    marketingPlan: { findFirst: vi.fn().mockResolvedValue(null) },
    connection: { findMany: vi.fn().mockResolvedValue([]) },
    linkedInConnection: { findFirst: vi.fn().mockResolvedValue(null) },
    auditLog: { count: vi.fn().mockResolvedValue(0) },
    campaign: { findMany: vi.fn().mockResolvedValue([]) },
    contentDraft: { findMany: vi.fn().mockResolvedValue([]) },
    analyticsReport: { findFirst: vi.fn().mockResolvedValue(null) },
    knowledgeChunk: {
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
    },
    knowledgeSource: { findMany: vi.fn().mockResolvedValue([]) },
    marketingMemory: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { tx, db };
});

vi.mock('@/lib/db', () => ({ db }));

import { ZodError } from 'zod';
import {
  BusinessContextConflictError,
  BusinessContextUpdateError,
  businessContextPatchSchema,
  type UpdateOrigin,
} from '@/lib/validations/business-context';
import {
  EMPTY_STORED_CONTEXT,
  planBusinessContextWrite,
  type StoredBusinessContext,
} from '@/server/business-context/update';
import {
  AUDIENCE_ALIASES,
  audiencePatch,
  companyProfilePatch,
  onboardingPatch,
} from '@/server/business-context/adapters';
import { updateBusinessContext } from '@/server/business-context/business-context-write.service';
import {
  getWorkflowContext,
  WORKFLOW_PRESETS,
  WORKFLOW_REQUIREMENTS,
} from '@/server/business-context/business-context.service';
import { handleRouteError } from '@/lib/api';

const REVISION = new Date('2026-09-30T10:00:00Z');

function stored(
  overrides: Partial<StoredBusinessContext> = {},
): StoredBusinessContext {
  return {
    name: 'Verdant Roastery',
    website: 'https://verdant.coffee',
    industry: 'Food & beverage',
    brandVoiceNotes: null,
    brandVoiceProfile: null,
    preferences: {
      business: {
        description: 'We roast single-origin coffee in small batches.',
      },
      marketingProfile: {
        marketMode: 'B2C',
        audience: 'People who own a grinder.',
      },
      autopilot: { enabled: true },
    },
    ...overrides,
  };
}

const plan = (
  current: StoredBusinessContext,
  patch: unknown,
  origin: UpdateOrigin = 'settings',
) =>
  planBusinessContextWrite(
    current,
    businessContextPatchSchema.parse(patch),
    origin,
  );

function refused(fn: () => unknown): BusinessContextUpdateError {
  try {
    fn();
  } catch (err) {
    if (err instanceof BusinessContextUpdateError) return err;
    throw err;
  }
  throw new Error('expected the update to be refused');
}

// ---------------------------------------------------------------------------

describe('patch schema — what may be sent', () => {
  it('rejects fields owned by other modules, and says where to edit them', () => {
    const market = businessContextPatchSchema.safeParse({
      market: { keywords: ['x'] },
    });
    expect(market.success).toBe(false);
    expect(JSON.stringify(market.error?.issues)).toContain(
      'managed by their own modules',
    );

    const roles = businessContextPatchSchema.safeParse({
      audience: { roleTitles: ['CTO'] },
    });
    expect(roles.success).toBe(false);
    expect(JSON.stringify(roles.error?.issues)).toContain('Outreach targeting');
  });

  it('rejects values outside the allowed set', () => {
    expect(
      businessContextPatchSchema.safeParse({ audience: { marketMode: 'B2G' } })
        .success,
    ).toBe(false);
    expect(
      businessContextPatchSchema.safeParse({ channels: { preferred: ['Fax'] } })
        .success,
    ).toBe(false);
    expect(
      businessContextPatchSchema.safeParse({
        objectives: { contentFormats: ['PODCAST'] },
      }).success,
    ).toBe(false);
    expect(
      businessContextPatchSchema.safeParse({
        identity: { visual: { primaryColor: 'blue' } },
      }).success,
    ).toBe(false);
    expect(
      businessContextPatchSchema.safeParse({
        identity: { website: 'not a site' },
      }).success,
    ).toBe(false);
    expect(
      businessContextPatchSchema.safeParse({
        identity: { visual: { logoAssetId: '../etc' } },
      }).success,
    ).toBe(false);
  });

  it('cleans text, treats empty as clear, and de-duplicates lists', () => {
    const out = businessContextPatchSchema.parse({
      identity: {
        description: '  We roast\u0000   coffee\u0007 ',
        industry: '',
        website: 'verdant.coffee',
      },
      channels: { preferred: ['LinkedIn', 'LinkedIn', 'X'] },
    });
    expect(out.identity?.description).toBe('We roast coffee');
    expect(out.identity?.industry).toBeNull();
    expect(out.identity?.website).toBe('https://verdant.coffee');
    expect(out.channels?.preferred).toEqual(['LinkedIn', 'X']);
  });

  it('enforces length caps with a readable message', () => {
    const r = businessContextPatchSchema.safeParse({
      identity: { description: 'a'.repeat(601) },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(
      '600 characters or fewer',
    );
  });
});

describe('update rules — what may be stored', () => {
  it('R7: writes nothing when nothing changes', () => {
    const p = plan(stored(), {
      identity: {
        name: 'Verdant Roastery',
        description: 'We roast single-origin coffee in small batches.',
      },
      audience: { marketMode: 'B2C' },
    });
    expect(p.changed).toEqual([]);
    expect(p.data).toEqual({});
  });

  it('R3: judges a changed value, not one already stored', () => {
    const legacy = stored({
      preferences: {
        business: { description: 'Coffee.' },
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'People who own a grinder.',
        },
      },
    });
    // The form re-sends the short legacy description with an unrelated edit.
    expect(
      plan(legacy, { identity: { description: 'Coffee.', industry: 'Coffee' } })
        .changed,
    ).toEqual(['identity.industry']);
    // Changing it to something equally thin is refused.
    const err = refused(() =>
      plan(legacy, { identity: { description: 'Tea.' } }),
    );
    expect(err.issues[0]?.field).toBe('identity.description');
    expect(err.issues[0]?.message).toContain('at least 20 characters');
  });

  it('R3: refuses placeholder answers', () => {
    const err = refused(() =>
      plan(stored(), {
        objectives: { goals: 'TBD' },
        identity: { offerings: 'n/a' },
      }),
    );
    expect(err.issues.map((i) => i.field).sort()).toEqual([
      'identity.offerings',
      'objectives.goals',
    ]);
  });

  it('R7: a re-sent legacy value with stray spaces is not a change', () => {
    const legacy = stored({
      preferences: {
        business: { description: 'We roast single-origin coffee in small batches.' },
        marketingProfile: {
          marketMode: 'B2C',
          audience: 'People  who\talready own a grinder. ',
        },
      },
    });
    // The audience form re-sends the stored audience along with a new goal.
    const p = plan(legacy, {
      audience: { stated: 'People  who\talready own a grinder. ' },
      objectives: { goals: 'Grow subscriptions' },
    });
    expect(p.changed).toEqual(['objectives.goals']);
  });

  it('R3: never treats a company name as a placeholder', () => {
    for (const name of ['XX', 'Same', 'Nothing', 'Test Kitchen']) {
      expect(plan(stored(), { identity: { name } }).changed, name).toEqual([
        'identity.name',
      ]);
    }
  });

  it('R4: a required field cannot be cleared', () => {
    const err = refused(() => plan(stored(), { audience: { stated: '' } }));
    expect(err.issues[0]).toMatchObject({ field: 'audience.stated' });
    expect(err.message).toContain('cannot be removed');
  });

  it('R4: onboarding must supply every required field', () => {
    const err = refused(() =>
      plan(EMPTY_STORED_CONTEXT, { identity: { name: 'Acme' } }, 'onboarding'),
    );
    expect(err.issues.map((i) => i.field).sort()).toEqual([
      'audience.marketMode',
      'audience.stated',
      'identity.description',
    ]);
  });

  it('R6: AI may rewrite the voice profile but nothing the business stated', () => {
    const profile = { toneDescriptors: ['warm'], summary: 'Warm and plain.' };
    expect(plan(stored(), { voice: { profile } }, 'ai').changed).toEqual([
      'voice.profile',
    ]);
    const err = refused(() =>
      plan(
        stored(),
        {
          identity: { description: 'An AI rewrite of what the business does.' },
        },
        'ai',
      ),
    );
    expect(err.message).toContain('Only a person can change this');
  });

  it('R8: merges into preferences without touching other sections', () => {
    const p = plan(
      stored({
        preferences: {
          business: {
            description: 'We roast single-origin coffee in small batches.',
          },
          marketingProfile: {
            marketMode: 'B2C',
            audience: 'People who own a grinder.',
          },
          brand: { primaryColor: '#112233', accentColor: '#445566' },
          autopilot: { enabled: true },
        },
      }),
      {
        identity: { visual: { primaryColor: '', secondaryColor: '#abc' } },
        objectives: { goals: '200 subscribers' },
      },
    );
    expect(p.data.preferences).toMatchObject({
      autopilot: { enabled: true },
      brand: { accentColor: '#445566', secondaryColor: '#aabbcc' },
      marketingProfile: { marketMode: 'B2C', goals: '200 subscribers' },
    });
    expect(
      (p.data.preferences?.brand as Record<string, unknown>).primaryColor,
    ).toBeUndefined();
  });

  it('keeps an empty formats list, which means "all formats"', () => {
    const p = plan(
      stored({
        preferences: {
          ...(stored().preferences as object),
          contentFormats: { enabled: ['BLOG'] },
        },
      }),
      {
        objectives: { contentFormats: [] },
      },
    );
    expect(p.data.preferences?.contentFormats).toEqual({ enabled: [] });
  });

  it('R5: hands a new logo reference to the service to verify', () => {
    expect(
      plan(stored(), { identity: { visual: { logoAssetId: 'lab12' } } })
        .references,
    ).toEqual({
      logoAssetId: 'lab12',
    });
  });

  it('reports every refused field at once, under the form’s own names', () => {
    const err = refused(() =>
      planBusinessContextWrite(
        stored(),
        businessContextPatchSchema.parse({
          audience: { stated: '' },
          objectives: { goals: 'test' },
        }),
        'settings',
        AUDIENCE_ALIASES,
      ),
    );
    expect(Object.keys(err.details).sort()).toEqual(['audience', 'goals']);
  });
});

describe('screen adapters', () => {
  it('audience form: an emptied field clears, an unsent field is left alone', () => {
    expect(
      audiencePatch({ goals: undefined, marketMode: 'B2B' }, { goals: '' }),
    ).toEqual({
      audience: { marketMode: 'B2B' },
      objectives: { goals: null },
      channels: {},
    });
  });

  it('company profile form maps onto identity and voice', () => {
    expect(
      companyProfilePatch({
        name: 'Acme',
        industry: '',
        brandVoiceNotes: 'Plain',
      }),
    ).toEqual({
      identity: { name: 'Acme', industry: null },
      voice: { notes: 'Plain' },
    });
  });
});

// ---------------------------------------------------------------------------

describe('updateBusinessContext — the transactional write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // First read: the row as stored. Read after a successful swap: the new
    // updatedAt the write produced.
    tx.company.findUnique.mockImplementation(
      ({ select }: { select: Record<string, boolean> }) =>
        Promise.resolve(
          select.name
            ? { ...stored(), updatedAt: REVISION }
            : { updatedAt: new Date('2026-09-30T11:00:00Z') },
        ),
    );
    tx.company.updateMany.mockResolvedValue({ count: 1 });
    tx.auditLog.create.mockResolvedValue({});
  });

  it('writes the change and audits the exact fields and origin', async () => {
    const result = await updateBusinessContext({
      companyId: 'c1',
      userId: 'u1',
      patch: { objectives: { goals: '200 subscribers this quarter' } },
      origin: 'settings',
    });
    expect(result.changed).toEqual(['objectives.goals']);
    expect(result.revision).toBe('2026-09-30T11:00:00.000Z');
    expect(tx.company.updateMany).toHaveBeenCalledTimes(1);
    // Compare-and-swap: only if the row is unchanged since it was read.
    expect(tx.company.updateMany.mock.calls[0]![0].where).toEqual({
      id: 'c1',
      updatedAt: REVISION,
    });
    const audit = tx.auditLog.create.mock.calls[0]![0].data;
    expect(audit.action).toBe('COMPANY_UPDATED');
    expect(audit.metadata).toMatchObject({
      origin: 'settings',
      changedFields: ['objectives.goals'],
    });
  });

  it('re-plans from fresh data when another write lands first, keeping both', async () => {
    // Between our read and our write, autopilot settings were saved.
    const later = new Date('2026-09-30T10:30:00Z');
    let reads = 0;
    tx.company.findUnique.mockImplementation(
      ({ select }: { select: Record<string, boolean> }) => {
        if (!select.name)
          return Promise.resolve({
            updatedAt: new Date('2026-09-30T11:00:00Z'),
          });
        reads += 1;
        const prefs = stored().preferences as Record<string, unknown>;
        return Promise.resolve(
          reads === 1
            ? { ...stored(), updatedAt: REVISION }
            : {
                ...stored(),
                preferences: {
                  ...prefs,
                  autopilot: { enabled: false, perWeek: 2 },
                },
                updatedAt: later,
              },
        );
      },
    );
    tx.company.updateMany
      .mockResolvedValueOnce({ count: 0 }) // lost the race
      .mockResolvedValueOnce({ count: 1 });

    const result = await updateBusinessContext({
      companyId: 'c1',
      userId: 'u1',
      patch: { objectives: { goals: '200 subscribers this quarter' } },
      origin: 'settings',
    });

    expect(result.changed).toEqual(['objectives.goals']);
    expect(tx.company.updateMany).toHaveBeenCalledTimes(2);
    const second = tx.company.updateMany.mock.calls[1]![0];
    expect(second.where.updatedAt).toEqual(later);
    // Both changes survive: the other writer's autopilot and our goal.
    expect(second.data.preferences).toMatchObject({
      autopilot: { enabled: false, perWeek: 2 },
      marketingProfile: { goals: '200 subscribers this quarter' },
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('refuses rather than overwrite when the caller pinned a revision and lost the race', async () => {
    let reads = 0;
    tx.company.findUnique.mockImplementation(
      ({ select }: { select: Record<string, boolean> }) => {
        if (!select.name) return Promise.resolve({ updatedAt: new Date() });
        reads += 1;
        return Promise.resolve({
          ...stored(),
          updatedAt: reads === 1 ? REVISION : new Date('2026-09-30T10:30:00Z'),
        });
      },
    );
    tx.company.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      updateBusinessContext({
        companyId: 'c1',
        userId: 'u1',
        patch: { objectives: { goals: '200 subscribers this quarter' } },
        origin: 'api',
        expectedRevision: REVISION.toISOString(),
      }),
    ).rejects.toBeInstanceOf(BusinessContextConflictError);
  });

  it('skips the write and the audit when nothing changed', async () => {
    const result = await updateBusinessContext({
      companyId: 'c1',
      userId: 'u1',
      patch: { identity: { name: 'Verdant Roastery' } },
      origin: 'settings',
    });
    expect(result.changed).toEqual([]);
    expect(tx.company.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('refuses a stale write instead of overwriting someone else’s edit', async () => {
    await expect(
      updateBusinessContext({
        companyId: 'c1',
        userId: 'u1',
        patch: { objectives: { goals: 'Something new entirely' } },
        origin: 'api',
        expectedRevision: '2026-09-29T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BusinessContextConflictError);
    expect(tx.company.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a logo that belongs to another workspace', async () => {
    tx.generatedAsset.findFirst.mockResolvedValue(null);
    await expect(
      updateBusinessContext({
        companyId: 'c1',
        userId: 'u1',
        patch: { identity: { visual: { logoAssetId: 'someone_elses' } } },
        origin: 'settings',
      }),
    ).rejects.toBeInstanceOf(BusinessContextUpdateError);
    expect(tx.generatedAsset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'someone_elses', companyId: 'c1' },
      }),
    );
    expect(tx.company.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an unsupported field before touching the database', async () => {
    await expect(
      updateBusinessContext({
        companyId: 'c1',
        userId: 'u1',
        patch: { memory: {} },
        origin: 'api',
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(tx.company.findUnique).not.toHaveBeenCalled();
  });

  it('turns a refusal into a 422 with per-field details', async () => {
    const res = handleRouteError(
      new BusinessContextUpdateError(
        [{ field: 'audience.stated', message: 'Too short.' }],
        AUDIENCE_ALIASES,
      ),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'Too short.',
      details: { audience: ['Too short.'] },
    });
  });
});

// ---------------------------------------------------------------------------

describe('workflow retrieval interface', () => {
  it('defines a preset and requirements for every workflow, including opportunity and recommendation', () => {
    expect(Object.keys(WORKFLOW_REQUIREMENTS).sort()).toEqual(
      Object.keys(WORKFLOW_PRESETS).sort(),
    );
    expect(WORKFLOW_REQUIREMENTS.opportunity.requires).toContain(
      'audience.stated',
    );
    expect(WORKFLOW_REQUIREMENTS.recommendation.requires).toContain(
      'identity.description',
    );
  });

  it('serves onboarding data through the service, end to end', async () => {
    // What onboarding stores, produced by the same rules onboarding runs.
    const onboarded = planBusinessContextWrite(
      EMPTY_STORED_CONTEXT,
      businessContextPatchSchema.parse(
        onboardingPatch({
          name: 'Verdant Roastery',
          website: 'https://verdant.coffee',
          industry: 'Food & beverage',
          description: 'We roast single-origin coffee in small batches.',
          offerings: 'Whole bean subscriptions',
          marketMode: 'B2C',
          audience: 'People who already own a grinder.',
          goals: '200 new subscribers',
          brandVoiceNotes: 'Warm and plain-spoken',
        }),
      ),
      'onboarding',
    );
    db.company.findUnique.mockResolvedValue({
      id: 'c1',
      name: onboarded.data.name,
      website: onboarded.data.website,
      industry: onboarded.data.industry,
      brandVoiceNotes: onboarded.data.brandVoiceNotes,
      brandVoiceProfile: null,
      preferences: onboarded.data.preferences,
      updatedAt: REVISION,
    });

    const wf = await getWorkflowContext('c1', 'opportunity');
    expect(wf?.ready).toBe(true);
    expect(wf?.context.identity.description).toBe(
      'We roast single-origin coffee in small batches.',
    );
    expect(wf?.context.audience).toMatchObject({
      marketMode: 'B2C',
      stated: 'People who already own a grinder.',
    });
    expect(wf?.context.objectives.goals).toBe('200 new subscribers');
    expect(wf?.context.voice.notes).toBe('Warm and plain-spoken');
    expect(wf?.context.meta.revision).toBe(REVISION.toISOString());
    expect(wf?.prompt).toContain('single-origin coffee');
  });

  it('tells an opportunity workflow what is missing instead of letting it invent', async () => {
    db.company.findUnique.mockResolvedValue({
      id: 'c1',
      name: 'Legacy Co',
      website: null,
      industry: null,
      brandVoiceNotes: null,
      brandVoiceProfile: null,
      preferences: {},
      updatedAt: REVISION,
    });
    const wf = await getWorkflowContext('c1', 'opportunity');
    expect(wf?.ready).toBe(false);
    expect(wf?.missing.map((m) => m.field)).toEqual([
      'identity.description',
      'audience.marketMode',
      'audience.stated',
    ]);
    expect(wf?.missing[0]?.href).toBe('/dashboard/business');
  });

  it('returns null for an unknown workspace', async () => {
    db.company.findUnique.mockResolvedValue(null);
    expect(await getWorkflowContext('nope', 'content')).toBeNull();
  });
});
