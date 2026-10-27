import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The WhatsApp conversation's memory of what someone is working on.
 *
 * `targets` — the networks a post is meant for — belongs to one draft. Nothing
 * dropped it when the conversation moved to a different draft, so the networks
 * chosen while writing one post became the silent answer to "where should this
 * other post go?", and publish stopped asking because it already had targets.
 * Every publish still showed a confirmation naming the networks, so nothing
 * went out unseen — but Aura was answering its own question with a choice
 * someone had made about something else.
 */
const store = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
}));

vi.mock('@/lib/db', () => ({
  db: {
    whatsAppAccountLink: {
      findUnique: async () => ({ state: store.state }),
      update: async ({ data }: { data: { state: Record<string, unknown> } }) => {
        store.state = data.state;
        return { state: store.state };
      },
    },
  },
}));

const LINK = 'link_1';
const COMPANY = 'co_1';

async function state() {
  const { readState } = await import('@/server/whatsapp/tools/state');
  return readState(LINK, COMPANY);
}

async function write(patch: Record<string, unknown>) {
  const { writeState } = await import('@/server/whatsapp/tools/state');
  return writeState(LINK, COMPANY, patch as never);
}

beforeEach(() => {
  store.state = {};
});

describe('session state', () => {
  it('remembers the networks chosen for the draft in hand', async () => {
    await write({ draftId: 'd1', targets: ['FACEBOOK', 'LINKEDIN'] });
    expect((await state()).targets).toEqual(['FACEBOOK', 'LINKEDIN']);
  });

  it('forgets them when the conversation moves to another draft', async () => {
    await write({ draftId: 'd1', targets: ['FACEBOOK', 'LINKEDIN'] });
    await write({ draftId: 'd2' });

    const next = await state();
    expect(next.draftId).toBe('d2');
    expect(next.targets).toBeUndefined();
  });

  /**
   * One draft and its networks being set together is not a draft switch
   * inheriting someone else's choice — the patch says both, so the patch wins.
   */
  it('keeps networks named in the same breath as the new draft', async () => {
    await write({ draftId: 'd1', targets: ['FACEBOOK'] });
    await write({ draftId: 'd2', targets: ['INSTAGRAM'] });

    expect((await state()).targets).toEqual(['INSTAGRAM']);
  });

  it('leaves them alone while the draft stays the same', async () => {
    await write({ draftId: 'd1', targets: ['FACEBOOK'] });
    await write({ draftId: 'd1', assetId: 'a1' });
    await write({ pending: undefined });

    const next = await state();
    expect(next.targets).toEqual(['FACEBOOK']);
    expect(next.assetId).toBe('a1');
  });

  it('keeps clearing a key by setting it undefined', async () => {
    await write({ draftId: 'd1', targets: ['FACEBOOK'] });
    await write({ targets: undefined });
    expect((await state()).targets).toBeUndefined();
  });

  /** State belongs to one workspace: another workspace reads a blank slate. */
  it('does not leak across workspaces', async () => {
    await write({ draftId: 'd1', targets: ['FACEBOOK'] });
    const { readState } = await import('@/server/whatsapp/tools/state');
    expect(await readState(LINK, 'other_co')).toEqual({});
  });
});
