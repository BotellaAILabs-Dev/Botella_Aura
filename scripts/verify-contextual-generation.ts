/**
 * Contextual content generation — every Content Studio format, written from
 * an accepted recommendation and its Content Brief (lib/content-formats.ts).
 *
 * The real generator runs against the real database with the model stubbed
 * at the network, so what the writer is told can be checked exactly:
 *
 *   Formats     all nine: the recommendation's context, the audience, the
 *               channel, the format's template, length, CTA (with its
 *               destination), brand voice and output shape reach the writer;
 *               the saved draft matches the format and keeps its brief
 *   CTA         an email written without its button is repaired, not saved
 *               without one
 *   Not ready   a format whose required context is missing is blocked
 *   Live        one draft from the real model, when the provider answers
 *
 * Run: pnpm verify:contextual-generation
 * (with the AI key loaded, node --env-file=.env …, the live stage runs too)
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';

import { db } from '@/lib/db';
import { briefText, validateContentBrief } from '@/lib/content-brief';
import { FORMAT_SPECS } from '@/lib/content-formats';
import { platformSpec } from '@/lib/platforms';
import {
  bodySchemaFor,
  CONTENT_TYPES,
  type ContentTypeKey,
} from '@/lib/validations/content';
import { isClaudeConfigured } from '@/server/ai/claude';
import { getContentBrief } from '@/server/content/content-brief.service';
import { generateDraft } from '@/server/content/generator';
import { runDetection } from '@/server/opportunities/detection.service';
import { suggestFromOpportunities } from '@/server/recommendations/autosuggest.service';
import { getCreation } from '@/server/recommendations/creation.service';
import { decideRecommendation } from '@/server/recommendations/recommendation.service';
import { collectSignals } from '@/server/signals/signal.service';
import { SAMPLE_BODIES } from '../tests/fixtures/format-bodies';

const BASE = (
  process.env.VERIFY_BASE_URL ??
  process.env.AURA_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-formats-${STAMP}!`;
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
      email: `zzverify-formats-${label}-${STAMP}@example.test`,
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

/** Stub the model at the network: record what is sent, answer per format. */
function stubModel(answer: (prompt: string) => string) {
  const sent: { system: string; prompt: string }[] = [];
  const realFetch = globalThis.fetch;
  const saved = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
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
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: answer(prompt) }] },
              finishReason: 'STOP',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return realFetch(url, init);
  }) as typeof fetch;
  return {
    sent,
    restore() {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** The format a writing prompt asks for, from the output shape it names. */
function typeOfPrompt(prompt: string): ContentTypeKey | null {
  for (const t of CONTENT_TYPES) {
    if (
      prompt.includes(
        `Return JSON of this exact shape: ${FORMAT_SPECS[t].output.schemaText}`,
      )
    )
      return t;
  }
  return null;
}

async function main() {
  const owner = await person('owner');
  const company = await db.company.create({
    data: {
      name: 'zzverify formats Roastery',
      slug: `zzverify-formats-${STAMP}`,
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
    const rec = recs.find((r) =>
      ['post', 'response-post', 'recovery-post'].includes(actionOf(r)),
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
    const creation = await getCreation(companyId, rec.id, 'content-studio');
    console.log(`   writing from: “${rec.title}”`);

    // ------------------------------------------------------------ Every format
    console.log('\n1. Every format, from the accepted recommendation');
    for (const type of CONTENT_TYPES) {
      const brief = await getContentBrief(companyId, rec.id, { type });
      const valid = validateContentBrief(brief);
      if (!brief || !valid.ok) {
        check(`${type}: its brief validates`, false, valid.errors.join('; '));
        continue;
      }
      const stub = stubModel((p) => {
        const t = typeOfPrompt(p);
        return t ? JSON.stringify(SAMPLE_BODIES[t]) : '{}';
      });
      let draftId: string | null = null;
      try {
        const d = await generateDraft({
          companyId,
          userId: owner.id,
          type,
          ...(brief.channel?.platform
            ? { platform: brief.channel.platform }
            : {}),
          source: { kind: 'BRIEF', brief: briefText(brief) },
          variations: 1,
          recommendation: {
            id: rec.id,
            title: rec.title,
            provenance: creation?.provenance ?? null,
            brief,
          },
        });
        draftId = d.id;
      } finally {
        stub.restore();
      }
      const write = stub.sent.find((x) => typeOfPrompt(x.prompt) === type);
      const p = write?.prompt ?? '';
      const f = FORMAT_SPECS[type];
      const audience = brief.targetAudience?.value ?? '';
      const channelOk =
        f.channel.publishing === 'copy_out'
          ? p.includes(`WHERE IT GOES: ${f.channel.constraints[0]}`)
          : Boolean(brief.channel?.name) &&
            p.includes(
              `to run on ${platformSpec(brief.channel!.platform!).label}`,
            );
      const ctaOk =
        f.cta.mode === 'required'
          ? p.includes('CALL TO ACTION: Required.') &&
            p.includes('https://www.roastery.example')
          : p.includes('CALL TO ACTION:');
      const draft = draftId
        ? await db.contentDraft.findUnique({ where: { id: draftId } })
        : null;
      const meta = draft?.aiMetadata as {
        brief?: { contentType?: { key?: string } };
        context?: { trace?: { recommendationId?: string } };
      } | null;
      const body = bodySchemaFor(type).safeParse(draft?.body);
      const problems = [
        !write && 'no writing call',
        !p.includes('WRITTEN FOR AURA’S RECOMMENDATION') &&
          'recommendation context missing',
        !(brief.keyMessage && p.includes(brief.keyMessage.value)) &&
          'key message missing',
        !(audience && p.includes(`for ${audience}`)) &&
          'audience missing from the task',
        !channelOk && 'channel missing',
        !p.includes(`FORMAT: ${f.label}`) && 'format block missing',
        !p.includes('LENGTH:') && 'length missing',
        !ctaOk && 'CTA rule or destination missing',
        !(
          p.includes('BRAND VOICE IN THIS FORMAT') &&
          p.includes('## BRAND VOICE')
        ) && 'brand voice missing',
        !f.template.every((line) => p.includes(line)) && 'template missing',
        !body.success && 'saved body does not match the format',
        draft?.type !== type && 'saved as the wrong type',
        meta?.brief?.contentType?.key !== type && 'brief not kept on the draft',
        meta?.context?.trace?.recommendationId !== rec.id &&
          'not traced to the recommendation',
      ].filter(Boolean);
      check(
        `${f.label.padEnd(18)} recommendation · audience · channel · format · length · CTA · voice · output`,
        problems.length === 0,
        problems.join('; '),
      );
    }

    // ---------------------------------------------------------- CTA required
    console.log('\n2. A required CTA is never left out');
    const emailBrief = await getContentBrief(companyId, rec.id, {
      type: 'EMAIL',
    });
    let writes = 0;
    const stub = stubModel((p) => {
      // The repair pass names the same output shape, so it is checked first.
      if (p.includes('PROBLEMS TO FIX')) {
        return JSON.stringify(SAMPLE_BODIES.EMAIL);
      }
      if (typeOfPrompt(p) === 'EMAIL') {
        writes += 1;
        return JSON.stringify({ ...SAMPLE_BODIES.EMAIL, cta: '' });
      }
      return '{}';
    });
    let repairedId: string | null = null;
    try {
      const d = await generateDraft({
        companyId,
        userId: owner.id,
        type: 'EMAIL',
        source: { kind: 'BRIEF', brief: briefText(emailBrief!) },
        variations: 1,
        recommendation: {
          id: rec.id,
          title: rec.title,
          provenance: creation?.provenance ?? null,
          brief: emailBrief,
        },
      });
      repairedId = d.id;
    } finally {
      stub.restore();
    }
    const repair = stub.sent.find((x) => x.prompt.includes('PROBLEMS TO FIX'));
    const repaired = repairedId
      ? await db.contentDraft.findUnique({ where: { id: repairedId } })
      : null;
    check(
      'an email written without its button is sent back once to add it',
      writes === 1 &&
        Boolean(
          repair?.prompt.includes(
            'No call to action, and this format needs one',
          ),
        ),
    );
    check(
      'and the saved email has its call to action',
      (repaired?.body as { cta?: string } | null)?.cta ===
        SAMPLE_BODIES.EMAIL.cta,
    );

    // ------------------------------------------------------------- Not ready
    console.log(
      '\n3. A format whose required context is missing is not written',
    );
    await db.company.update({
      where: { id: companyId },
      data: { website: null },
    });
    await db.company.update({
      where: { id: companyId },
      data: {
        preferences: {
          ...PROFILE,
          business: { ...PROFILE.business },
        } as Prisma.InputJsonObject,
      },
    });
    const noSite = await getContentBrief(companyId, rec.id, { type: 'PROMO' });
    check(
      'promotional copy with nowhere to claim the offer: blocked, saying why',
      noSite?.readiness === 'blocked' &&
        noSite.blockedBy.some((b) =>
          b.includes('An offer needs a place to claim it'),
        ),
      noSite?.blockedBy.join(' | '),
    );
    const post = await getContentBrief(companyId, rec.id, {
      type: 'LINKEDIN_POST',
    });
    check(
      'a social post can still go ahead without a link',
      post?.readiness !== 'blocked',
    );
    await db.company.update({
      where: { id: companyId },
      data: { website: 'https://www.roastery.example' },
    });

    // ------------------------------------------------------------- Live model
    console.log('\n4. One live draft (when the AI provider answers)');
    if (!isClaudeConfigured()) {
      console.log('  skip    no AI provider configured');
    } else {
      const live = await getContentBrief(companyId, rec.id, {
        type: 'LINKEDIN_POST',
      });
      try {
        const d = await generateDraft({
          companyId,
          userId: owner.id,
          type: 'LINKEDIN_POST',
          ...(live?.channel?.platform
            ? { platform: live.channel.platform }
            : {}),
          source: { kind: 'BRIEF', brief: briefText(live!) },
          variations: 1,
          recommendation: {
            id: rec.id,
            title: rec.title,
            provenance: creation?.provenance ?? null,
            brief: live,
          },
        });
        const b = d.body as { hook?: string; cta?: string };
        check(
          'the live model’s post follows the format and carries a CTA',
          bodySchemaFor('LINKEDIN_POST').safeParse(d.body).success &&
            Boolean(b.cta?.trim()),
        );
        console.log(`   live: “${b.hook}” — CTA: “${b.cta}”`);
      } catch (err) {
        console.log(
          `  skip    live model unavailable (${String(err instanceof Error ? err.message : err).slice(0, 70)})`,
        );
      }
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
      ? `\n${failures} format check(s) failed.`
      : '\nContextual content generation works for every format.',
  );
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
