import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Social publishing from WhatsApp (Phase 7): "a post for all my social media
 * accounts" → which networks → the post → per-network previews → "approve and
 * publish" → a confirmation naming the exact networks → Content Studio's
 * one-click publishing → results per network. The publishing service itself
 * is tested in multi-publish.test.ts; here it is mocked so we can see exactly
 * what the conversation asks it to do.
 */

vi.mock('@/lib/db', async () => ({ db: (await import('./fixtures/whatsapp-db')).db }));

const m = vi.hoisted(() => ({
  drafts: new Map<string, any>(),
  generateDraft: vi.fn(),
  runReviewAction: vi.fn(),
  previewPublishing: vi.fn(),
  publishToPlatforms: vi.fn(),
}));

vi.mock('@/server/content/content.service', () => ({
  getDraft: async (companyId: string, id: string) => {
    const d = m.drafts.get(id);
    return d && d.companyId === companyId ? { ...d } : null;
  },
  listDrafts: async () => [],
}));
vi.mock('@/server/content/generator', () => ({ generateDraft: m.generateDraft }));
vi.mock('@/server/content/render', () => ({ renderForManual: (d: any) => d.body?.text ?? '' }));
vi.mock('@/server/review/review-actions.service', () => ({ runReviewAction: m.runReviewAction }));
vi.mock('@/server/company/profile.service', () => ({ getEnabledContentTypes: async () => ['LINKEDIN_POST', 'IMAGE_POST'] }));
vi.mock('@/server/content/multi-publish.service', () => ({
  previewPublishing: m.previewPublishing,
  publishToPlatforms: m.publishToPlatforms,
}));
vi.mock('@/server/ai/claude', () => ({
  completeStructured: vi.fn(),
  isClaudeConfigured: () => false,
  aiFailureMessage: () => null,
  ClaudeNotConfiguredError: class extends Error {},
}));

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.NEXTAUTH_SECRET = 'test-nextauth-secret';
process.env.APP_URL = 'https://aura.example';

import { parseWebhook, type WhatsAppConfig } from '@/lib/whatsapp';
import { matchIntent, parsePlatforms } from '@/lib/whatsapp-intent';
import { processWebhook } from '@/server/whatsapp/whatsapp.service';
import { drainConversations } from '@/server/whatsapp/queue';
import { confirmChallenge } from '@/server/whatsapp/link.service';
import { resetStore, seedUser, store } from './fixtures/whatsapp-db';
import { PHONE_ID, SECRET, textWebhook } from './fixtures/whatsapp';

const config: WhatsAppConfig = { accessToken: 't', phoneNumberId: PHONE_ID, appSecret: SECRET, verifyToken: 'v', apiVersion: 'v23.0' };

function fakeMeta() {
  const calls: any[] = [];
  let n = 0;
  const impl = (async (_u: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.status === 'read') return new Response('{"success":true}', { status: 200 });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.O${++n}` }] }), { status: 200 });
  }) as typeof fetch;
  const sends = () => calls.filter((c) => !c.status);
  const textOf = (c: any) => c?.text?.body ?? c?.interactive?.body?.text ?? '';
  return {
    impl,
    last: () => sends().at(-1),
    lastText: () => textOf(sends().at(-1)),
    ids: () => {
      const a = sends().at(-1)?.interactive?.action;
      return [...(a?.buttons ?? []).map((b: any) => b.reply.id), ...(a?.sections ?? []).flatMap((s: any) => s.rows.map((r: any) => r.id))];
    },
  };
}

let seq = 0;
const NUMBER = '919876543210';
async function say(meta: ReturnType<typeof fakeMeta>, text: string, replyId?: string) {
  const body = textWebhook({ from: NUMBER, wamid: `w${++seq}`, text });
  if (replyId) {
    (body.entry[0]!.changes[0]!.value as any).messages[0] = {
      from: NUMBER,
      id: `w${seq}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: replyId, title: text } },
    };
  }
  const r = await processWebhook(parseWebhook(body, PHONE_ID));
  await drainConversations({ config, conversationIds: r.conversationIds, fetchImpl: meta.impl });
}

async function signedIn(meta: ReturnType<typeof fakeMeta>, role: string) {
  const { user, companies } = seedUser(`${role.toLowerCase()}${++seq}@cafe.test`, [{ company: 'Cafe', role }]);
  await say(meta, 'Hi');
  const token = (meta.last().interactive.action.parameters.url as string).split('/').pop()!;
  const { code } = await confirmChallenge({ token, userId: user.id });
  await say(meta, code);
  return { user, company: companies[0]! };
}

const preview = (overrides: Record<string, any> = {}) =>
  ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN'].map((platform) => ({
    platform,
    label: { FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', LINKEDIN: 'LinkedIn' }[platform],
    text: `Cold brew is here (${platform})`,
    images: 0,
    ready: platform !== 'INSTAGRAM',
    blockers: platform === 'INSTAGRAM' ? ['Instagram posts need an image — attach one first.'] : [],
    publication: null,
    ...(overrides[platform] ?? {}),
  }));

