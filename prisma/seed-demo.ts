/**
 * Demo data seed — populates the demo workspace with a full, CONNECTED sample
 * story so the product never looks empty in a demo:
 *
 *   Trend digest → Campaign → Content (every status) → Leads (+ signals) →
 *   Outreach (every status) → Performance snapshots → Marketing Memory.
 *
 * Everything is clearly labelled "Sample" (titles, names, an audit marker) so a
 * viewer can never confuse it with real activity. It is scoped ONLY to the demo
 * company (slug `botella-demo`) — real and newly-created workspaces are never
 * touched and stay genuinely empty (honest empty states).
 *
 * Idempotent: it wipes the demo company's prior sample records and rebuilds them,
 * so you can re-run it any time.
 *
 * Run with:  pnpm db:seed:demo   (runs the base `pnpm db:seed` first)
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

try {
  process.loadEnvFile();
} catch {
  // .env is optional — env vars may already be set in the shell / CI.
}

const prisma = new PrismaClient();

const DEMO_EMAIL = 'demo@botella.ai';
const DEMO_PASSWORD = 'Password123';
const DEMO_COMPANY_SLUG = 'botella-demo';

/** Deterministic relative dates (no Math.random / no "today" surprises in tests). */
const now = new Date();
function daysAgo(n: number): Date {
  return new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
}
function daysFromNow(n: number): Date {
  return new Date(now.getTime() + n * 24 * 60 * 60 * 1000);
}
/** Midnight UTC for the given day offset — matches the digest idempotency key. */
function dayUtc(n: number): Date {
  const d = daysAgo(n);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function ensureCompany() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: {
      email: DEMO_EMAIL,
      name: 'Demo Founder',
      passwordHash,
      role: 'OWNER',
      emailVerified: new Date(),
    },
  });

  const company = await prisma.company.upsert({
    where: { slug: DEMO_COMPANY_SLUG },
    update: {},
    create: {
      name: 'Botella Demo Co.',
      slug: DEMO_COMPANY_SLUG,
      website: 'https://botella.ai',
      industry: 'B2B SaaS',
      brandVoiceNotes:
        'Confident but warm. Practical, no hype. Speak to busy founders and ' +
        'marketers. Prefer concrete examples over buzzwords. Never overpromise.',
      preferences: { tone: 'professional-friendly', emojiUsage: 'minimal' },
      onboardedAt: daysAgo(30),
    },
  });

  await prisma.companyMember.upsert({
    where: { userId_companyId: { userId: user.id, companyId: company.id } },
    update: {},
    create: { userId: user.id, companyId: company.id, role: 'OWNER' },
  });

  return { user, company };
}

/** Remove prior sample records for the demo company only, in FK-safe order. */
async function wipeDemo(companyId: string) {
  await prisma.performanceSnapshot.deleteMany({ where: { companyId } });
  await prisma.outreachMessage.deleteMany({ where: { companyId } });
  await prisma.lead.deleteMany({ where: { companyId } }); // cascades signals
  await prisma.contentDraft.deleteMany({ where: { companyId } });
  await prisma.campaignTask.deleteMany({ where: { companyId } });
  await prisma.campaign.deleteMany({ where: { companyId } });
  await prisma.trendDigest.deleteMany({ where: { companyId } });
  await prisma.marketingMemory.deleteMany({ where: { companyId } });
  await prisma.knowledgeChunk.deleteMany({ where: { companyId } });
  await prisma.knowledgeSource.deleteMany({ where: { companyId } });
  await prisma.competitorProfile.deleteMany({ where: { companyId } }); // cascades snapshots
  await prisma.discoveryProfile.deleteMany({ where: { companyId } }); // cascades runs
}

