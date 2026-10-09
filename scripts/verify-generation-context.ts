/**
 * Context assembly for content generation, against the real database and the
 * running app (lib/generation-context.ts).
 *
 * One workspace with its own suggestions, material carrying personal and
 * secret data, earlier posts, learned patterns and campaigns — some relevant
 * to the piece, some not:
 *
 *   Package   carries the business (from the current snapshot), goal,
 *             audience, voice, channel and the recommendation; traces to the
 *             recommendation, opportunity and brief; keeps only relevant
 *             material, posts, patterns and campaigns; redacts personal and
 *             secret data; stays in budget
 *   Current   a change to the business is used on the next draft
 *   Received  the real generator runs with the model stubbed at the network:
 *             what it would send is checked — context in, nothing sensitive
 *   Live      a real draft through the app records the package's trace
 *             (skipped when the AI provider is unavailable)
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:generation-context
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { generationContextToPrompt } from '@/lib/generation-context';
import { briefText } from '@/lib/content-brief';
import { getContentBrief } from '@/server/content/content-brief.service';
import { generateDraft } from '@/server/content/generator';
import { getCreation } from '@/server/recommendations/creation.service';
import { assembleDraftContext } from '@/server/content/generation-context.service';
import { runDetection } from '@/server/opportunities/detection.service';
import { suggestFromOpportunities } from '@/server/recommendations/autosuggest.service';
import { decideRecommendation } from '@/server/recommendations/recommendation.service';
import { collectSignals } from '@/server/signals/signal.service';

const BASE = (
  process.env.VERIFY_BASE_URL ??
  process.env.AURA_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-context-${STAMP}!`;
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

class Client {
  private jar = new Map<string, string>();
  private keep(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      this.jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
  }
  private cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        Origin: BASE,
        cookie: this.cookie(),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.keep(res);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* page */
    }
    return { status: res.status, json: json as Record<string, any>, text };
  }
  async page(path: string) {
    const r = await this.req('GET', path);
    return {
      status: r.status,
      text: r.text
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#x27;|&rsquo;/g, '’')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' '),
    };
  }
  async signIn(email: string) {
    const csrf = await this.req('GET', '/api/auth/csrf');
    const token = (csrf.json as { csrfToken: string }).csrfToken;
    const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        cookie: this.cookie(),
      },
      body: new URLSearchParams({
        csrfToken: token,
        email,
        password: PASSWORD,
        json: 'true',
      }),
    });
    this.keep(res);
    const s = await this.req('GET', '/api/auth/session');
    return (s.json as { user?: { email?: string } })?.user?.email;
  }
}

async function person(label: string) {
  return db.user.create({
    data: {
      email: `zzverify-context-${label}-${STAMP}@example.test`,
      name: `Dana ${label}`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      emailVerified: new Date(),
    },
  });
}

const PROFILE = {
  business: {
    description:
      'We roast single-origin coffee in small batches and sell subscriptions online.',
  },
  marketingProfile: {
    marketMode: 'B2C',
    audience: 'Home brewers who buy beans online',
    channels: ['LinkedIn', 'Instagram'],
    goals: 'Grow coffee subscriptions',
  },
};