beforeEach(() => {
  resetStore();
  m.drafts.clear();
  for (const f of [m.generateDraft, m.runReviewAction, m.previewPublishing, m.publishToPlatforms]) f.mockReset();
  m.generateDraft.mockImplementation(async (args: any) => {
    const d = { id: `draft_${++seq}`, companyId: args.companyId, type: args.type, platform: args.platform, status: 'DRAFT', body: { text: 'Cold brew is here.' } };
    m.drafts.set(d.id, d);
    return d;
  });
  m.previewPublishing.mockImplementation(async () => preview());
});

describe('understanding the request', () => {
  it('a post for several networks, before a post for one', () => {
    expect(matchIntent('Create a marketing post for all my social media accounts', { hasDraft: false })).toEqual({ tool: 'plan_social_post', args: {} });
    expect(matchIntent('Create a post for Facebook and Instagram about our Diwali offer', { hasDraft: false })).toEqual({
      tool: 'plan_social_post',
      args: { topic: 'our Diwali offer', platforms: ['FACEBOOK', 'INSTAGRAM'] },
    });
    // One network named is still the single-post tool.
    expect(matchIntent('write a LinkedIn post about AI', { hasDraft: false })?.tool).toBe('generate_post');
  });

  it('networks as people type them', () => {
    expect(parsePlatforms('Facebook, Instagram and LinkedIn.')).toEqual(['FACEBOOK', 'INSTAGRAM', 'LINKEDIN']);
    expect(parsePlatforms('fb + insta')).toEqual(['FACEBOOK', 'INSTAGRAM']);
    expect(parsePlatforms('all three')).toEqual(['FACEBOOK', 'INSTAGRAM', 'LINKEDIN']);
    expect(parsePlatforms('next week maybe')).toBeNull();
  });

  it('“approve and publish” on the current post', () => {
    expect(matchIntent('Approve and publish.', { hasDraft: true })).toEqual({ tool: 'publish_draft', args: {} });
    expect(matchIntent('publish to facebook', { hasDraft: true })).toEqual({ tool: 'publish_draft', args: { platforms: ['FACEBOOK'] } });
    expect(matchIntent('approve and publish', { hasDraft: false })).toBeNull();
  });
});

