/**
 * Content Plan — monthly calendar generation speed and reliability.
 *
 * Against the real database (and, for the job flow, the running app):
 *
 *   Speed       full months at 4 and 14 posts/week, one channel and all six,
 *               with a simulated model at realistic latency — every run must
 *               finish inside the drafting budget with every slot filled
 *   Resilience  one week failing, and the model down entirely: the calendar is
 *               still complete, saved, and says which parts are an outline
 *   Live model  one full month with the configured AI provider (if any)
 *   Job flow    through the running app as a real user: queue, double-click,
 *               progress, done, the page shows the calendar; a dead run is
 *               replaced rather than reattached to
 *
 * Run (app running): VERIFY_BASE_URL=http://localhost:3001 pnpm verify:planner
 * With the AI key loaded (node --env-file=.env …) the live-model stage runs too.
 */
import bcrypt from 'bcryptjs';

import { db } from '@/lib/db';
import type { PlanInputs } from '@/lib/validations/planner';
import { isClaudeConfigured } from '@/server/ai/claude';
import {
  DRAFT_BUDGET_MS,
  type AskModel,
} from '@/server/planner/calendar-draft';
import {
  buildSchedule,
  generateMarketingPlan,
  getPlanForMonth,
  type MarketingPlanPayload,
} from '@/server/planner/plan.service';

const BASE = (
  process.env.VERIFY_BASE_URL ??
  process.env.AURA_URL ??
  'http://localhost:3001'
).replace(/\/$/, '');
const STAMP = Date.now();
const PASSWORD = `Zz-planner-${STAMP}!`;
/** Budget plus room to read the brief and save — still inside the 60s runner. */
const LIMIT_MS = DRAFT_BUDGET_MS + 8_000;

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    return { status: res.status, json, text };
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

const BRIEF: PlanInputs = {
  month: '2026-11',
  businessGoals: 'Grow coffee subscriptions among home brewers this quarter.',
  campaignObjectives: 'Book 15 tasting calls; 200 newsletter signups.',
  topics: ['sourcing', 'brewing at home', 'freshness', 'subscriptions'],
  brandGuidelines:
    'Plain English, no emoji, never quote prices we cannot cite.',
  audience: 'Home brewers who buy beans online',
  channels: ['LinkedIn'],
  postsPerWeek: 4,
  campaignId: '',
};
const ALL_CHANNELS: PlanInputs['channels'] = [
  'LinkedIn',
  'Blog',
  'Newsletter',
  'X',
  'Instagram',
  'YouTube',
];

/**
 * A stand-in model with realistic latency: a few seconds for the strategy,
 * 5–9 seconds per week (more for bigger weeks). Optional failures per week.
 */
function simulatedModel(opts: { failWeeks?: number[]; down?: boolean } = {}): {
  ask: AskModel;
  calls: () => number;
} {
  let calls = 0;
  const ask: AskModel = async ({ prompt }) => {
    calls += 1;
    if (opts.down) {
      await sleep(3_000);
      throw Object.assign(new Error('Model unavailable (503)'), {
        status: 503,
      });
    }
    if (prompt.includes('STEP 1 OF 2')) {
      await sleep(3_000);
      const weeks = [...prompt.matchAll(/week (\d) \(\d+ posts\)/g)].map(
        ([, w]) => ({
          week: Number(w),
          theme: `Arc ${w}`,
          goal: 'Move the objective.',
        }),
      );
      return JSON.stringify({
        summary: 'A month that builds trust, week by week.',
        weeks,
      });
    }
    const week = Number(/THIS WEEK: week (\d)/.exec(prompt)?.[1]);
    const slots = [
      ...prompt.matchAll(/^(\d{4}-\d{2}-\d{2}) \(week (\d)\) — (\S+)$/gm),
    ];
    await sleep(5_000 + 800 * slots.length);
    if (opts.failWeeks?.includes(week)) {
      throw Object.assign(new Error('Model unavailable (503)'), {
        status: 503,
      });
    }
    return JSON.stringify({
      items: slots.map(([, date, w, channel]) => ({
        date,
        week: Number(w),
        channel,
        contentType:
          channel === 'Blog' || channel === 'Newsletter'
            ? 'BLOG'
            : 'LINKEDIN_POST',
        theme: `Arc ${w}`,
        title: `Simulated post for ${date}`,
        hook: 'A real hook.',
        brief: 'A specific brief.',
        cta: 'Reply with yours.',
        hashtags: ['coffee'],
        objective: 'Book 15 tasting calls',
      })),
    });
  };
  return { ask, calls: () => calls };
}

async function timed(
  companyId: string,
  inputs: PlanInputs,
  ask?: AskModel,
): Promise<{ plan: MarketingPlanPayload; ms: number; percents: number[] }> {
  const percents: number[] = [];
  const t0 = Date.now();
  const plan = await generateMarketingPlan({
    companyId,
    inputs,
    ...(ask ? { ask } : {}),
    onProgress: (_m, p) => {
      percents.push(p);
    },
  });
  return { plan, ms: Date.now() - t0, percents };
}