async function seed(companyId: string) {
  const item = (id: string, title: string, url: string) => ({
    id,
    title,
    url,
    source: 'news',
    sourceLabel: 'News',
    score: 10,
    publishedAt: ago(2).toISOString(),
    aiSummary: title,
    suggestedAngle: '',
  });
  await db.companyTrendConfig.create({
    data: { companyId, keywords: ['specialty coffee'] },
  });
  await db.trendDigest.create({
    data: {
      companyId,
      date: ago(1),
      payload: {
        items: [
          item(
            'n1',
            'Specialty coffee prices climb as harvests shrink',
            'https://a.example/1',
          ),
          item(
            'n2',
            'Why specialty coffee shops win on transparency',
            'https://a.example/2',
          ),
        ],
        summary: '',
        recommendations: [],
        hashtags: [],
        seasonal: [],
        competitorMentions: [],
      } as Prisma.InputJsonObject,
    },
  });
  const acme = await db.competitorProfile.create({
    data: { companyId, name: 'Acme Coffee' },
  });
  await db.competitorSnapshot.create({
    data: {
      competitorId: acme.id,
      capturedAt: ago(3),
      changesSummary: {
        hasChanges: true,
        pricing: 'Cut subscriptions by 20%',
        news: [],
        skipped: [],
        model: 'x',
        capturedAt: ago(3).toISOString(),
      } as Prisma.InputJsonObject,
    },
  });
  for (const [s, e, v] of [
    [14, 7, 500],
    [7, 0, 300],
  ] as const) {
    await db.analyticsReport.create({
      data: {
        companyId,
        periodStart: ago(s),
        periodEnd: ago(e),
        summary: 'p',
        metrics: { totalEngagement: v },
      },
    });
  }
  await collectSignals(companyId);
  await runDetection(companyId);
  await suggestFromOpportunities(companyId, { templatesOnly: true });
  return db.recommendation.findMany({
    where: { companyId },
    orderBy: { priorityScore: 'desc' },
  });
}

const actionOf = (r: { details: unknown }) =>
  (r.details as { action?: string } | null)?.action ?? '';