describe('the conversation', () => {
  it('asks which platforms, writes the post, and previews each network', async () => {
    const meta = fakeMeta();
    const { company } = await signedIn(meta, 'OWNER');
    await say(meta, 'Create a marketing post for all my social media accounts');
    expect(meta.lastText()).toMatch(/^Which platforms\?/);
    expect(meta.ids()).toContain('plat:FACEBOOK,INSTAGRAM,LINKEDIN');

    await say(meta, 'Facebook, Instagram and LinkedIn.');
    expect(meta.lastText()).toBe('What should the post for Facebook, Instagram and LinkedIn be about?');

    await say(meta, 'our new cold brew');
    expect(m.generateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: company.id, type: 'IMAGE_POST', platform: 'INSTAGRAM', source: { kind: 'BRIEF', brief: 'our new cold brew' } }),
    );
    const text = meta.lastText();
    expect(text).toMatch(/Written and saved as a draft in Content Studio, for Facebook, Instagram and LinkedIn/);
    expect(text).toMatch(/\*Facebook\* — ✅ ready\nCold brew is here \(FACEBOOK\)/);
    expect(text).toMatch(/\*Instagram\* — ⚠️ Instagram posts need an image/);
    expect(meta.ids()).toEqual(['pub:go', expect.stringMatching(/^act:image:/), expect.stringMatching(/^act:edit:/)]);
    expect(meta.last().interactive.action.buttons[0].reply.title).toBe('Approve & publish');
  });

  it('picking from the list works the same as typing', async () => {
    const meta = fakeMeta();
    await signedIn(meta, 'OWNER');
    await say(meta, 'Create a post for my social accounts about our cold brew');
    await say(meta, 'Facebook + Instagram', 'plat:FACEBOOK,INSTAGRAM');
    expect(m.generateDraft).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: 'BRIEF', brief: 'our cold brew' } }));
    expect(meta.lastText()).toMatch(/for Facebook and Instagram/);
    expect(meta.lastText()).not.toMatch(/LinkedIn/);
  });

  it('“approve and publish” names the exact networks and publishes nothing until the yes', async () => {
    const meta = fakeMeta();
    const { company } = await signedIn(meta, 'OWNER');
    await say(meta, 'Create a post for Facebook, Instagram and LinkedIn about cold brew');
    await say(meta, 'Approve and publish.');
    expect(meta.lastText()).toMatch(/^Approve and publish this post to \*Facebook and LinkedIn\* now\?/);
    expect(meta.lastText()).toMatch(/Not included:\n• Instagram — Instagram posts need an image/);
    expect(m.publishToPlatforms).not.toHaveBeenCalled();

    m.publishToPlatforms.mockResolvedValue({
      results: [
        { platform: 'FACEBOOK', status: 'published', url: 'https://facebook.example/p/1' },
        { platform: 'LINKEDIN', status: 'failed', message: 'LinkedIn did not answer.' },
      ],
      approvedNow: true,
    });
    const confirm = meta.ids()[0]!;
    await say(meta, 'Yes, approve & publish', confirm);
    expect(m.publishToPlatforms).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: company.id, role: 'OWNER', platforms: ['FACEBOOK', 'LINKEDIN'], acknowledged: false }),
    );
    expect(meta.lastText()).toMatch(/✅ Facebook — published: https:\/\/facebook\.example\/p\/1/);
    expect(meta.lastText()).toMatch(/❌ LinkedIn — failed: LinkedIn did not answer\./);
    expect(meta.lastText()).toMatch(/never posted twice/);
    // The confirmation is single use.
    await say(meta, 'Yes', confirm);
    expect(m.publishToPlatforms).toHaveBeenCalledTimes(1);
  });

  it('flagged claims: a second, explicit yes', async () => {
    const meta = fakeMeta();
    await signedIn(meta, 'OWNER');
    await say(meta, 'Create a post for Facebook and LinkedIn about cold brew');
    await say(meta, 'approve and publish');
    m.publishToPlatforms.mockRejectedValueOnce(Object.assign(new Error('1 claim could not be verified.'), { status: 409, code: 'facts_need_review' }));
    await say(meta, 'Yes', meta.ids()[0]);
    expect(meta.lastText()).toMatch(/^Before approving: 1 claim could not be verified/);
    m.publishToPlatforms.mockResolvedValue({ results: [{ platform: 'FACEBOOK', status: 'published', url: null }], approvedNow: true });
    await say(meta, 'I’ve checked — publish', meta.ids()[0]);
    expect(m.publishToPlatforms).toHaveBeenLastCalledWith(expect.objectContaining({ acknowledged: true }));
  });

  it('a member can write for several networks but not publish', async () => {
    const meta = fakeMeta();
    await signedIn(meta, 'MEMBER');
    await say(meta, 'Create a post for Facebook and LinkedIn about cold brew');
    expect(meta.ids()).not.toContain('pub:go');
    expect(meta.ids()[0]).toMatch(/^act:submit:/);
    expect(meta.lastText()).toMatch(/An owner or admin approves and publishes it/);
    await say(meta, 'approve and publish');
    expect(meta.lastText()).toMatch(/can’t do that/);
    expect(m.publishToPlatforms).not.toHaveBeenCalled();
  });

  it('demoted between the question and the yes: refused', async () => {
    const meta = fakeMeta();
    const { user } = await signedIn(meta, 'OWNER');
    await say(meta, 'Create a post for Facebook and LinkedIn about cold brew');
    await say(meta, 'approve and publish');
    store.members.find((x) => x.userId === user.id)!.role = 'MEMBER';
    await say(meta, 'Yes', meta.ids()[0]);
    expect(meta.lastText()).toMatch(/Only owners and admins can publish/);
    expect(m.publishToPlatforms).not.toHaveBeenCalled();
  });

  it('publishing an approved post asks which networks when none were chosen', async () => {
    const meta = fakeMeta();
    const { company } = await signedIn(meta, 'ADMIN');
    const d = { id: 'draft_approved', companyId: company.id, type: 'IMAGE_POST', platform: 'INSTAGRAM', status: 'APPROVED', body: { text: 'Cold brew.' } };
    m.drafts.set(d.id, d);
    await say(meta, 'open', `draft:${d.id}`);
    expect(meta.ids()[0]).toBe(`act:publish:${d.id}`);
    await say(meta, 'Publish', `act:publish:${d.id}`);
    expect(meta.lastText()).toMatch(/^Publish to which platforms\?/);
    await say(meta, 'Facebook only', 'plat:FACEBOOK');
    expect(meta.lastText()).toMatch(/^Publish this post to \*Facebook\* now\?/);
  });

  it('nothing ready: says why, asks nothing', async () => {
    const meta = fakeMeta();
    await signedIn(meta, 'OWNER');
    m.previewPublishing.mockImplementation(async () =>
      preview({ FACEBOOK: { ready: false, blockers: ['Facebook isn’t connected.'] }, LINKEDIN: { ready: false, blockers: ['LinkedIn isn’t connected.'] } }),
    );
    await say(meta, 'Create a post for Facebook and LinkedIn about cold brew');
    await say(meta, 'publish');
    expect(meta.lastText()).toMatch(/^Nothing can be published right now\./);
    expect(meta.ids()).toEqual([]);
  });
});