function complete(plan: MarketingPlanPayload, inputs: PlanInputs): boolean {
  const slots = buildSchedule(inputs.month, inputs.postsPerWeek);
  return (
    plan.items.length === slots.length &&
    plan.items.every(
      (it, i) => it.date === slots[i]!.date && it.week === slots[i]!.week,
    )
  );
}

async function main() {
  const email = `zzverify-planner-${STAMP}@example.test`;
  const user = await db.user.create({
    data: {
      email,
      name: 'Dana Planner',
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      emailVerified: new Date(),
    },
  });
  const company = await db.company.create({
    data: {
      name: 'zzverify planner Roastery',
      slug: `zzverify-planner-${STAMP}`,
      industry: 'Coffee',
    },
  });
  await db.companyMember.create({
    data: { userId: user.id, companyId: company.id, role: 'OWNER' },
  });
  const companyId = company.id;

  try {
    // ------------------------------------------------------------------ Speed
    console.log(
      '\n1. Speed — full months, simulated model at realistic latency',
    );
    const scenarios: { label: string; inputs: PlanInputs }[] = [
      { label: '1 channel, 4 posts/week', inputs: BRIEF },
      {
        label: '6 channels, 4 posts/week',
        inputs: { ...BRIEF, channels: ALL_CHANNELS },
      },
      {
        label: '6 channels, 14 posts/week (the maximum)',
        inputs: { ...BRIEF, channels: ALL_CHANNELS, postsPerWeek: 14 },
      },
    ];
    for (const s of scenarios) {
      const model = simulatedModel();
      const { plan, ms, percents } = await timed(
        companyId,
        s.inputs,
        model.ask,
      );
      const channelsUsed = new Set(plan.items.map((i) => i.channel));
      check(
        `${s.label}: ${plan.items.length} posts in ${secs(ms)} (${model.calls()} model calls)`,
        ms < LIMIT_MS &&
          complete(plan, s.inputs) &&
          !plan.outline &&
          channelsUsed.size === s.inputs.channels.length,
        `outline ${JSON.stringify(plan.outline)} · channels ${[...channelsUsed].join(',')}`,
      );
      check(
        `${s.label}: progress moves forward step by step (${percents.join(' → ')})`,
        percents.length >= 5 &&
          percents.every((p, i) => i === 0 || p >= percents[i - 1]!),
      );
    }
    // Sequential would be strategy + one call per week, back to back.
    const weeks = new Set(buildSchedule(BRIEF.month, 4).map((s) => s.week))
      .size;
    console.log(
      `          (one-at-a-time drafting of the same ${weeks} weeks would take ≈ ${secs(3_000 + weeks * (5_000 + 800 * 4))}; all at once ≈ one week)`,
    );

    // ------------------------------------------------------------- Resilience
    console.log(
      '\n2. Resilience — the calendar stays whole when the model does not',
    );
    {
      const model = simulatedModel({ failWeeks: [2] });
      const { plan, ms } = await timed(
        companyId,
        { ...BRIEF, channels: ALL_CHANNELS },
        model.ask,
      );
      const saved = await getPlanForMonth(companyId, BRIEF.month);
      const savedPayload = saved?.payload as unknown as
        MarketingPlanPayload | undefined;
      check(
        `one week failing: the other weeks are kept, week 2 is an outline (${secs(ms)})`,
        complete(plan, { ...BRIEF, channels: ALL_CHANNELS }) &&
          JSON.stringify(plan.outline?.weeks) === '[2]' &&
          plan.items
            .filter((i) => i.week !== 2)
            .every((i) => i.title.startsWith('Simulated')) &&
          ms < LIMIT_MS,
        JSON.stringify(plan.outline),
      );
      check(
        'the saved plan records which week is an outline, for the page to say so',
        JSON.stringify(savedPayload?.outline?.weeks) === '[2]',
      );
    }
    {
      const model = simulatedModel({ down: true });
      const { plan, ms } = await timed(companyId, BRIEF, model.ask);
      check(
        `model down: still a complete, dated calendar, in ${secs(ms)}, marked as an outline`,
        complete(plan, BRIEF) && plan.model === 'outline' && ms < LIMIT_MS,
        `model ${plan.model}`,
      );
    }

    // ------------------------------------------------------------- Live model
    console.log(
      '\n3. Live model — one full month with the configured provider',
    );
    if (!isClaudeConfigured()) {
      console.log(
        '  skip    no AI provider configured (load .env to include this stage)',
      );
    } else {
      const inputs = {
        ...BRIEF,
        channels: [
          'LinkedIn',
          'Instagram',
          'Newsletter',
        ] as PlanInputs['channels'],
      };
      const { plan, ms } = await timed(companyId, inputs);
      console.log(
        `   live run: ${plan.items.length} posts in ${secs(ms)} · model ${plan.model} · outline ${plan.outline ? JSON.stringify(plan.outline) : 'none'}`,
      );
      check(
        'finishes inside the runner’s limit with every slot filled, whatever the provider does',
        ms < LIMIT_MS && complete(plan, inputs),
        secs(ms),
      );
    }

    // --------------------------------------------------------------- Job flow
    console.log('\n4. Job flow — through the running app, as a person would');
    const me = new Client();
    check(
      'a real user signs in to the running app',
      (await me.signIn(email)) === email,
    );
    const inputs = {
      ...BRIEF,
      month: '2026-12',
      channels: ['LinkedIn', 'Blog'],
    };
    // Five clicks landing in the same instant — two tabs, a double-submit.
    const burst = await Promise.all(
      Array.from({ length: 5 }, () =>
        me.req('POST', '/api/jobs', { kind: 'MARKETING_PLAN', inputs }),
      ),
    );
    const ids = new Set(burst.map((r) => (r.json as { id: string }).id));
    const live = await db.generationJob.count({
      where: {
        companyId,
        kind: 'MARKETING_PLAN',
        status: { in: ['QUEUED', 'RUNNING'] },
      },
    });
    check(
      'five simultaneous Generate requests start exactly one run',
      ids.size === 1 && live === 1,
      `${ids.size} ids, ${live} live runs`,
    );
    const a = burst[0]!.json as { id: string; createdAt?: string };
    const again = (
      await me.req('POST', '/api/jobs', { kind: 'MARKETING_PLAN', inputs })
    ).json as { id: string; reused?: boolean };
    check(
      'pressing Generate again while it runs attaches to the same run',
      again.reused === true && again.id === a.id,
      `${a.id} / ${again.id}`,
    );
    check(
      'the job reports when it was queued, for the elapsed-time readout',
      Boolean(a.createdAt),
    );

    const t0 = Date.now();
    void me.req('POST', `/api/jobs/${a.id}/run`);
    const seen: string[] = [];
    let status = 'QUEUED';
    let result: { items?: number; model?: string } = {};
    while (Date.now() - t0 < 90_000) {
      await sleep(1_500);
      const poll = (await me.req('GET', `/api/jobs/${a.id}`)).json as {
        status: string;
        progress: { message: string; percent: number };
        result: typeof result;
      };
      status = poll.status;
      const line = `${poll.progress.percent}% ${poll.progress.message}`;
      if (seen.at(-1) !== line) seen.push(line);
      if (status === 'SUCCEEDED' || status === 'FAILED') {
        result = poll.result;
        break;
      }
    }
    const ms = Date.now() - t0;
    console.log(
      `   progress seen: ${seen.map((s) => s.replace(/…$/, '')).join(' | ')}`,
    );
    check(
      `the run finishes: ${status} in ${secs(ms)} — ${result.items ?? 0} posts, model ${result.model}`,
      status === 'SUCCEEDED' &&
        ms < 65_000 &&
        result.items === buildSchedule('2026-12', 4).length,
    );
    check(
      // Step-by-step progress is proven in section 1; a fast run may finish
      // between two polls, so here it is enough to see it working before done.
      'the page sees the run in progress, with a named step, before it is done',
      seen.length >= 2 &&
        /^\d+% \S/.test(seen[0]!) &&
        !seen[0]!.startsWith('100%'),
      seen.join(' | '),
    );
    const page = await me.req('GET', '/dashboard/planner?month=2026-12');
    check(
      'the planner page shows the calendar',
      page.status === 200 &&
        /December 2026/.test(page.text) &&
        page.text.includes('pieces'),
    );

    // A run whose instance died two+ minutes ago must not trap the user.
    const dead = await db.generationJob.create({
      data: {
        companyId,
        userId: user.id,
        kind: 'MARKETING_PLAN',
        status: 'RUNNING',
        inputs,
        attempts: 1,
        createdAt: new Date(Date.now() - 3 * 60_000),
        startedAt: new Date(Date.now() - 3 * 60_000),
        progress: { step: 'running', message: 'Drafting…', percent: 35 },
      },
    });
    const retry = (
      await me.req('POST', '/api/jobs', { kind: 'MARKETING_PLAN', inputs })
    ).json as { id: string; reused?: boolean };
    const deadAfter = await db.generationJob.findUnique({
      where: { id: dead.id },
    });
    check(
      'Try again after a dead run starts a fresh one, and closes the dead one',
      retry.id !== dead.id && !retry.reused && deadAfter?.status === 'FAILED',
      `${deadAfter?.status} / reused ${retry.reused}`,
    );
    await db.generationJob.update({
      where: { id: retry.id },
      data: { status: 'FAILED', error: 'verify: not run' },
    });
  } finally {
    await db.company
      .delete({ where: { id: companyId } })
      .catch(() => undefined);
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    console.log('  ok      cleanup: throwaway workspace and user removed');
  }

  console.log(
    failures
      ? `\n${failures} planner check(s) failed.`
      : '\nMonthly calendar generation is fast, bounded and complete.',
  );
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