async function main() {
  const { user, company } = await ensureCompany();
  const companyId = company.id;
  await wipeDemo(companyId);

  // --- Trend Intelligence config + a fresh digest -------------------------
  await prisma.companyTrendConfig.upsert({
    where: { companyId },
    update: {},
    create: {
      companyId,
      keywords: [
        'B2B SaaS marketing',
        'product-led growth',
        'marketing automation',
        'AI copilots',
      ],
      subreddits: ['SaaS', 'marketing', 'startups'],
      competitorNames: ['HubSpot', 'Jasper'],
      geoCountry: 'US',
      defaultsSeeded: true,
    },
  });

  await prisma.trendDigest.create({
    data: {
      companyId,
      date: dayUtc(0),
      payload: {
        generatedAt: daysAgo(0).toISOString(),
        model: 'claude-opus-4-8',
        sources: { news: 6, hackernews: 3, reddit: 4 },
        items: [
          {
            id: 'sample-trend-1',
            title: 'Sample: Buyers now expect AI copilots inside every SaaS tool',
            source: 'Google News',
            url: 'https://example.com/ai-copilots-saas',
            score: 92,
            aiSummary:
              'Coverage this week shows B2B buyers increasingly treat an embedded AI assistant as table stakes, not a differentiator.',
            suggestedAngle:
              'Publish a founder POV on how you decide what to automate vs. keep human — your approval-gate stance is a natural hook.',
          },
          {
            id: 'sample-trend-2',
            title: 'Sample: Product-led growth teams shift budget to retention content',
            source: 'Hacker News',
            url: 'https://example.com/plg-retention',
            score: 84,
            aiSummary:
              'Several threads report PLG teams moving spend from top-of-funnel to activation and retention content.',
            suggestedAngle:
              'Share one concrete onboarding-email teardown with the before/after metric.',
          },
          {
            id: 'sample-trend-3',
            title: 'Sample: Marketers ask how to prove ROI on AI-written content',
            source: 'Reddit r/marketing',
            url: 'https://example.com/ai-content-roi',
            score: 78,
            aiSummary:
              'Recurring question: how to attribute pipeline to AI-assisted content without over-claiming.',
            suggestedAngle:
              'Offer a simple, honest measurement framework — lead with what NOT to measure.',
          },
        ],
      },
    },
  });

  // --- Knowledge base (grounding) ----------------------------------------
  const source = await prisma.knowledgeSource.create({
    data: {
      companyId,
      type: 'WEBSITE',
      url: 'https://botella.ai',
      label: 'Sample: Company website',
      status: 'SYNCED',
      lastSyncedAt: daysAgo(5),
    },
  });
  await prisma.knowledgeChunk.createMany({
    data: [
      {
        companyId,
        sourceType: 'WEBSITE',
        sourceUrl: 'https://botella.ai',
        title: 'Sample: What we do',
        content:
          'Botella is an AI marketing co-pilot for B2B SaaS teams. It drafts on-brand content, finds qualified leads, and prepares outreach — always behind a human approval step.',
        tokenCount: 48,
      },
      {
        companyId,
        sourceType: 'WEBSITE',
        sourceUrl: 'https://botella.ai/principles',
        title: 'Sample: Our principles',
        content:
          'Nothing is published or sent without an explicit human approval. We use official APIs only and never fabricate metrics.',
        tokenCount: 32,
      },
    ],
  });
  void source;

  // --- Campaign -----------------------------------------------------------
  const campaign = await prisma.campaign.create({
    data: {
      companyId,
      name: 'Sample: Q3 Thought-Leadership Launch',
      goal: 'Build founder authority in B2B SaaS marketing and generate 15 qualified conversations.',
      status: 'ACTIVE',
      startDate: daysAgo(10),
      endDate: daysFromNow(20),
      durationDays: 30,
      modulesIncluded: {
        content: true,
        outreach: true,
        engagement: true,
        discovery: true,
      },
      targetAudience: 'Heads of Marketing and founders at seed–Series B B2B SaaS companies.',
      themes: ['AI copilots', 'product-led growth', 'honest measurement'],
      plan: {
        summary:
          'A 30-day plan mixing 2 posts/week with a weekly outreach batch to newly-discovered leads.',
        days: [
          { day: 1, module: 'content', topic: 'Why we put a human approval gate on everything' },
          { day: 3, module: 'outreach', topic: 'Connect with Heads of Marketing from this week’s leads' },
          { day: 7, module: 'content', topic: 'Onboarding-email teardown (before/after)' },
        ],
      },
    },
  });

  // --- Content drafts (every status), tied to the campaign ---------------
  function post(hook: string, paragraphs: string[], hashtags: string[]) {
    return { hook, paragraphs, hashtags };
  }

  const contentSpec = [
    {
      title: 'Sample: The human approval gate is a feature, not a delay',
      status: 'PUBLISHED' as const,
      publishedAt: daysAgo(6),
      publishedUrl: 'https://www.linkedin.com/feed/update/sample-published',
      body: post(
        'We built our AI to stop before it acts. On purpose.',
        [
          'Every draft Botella writes waits for a human to approve it. No auto-posting, no auto-sending.',
          'Founders told us the scary part of AI marketing isn’t bad copy — it’s losing control of the brand.',
          'So the approval gate is the product. Speed with a seatbelt beats speed off a cliff.',
        ],
        ['#B2BSaaS', '#AIMarketing', '#PLG'],
      ),
    },
    {
      title: 'Sample: An onboarding email teardown (before → after)',
      status: 'PENDING_APPROVAL' as const,
      body: post(
        'We rewrote one onboarding email and activation jumped 11%. Here’s the diff.',
        [
          'Before: a feature list nobody read. After: one job-to-be-done and one button.',
          'The lesson wasn’t "write less". It was "write for the next action".',
          'Full teardown with the exact copy in the comments.',
        ],
        ['#ProductLedGrowth', '#Onboarding', '#Retention'],
      ),
    },
    {
      title: 'Sample: How to measure AI-assisted content without lying to yourself',
      status: 'PENDING_APPROVAL' as const,
      body: post(
        'Most "AI content ROI" dashboards are fiction. A simpler, honest way:',
        [
          'Don’t attribute pipeline to a single post. Do track reply rate and saved-time.',
          'Measure the funnel you can defend in front of your CFO.',
          'Honest small numbers beat impressive fake ones.',
        ],
        ['#MarketingAnalytics', '#AItools'],
      ),
    },
    {
      title: 'Sample: Draft — 3 signals a lead is actually in-market',
      status: 'DRAFT' as const,
      body: post(
        'Not every lead is ready. Three public signals that they might be:',
        [
          'They just raised. They’re hiring for the pain you solve. Their tech blog went quiet then loud.',
          'Each one is public and checkable — no scraping required.',
          'We turn these into a one-line "why now" on every lead.',
        ],
        ['#Sales', '#Prospecting'],
      ),
    },
    {
      title: 'Sample: Approved & scheduled — the co-pilot mindset',
      status: 'APPROVED' as const,
      scheduledFor: daysFromNow(2),
      body: post(
        'Autopilot flies the plane. A co-pilot hands you the controls at the right moment.',
        [
          'We’re deliberately a co-pilot: Aura does the 80% of prep work, you make the calls.',
          'That’s why every action ends in an Approve button, not an outbox.',
          'Marketing you’re proud of still has your fingerprints on it.',
        ],
        ['#AICopilot', '#B2BMarketing'],
      ),
    },
  ];

  const drafts = [];
  for (const spec of contentSpec) {
    const draft = await prisma.contentDraft.create({
      data: {
        companyId,
        createdById: user.id,
        campaignId: campaign.id,
        type: 'LINKEDIN_POST',
        status: spec.status,
        title: spec.title,
        body: spec.body,
        aiMetadata: {
          demo: true,
          model: 'claude-opus-4-8',
          brandVoiceApplied: true,
          source: { kind: 'TREND', ref: 'sample-trend-1' },
        },
        scheduledFor: 'scheduledFor' in spec ? spec.scheduledFor : null,
        publishedAt: 'publishedAt' in spec ? spec.publishedAt : null,
        publishedUrl: 'publishedUrl' in spec ? spec.publishedUrl : null,
        createdAt: daysAgo(8),
      },
    });
    drafts.push(draft);
  }

  // Real (manually-entered) performance numbers on the published post.
  const publishedDraft = drafts.find((d) => d.status === 'PUBLISHED');
  if (publishedDraft) {
    await prisma.performanceSnapshot.create({
      data: {
        companyId,
        contentDraftId: publishedDraft.id,
        source: 'MANUAL',
        metrics: { impressions: 4210, likes: 118, comments: 27, reposts: 9, clicks: 63 },
        capturedAt: daysAgo(2),
      },
    });
  }

  // --- Discovery profile (so leads have a believable origin) --------------
  const discoveryProfile = await prisma.discoveryProfile.create({
    data: {
      companyId,
      name: 'Sample: Heads of Marketing at seed–Series B SaaS',
      criteria: {
        industry: 'B2B SaaS',
        stage: ['seed', 'series-a', 'series-b'],
        roleTitles: ['Head of Marketing', 'VP Marketing', 'Founder'],
        geography: 'United States',
        keywords: ['product-led growth', 'demand gen'],
      },
      isActive: true,
      autoRun: true,
      lastRunAt: daysAgo(3),
    },
  });
  const discoveryRun = await prisma.discoveryRun.create({
    data: {
      companyId,
      discoveryProfileId: discoveryProfile.id,
      status: 'COMPLETED',
      leadsFound: 4,
      leadsCreated: 4,
      summary: {
        sources: { jobs: 2, news: 1, github: 1 },
        skipped: { crunchbase: 'no API key configured' },
      },
      startedAt: daysAgo(3),
      finishedAt: daysAgo(3),
    },
  });
  void discoveryRun;

  // --- Leads (+ signals) --------------------------------------------------
  const leadSpecs = [
    {
      name: 'Jordan Rivera',
      title: 'Head of Marketing',
      companyName: 'NorthLoop (Sample)',
      status: 'QUALIFIED' as const,
      fitScore: 91,
      fitRationale:
        'Seed-stage B2B SaaS, just posted two demand-gen roles, and the founder writes about PLG — strong fit for a founder-to-founder connect.',
      signals: [
        { signalType: 'HIRING' as const, description: 'Sample: Hiring a Demand Gen Manager and a Content Lead this month.' },
        { signalType: 'FUNDING' as const, description: 'Sample: Announced a $4M seed round three weeks ago.' },
      ],
    },
    {
      name: 'Priya Anand',
      title: 'VP Marketing',
      companyName: 'Cadence Labs (Sample)',
      status: 'CONTACTED' as const,
      fitScore: 84,
      fitRationale:
        'Series A, product-led, actively publishing about retention — matches our thought-leadership angle.',
      signals: [
        { signalType: 'NEWS' as const, description: 'Sample: Featured in a PLG roundup last week.' },
      ],
    },
    {
      name: null,
      title: null,
      companyName: 'Brightpath Analytics (Sample)',
      status: 'NEW' as const,
      fitScore: 72,
      fitRationale:
        'Company-only lead: strong signal (hiring a Head of Marketing) but no named contact confirmed yet.',
      signals: [
        { signalType: 'HIRING' as const, description: 'Sample: Open role — Head of Marketing (first marketing hire).' },
      ],
    },
    {
      name: 'Marcus Lee',
      title: 'Founder & CEO',
      companyName: 'Tally (Sample)',
      status: 'NEW' as const,
      fitScore: 66,
      fitRationale:
        'Early but promising: GitHub activity spiked and they mention "growth" in recent commits.',
      signals: [
        { signalType: 'GITHUB_ACTIVITY' as const, description: 'Sample: Public repo activity up 3x in the last 30 days.' },
      ],
    },
  ];

  const leads = [];
  for (const spec of leadSpecs) {
    const lead = await prisma.lead.create({
      data: {
        companyId,
        name: spec.name,
        title: spec.title,
        companyName: spec.companyName,
        status: spec.status,
        source: 'DISCOVERY_ENGINE',
        discoveryProfileId: discoveryProfile.id,
        fitScore: spec.fitScore,
        fitRationale: spec.fitRationale,
        linkedInProfileUrl: spec.name
          ? `https://www.linkedin.com/in/sample-${spec.name.toLowerCase().replace(/\s+/g, '-')}`
          : null,
        createdAt: daysAgo(3),
        signals: {
          create: spec.signals.map((s) => ({
            signalType: s.signalType,
            description: s.description,
            detectedAt: daysAgo(4),
          })),
        },
      },
    });
    leads.push(lead);
  }

  // --- Outreach messages (every status), tied to leads --------------------
  // lead[0] Jordan: an approved connection note + a drafted follow-up.
  // lead[1] Priya: a SENT connection note (accepted + replied) — feeds Memory.
  // lead[2] Brightpath: a pending-approval connection note.
  const outreachSpecs = [
    {
      leadIdx: 0,
      type: 'CONNECTION_NOTE' as const,
      status: 'APPROVED' as const,
      draftText:
        'Hi Jordan — loved your take on PLG. We help seed-stage teams turn trends into approved-in-your-voice content. Worth a quick hello?',
    },
    {
      leadIdx: 0,
      type: 'FOLLOWUP' as const,
      status: 'DRAFT' as const,
      draftText:
        'Thanks for connecting, Jordan! If useful, I can share the onboarding-email teardown that lifted activation 11%.',
    },
    {
      leadIdx: 1,
      type: 'CONNECTION_NOTE' as const,
      status: 'SENT' as const,
      sentAt: daysAgo(2),
      connectionAccepted: true,
      replyReceived: true,
      draftText:
        'Hi Priya — your retention-content thread was great. We’re building in the same space and I’d value comparing notes.',
    },
    {
      leadIdx: 2,
      type: 'CONNECTION_NOTE' as const,
      status: 'PENDING_APPROVAL' as const,
      draftText:
        'Hi there — saw you’re making your first marketing hire at Brightpath. Happy to share a lightweight content playbook that helps early teams.',
    },
  ];

  const messages = [];
  for (const spec of outreachSpecs) {
    const lead = leads[spec.leadIdx];
    if (!lead) continue;
    const msg = await prisma.outreachMessage.create({
      data: {
        companyId,
        leadId: lead.id,
        type: spec.type,
        status: spec.status,
        draftText: spec.draftText,
        aiMetadata: { demo: true, model: 'claude-opus-4-8', brandVoiceApplied: true },
        sentAt: 'sentAt' in spec ? spec.sentAt : null,
        connectionAccepted: 'connectionAccepted' in spec ? spec.connectionAccepted : false,
        replyReceived: 'replyReceived' in spec ? spec.replyReceived : false,
        createdAt: daysAgo(3),
      },
    });
    messages.push(msg);
  }

  // --- Marketing Memory (learned from the real sample outcomes) -----------
  await prisma.marketingMemory.createMany({
    data: [
      {
        companyId,
        insightType: 'CONTENT_FORMAT',
        insight:
          'Sample: Posts that open with a contrarian one-liner outperform list posts on saves and comments.',
        confidence: 'MEDIUM',
        sampleSize: 4,
        supportingDataSummary: {
          basis: 'Engagement on 4 published sample posts',
          metric: 'comments + saves',
        },
      },
      {
        companyId,
        insightType: 'OUTREACH_APPROACH',
        insight:
          'Sample: Connection notes that reference a specific recent post get replies more often than generic intros.',
        confidence: 'LOW',
        sampleSize: 1,
        supportingDataSummary: {
          basis: '1 sent sample connection note that was accepted + replied',
          metric: 'reply rate',
        },
      },
    ],
  });

  // --- Competitor tracking ------------------------------------------------
  await prisma.competitorProfile.create({
    data: {
      companyId,
      name: 'Sample Rival Inc.',
      url: 'https://example.com',
      pricingUrl: 'https://example.com/pricing',
      notes: 'Sample competitor for the demo — watch pricing + launches.',
      trackingEnabled: true,
      snapshots: {
        create: {
          homepageText: 'Sample homepage text captured for change detection.',
          changesSummary: {
            hasChanges: true,
            homepage: 'Sample: Added an "AI Assistant" section to the homepage.',
            news: [],
            model: 'claude-opus-4-8',
          },
          capturedAt: daysAgo(1),
        },
      },
    },
  });

  // --- Audit markers ------------------------------------------------------
  await prisma.auditLog.create({
    data: {
      action: 'CAMPAIGN_CREATED',
      userId: user.id,
      companyId,
      metadata: { demo: true, campaign: campaign.name },
    },
  });

  const counts = {
    contentDrafts: drafts.length,
    leads: leads.length,
    outreach: messages.length,
  };
  // eslint-disable-next-line no-console
  console.info('✅ Demo data seeded for', DEMO_COMPANY_SLUG, counts);
  // eslint-disable-next-line no-console
  console.info(`   Login → ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('❌ Demo seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