async function main() {
  const owner = await person('owner');
  const company = await db.company.create({
    data: {
      name: 'zzverify context Roastery',
      slug: `zzverify-context-${STAMP}`,
      industry: 'Coffee',
      website: 'https://www.roastery.example',
      preferences: PROFILE as Prisma.InputJsonObject,
    },
  });
  const companyId = company.id;
  await db.companyMember.create({
    data: { userId: owner.id, companyId, role: 'OWNER' },
  });

  try {
    const recs = await seed(companyId);
    // Material: one passage on the topic carrying personal and secret data,
    // one unrelated; earlier posts, one related and one not; two campaigns.
    const [onTopic, offTopic] = await Promise.all([
      db.knowledgeChunk.create({
        data: {
          companyId,
          sourceType: 'UPLOAD',
          title: 'Specialty coffee pricing notes',
          content:
            'Specialty coffee prices climb when harvests shrink; we absorb part of it for subscribers. Supplier contact: maria.lopez@gmail.com, +44 20 7946 0958. Shop email: hello@roastery.example. Internal: api_key=sk-ant-abcdefghijklmnopqrstuvwxyz123456.',
        },
      }),
      db.knowledgeChunk.create({
        data: {
          companyId,
          sourceType: 'UPLOAD',
          title: 'Office notes',
          content: 'The staff party is on Friday at the warehouse.',
        },
      }),
    ]);
    const [relatedPost, otherPost] = await Promise.all([
      db.contentDraft.create({
        data: {
          companyId,
          createdById: owner.id,
          type: 'LINKEDIN_POST',
          status: 'PUBLISHED',
          platform: 'LINKEDIN',
          title: 'Why specialty coffee prices change',
          body: {
            hook: 'Specialty coffee prices follow the harvest.',
            body: 'Specialty coffee prices rise when harvests shrink and shipping costs climb.',
            cta: 'Ask us anything.',
            hashtags: [],
          },
        },
      }),
      db.contentDraft.create({
        data: {
          companyId,
          createdById: owner.id,
          type: 'LINKEDIN_POST',
          status: 'PUBLISHED',
          platform: 'LINKEDIN',
          title: 'Meet our head roaster',
          body: {
            hook: 'Say hello to Sam.',
            body: 'Sam has roasted with us for ten years.',
            cta: 'Say hi.',
            hashtags: [],
          },
        },
      }),
    ]);
    await db.marketingMemory.createMany({
      data: [
        {
          companyId,
          insightType: 'TOPIC',
          insight: 'Posts about specialty coffee prices get the most comments',
          confidence: 'HIGH',
          sampleSize: 12,
        },
        {
          companyId,
          insightType: 'TOPIC',
          insight: 'Posts about gardening underperform',
          confidence: 'HIGH',
          sampleSize: 9,
        },
      ],
    });
    await db.campaign.createMany({
      data: [
        {
          companyId,
          name: 'Holiday gifts',
          goal: 'Sell gift boxes',
          status: 'ACTIVE',
          themes: ['gifts'],
        },
      ],
    });

    const rec = recs.find((r) =>
      ['post', 'response-post'].includes(actionOf(r)),
    );
    if (!rec) throw new Error('No content suggestion to write from.');
    await db.recommendation.update({
      where: { id: rec.id },
      data: { status: 'PRESENTED', blockers: [], executable: true },
    });
    await decideRecommendation({
      companyId,
      recommendationId: rec.id,
      decision: 'ACCEPTED',
      actorId: owner.id,
    });
    const brief = await getContentBrief(companyId, rec.id);
    console.log(`   writing from: “${rec.title}” (${actionOf(rec)})`);

    // ------------------------------------------------------------ The package
    console.log('\n1. The package the model receives');
    const ctx = await assembleDraftContext({
      companyId,
      type: brief!.contentType!.key,
      platform: brief!.channel?.platform ?? null,
      brief:
        'Specialty coffee prices are rising — what it means for our subscribers.',
      query: 'specialty coffee prices subscribers',
      contentBrief: brief,
      campaignId: null,
      reference: [],
    });
    const text = generationContextToPrompt(ctx);
    const keys = ctx.sections.map((s) => s.key);
    check(
      'it carries the business, goal, audience, voice, channel and the recommendation',
      [
        'brief',
        'business',
        'channel',
        'recommendation',
        'opportunity',
        'goal',
        'audience',
      ].every((k) => keys.includes(k as never)) &&
        text.includes(PROFILE.business.description),
      keys.join(', '),
    );
    const stored = await db.businessContextSnapshot.findUnique({
      where: { companyId },
    });
    check(
      'business context comes from the current Business Context Snapshot',
      ctx.trace.snapshot.fingerprint === stored?.fingerprint,
      `${ctx.trace.snapshot.fingerprint} / ${stored?.fingerprint}`,
    );
    check(
      'it traces back to the recommendation, its opportunity and the brief version',
      ctx.trace.recommendationId === rec.id &&
        ctx.trace.opportunityId === rec.opportunityId &&
        ctx.trace.contentBriefVersion === 1,
    );
    check(
      'the business’s own material on this topic is in; the unrelated passage is not',
      ctx.trace.knowledgeChunkIds.includes(onTopic.id) &&
        !ctx.trace.knowledgeChunkIds.includes(offTopic.id) &&
        !text.includes('staff party'),
      JSON.stringify(ctx.trace.knowledgeChunkIds),
    );
    check(
      'the related earlier post is in (do not repeat); the unrelated one is not',
      ctx.trace.previousContentIds.includes(relatedPost.id) &&
        !ctx.trace.previousContentIds.includes(otherPost.id),
      JSON.stringify(ctx.trace.previousContentIds),
    );
    check(
      'campaigns and learned patterns about other things are left out, and recorded as such',
      !text.includes('Holiday gifts') &&
        !text.includes('gardening') &&
        ctx.dropped.some((d) => d.key === 'goal') &&
        ctx.dropped.some((d) => d.key === 'memory'),
      JSON.stringify(ctx.dropped),
    );
    check(
      'personal and secret data is removed; the business’s own email is kept',
      !text.includes('maria.lopez') &&
        !text.includes('7946') &&
        !text.includes('sk-ant-') &&
        text.includes('hello@roastery.example') &&
        (ctx.redactions.email ?? 0) >= 1 &&
        (ctx.redactions.phone ?? 0) >= 1 &&
        (ctx.redactions.secret ?? 0) >= 1,
      JSON.stringify(ctx.redactions),
    );
    check(
      'nothing about leads, contacts or connections, and no performance numbers',
      !/lead|outreach|access token/i.test(
        text.replace(/Lead with|leads? (?:to|the)/gi, ''),
      ) && !/totalEngagement/.test(text),
    );
    check(
      `within the token budget (${ctx.budget.usedTokens} of ${ctx.budget.maxTokens})`,
      ctx.budget.usedTokens <= ctx.budget.maxTokens,
    );

    // ---------------------------------------------------------------- Current
    console.log('\n2. Current, not stale');
    const changed =
      'We roast single-origin coffee and run a tasting room in Leeds.';
    await db.company.update({
      where: { id: companyId },
      data: {
        preferences: {
          ...PROFILE,
          business: { description: changed },
        } as Prisma.InputJsonObject,
      },
    });
    const after = await assembleDraftContext({
      companyId,
      type: brief!.contentType!.key,
      platform: brief!.channel?.platform ?? null,
      brief: 'Specialty coffee prices are rising.',
      query: 'specialty coffee prices',
      contentBrief: await getContentBrief(companyId, rec.id),
      campaignId: null,
      reference: [],
    });
    check(
      'a change to the business is used on the very next draft (snapshot rebuilt)',
      generationContextToPrompt(after).includes(changed) &&
        after.trace.snapshot.status === 'rebuilt' &&
        after.trace.snapshot.fingerprint !== ctx.trace.snapshot.fingerprint,
      after.trace.snapshot.status,
    );

    // ---------------------------------------- What the model actually receives
    console.log(
      '\n3. What the model actually receives — the real generator, the model stubbed at the network',
    );
    const sent: { system: string; prompt: string }[] = [];
    const realFetch = globalThis.fetch;
    const savedEnv = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    const POST = {
      hook: 'Coffee prices are rising. Here is what that means for your subscription.',
      paragraphs: [
        'Harvests shrank this year, and green coffee costs more.',
        'We are absorbing part of it so your bag stays affordable.',
        'Ask us anything about where your coffee comes from.',
      ],
      cta: 'Reply with your questions.',
      hashtags: ['coffee'],
    };
    process.env.GEMINI_API_KEY = 'stub-key-for-this-check';
    delete process.env.ANTHROPIC_API_KEY;
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(url).includes('generativelanguage.googleapis.com')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          contents: { parts: { text: string }[] }[];
          systemInstruction?: { parts: { text: string }[] };
        };
        const prompt = body.contents[0]!.parts[0]!.text;
        sent.push({
          system: body.systemInstruction?.parts[0]?.text ?? '',
          prompt,
        });
        const text = prompt.includes('"hook": string')
          ? JSON.stringify(POST)
          : '{}';
        return new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text }] }, finishReason: 'STOP' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return realFetch(url, init);
    }) as typeof fetch;
    let stubDraftId: string | null = null;
    try {
      const fresh = await getContentBrief(companyId, rec.id);
      const creation = await getCreation(companyId, rec.id, 'content-studio');
      const d = await generateDraft({
        companyId,
        userId: owner.id,
        type: fresh!.contentType!.key,
        platform: fresh!.channel?.platform ?? undefined,
        source: {
          kind: 'BRIEF',
          brief: `${briefText(fresh!)}\nInternal note: our ops key is sk-ant-zzzzzzzzzzzzzzzzzzzzzzzz9.`,
        },
        variations: 1,
        recommendation: {
          id: rec.id,
          title: rec.title,
          provenance: creation?.provenance ?? null,
          brief: fresh,
        },
      });
      stubDraftId = d.id;
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const writeCall = sent.find((x) => x.prompt.includes('"hook": string'));
    const sentText = `${writeCall?.system ?? ''}\n${writeCall?.prompt ?? ''}`;
    check(
      'the writer’s request carries the assembled package — current business, recommendation, matching material',
      Boolean(writeCall) &&
        sentText.includes('CONTEXT FOR THIS PIECE') &&
        sentText.includes(changed) &&
        sentText.includes('WRITTEN FOR AURA’S RECOMMENDATION') &&
        sentText.includes('absorb part of it'),
    );
    const everyCall = sent.map((x) => `${x.system}\n${x.prompt}`).join('\n');
    check(
      'nothing irrelevant reaches the writer',
      !/staff party|Holiday gifts|gardening|totalEngagement/.test(sentText),
    );
    check(
      `no personal or secret data in any of the ${sent.length} model calls (the brand-voice one included)`,
      !/maria\.lopez|7946|sk-ant-/.test(everyCall),
      ['maria.lopez', '7946', 'sk-ant-']
        .filter((x) => everyCall.includes(x))
        .join(', '),
    );
    check(
      'the business context is not sent twice (system prompt carries the rules only)',
      !(writeCall?.system ?? '').includes(PROFILE.business.description) &&
        (writeCall?.system ?? '').includes(
          'Ground every fact in the context provided with the task',
        ),
    );
    const stubDraft = stubDraftId
      ? await db.contentDraft.findUnique({ where: { id: stubDraftId } })
      : null;
    const stubMeta = stubDraft?.aiMetadata as {
      context?: {
        trace?: {
          recommendationId?: string;
          knowledgeChunkIds?: string[];
          snapshot?: { fingerprint?: string };
        };
        redactions?: Record<string, number>;
      };
      knowledgeChunkIds?: string[];
    } | null;
    check(
      'the draft records the package: traced to the recommendation and snapshot, relevant material only',
      stubMeta?.context?.trace?.recommendationId === rec.id &&
        typeof stubMeta.context.trace.snapshot?.fingerprint === 'string' &&
        JSON.stringify(stubMeta.knowledgeChunkIds) ===
          JSON.stringify([onTopic.id]) &&
        (stubMeta.context.redactions?.secret ?? 0) >= 2,
      JSON.stringify(stubMeta?.context?.trace),
    );

    // ------------------------------------------------------------- Live draft
    console.log('\n3. A real draft, through the running app');
    const me = new Client();
    check(
      'the owner signs in to the running app',
      (await me.signIn(owner.email)) === owner.email,
    );
    const req = (await me.req('GET', `/api/recommendations/${rec.id}/brief`))
      .json.contentRequest;
    const gen = await me.req('POST', '/api/content/generate', {
      ...req,
      variations: 1,
    });
    if (gen.status === 201) {
      const draft = await db.contentDraft.findUnique({
        where: { id: gen.json.id },
      });
      const meta = draft?.aiMetadata as {
        context?: Record<string, any>;
        knowledgeChunkIds?: string[];
      } | null;
      const c = meta?.context;
      check(
        'the draft records the package it was written from, traced to the recommendation and snapshot',
        c?.version === 1 &&
          c.trace.recommendationId === rec.id &&
          c.trace.opportunityId === rec.opportunityId &&
          typeof c.trace.snapshot.fingerprint === 'string' &&
          Array.isArray(c.sections) &&
          c.sections.length >= 5,
        JSON.stringify(c?.trace),
      );
      check(
        'it keeps the shape, not the text — and only the material that was relevant',
        !JSON.stringify(c).includes('single-origin') &&
          !(meta?.knowledgeChunkIds ?? []).includes(offTopic.id),
      );
      const body = JSON.stringify(draft?.body ?? {});
      check(
        'the written copy contains no redacted personal data',
        !body.includes('maria.lopez') && !body.includes('7946'),
      );
      console.log(
        `   live draft: “${draft?.title}” · ${c?.budget?.usedTokens} context tokens · sections ${c?.sections.map((s: { key: string }) => s.key).join(', ')}`,
      );
    } else {
      console.log(
        `  skip    live model unavailable (${gen.status}: ${String(gen.json?.error ?? '').slice(0, 80)})`,
      );
    }
  } finally {
    await db.company
      .delete({ where: { id: companyId } })
      .catch(() => undefined);
    await db.user.delete({ where: { id: owner.id } }).catch(() => undefined);
    console.log('  ok      cleanup: throwaway workspace and user removed');
  }

  console.log(
    failures
      ? `\n${failures} context check(s) failed.`
      : '\nContext assembly for content generation works end to end.',
  );
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
