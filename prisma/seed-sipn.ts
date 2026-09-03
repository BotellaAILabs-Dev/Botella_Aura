/**
 * SIPN — the first real-world test case, seeded as two workspaces.
 *
 * SIPN sells to two completely different readers:
 *
 *   SIPN Bourbon      B2C. Bottles to drinkers. Social, app downloads,
 *                     bourbon content, engagement.
 *   SIPN Enterprises  B2B. Distributors, venues and retail partners. ROI,
 *                     partnerships, lead generation.
 *
 * They are two WORKSPACES, not one workspace with a toggle, and that is the
 * point of the exercise. Each needs its own knowledge base, brand voice,
 * audience, goals and results — averaging them would produce a voice that
 * serves neither reader. The workspace switcher in the topbar is how you move
 * between them, and `marketMode` on each is what makes Aura write differently
 * for each.
 *
 * Everything here is real configuration rather than fake output: profiles,
 * goals, brand colours and business materials. No pretend drafts, no invented
 * metrics — those should come from actually running Aura against this setup,
 * which is the whole reason to have a test case.
 *
 * Idempotent: re-running replaces both workspaces' seeded material in place.
 *
 * Run with:  pnpm seed:sipn
 */
import { PrismaClient, type MaterialCategory, type Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';

try {
  process.loadEnvFile();
} catch {
  // .env is optional — env vars may already be set in the shell / CI.
}

const prisma = new PrismaClient();

const OWNER_EMAIL = 'sipn@botella.ai';
const OWNER_PASSWORD = 'Password123';

interface WorkspaceSpec {
  slug: string;
  name: string;
  website: string;
  industry: string;
  brandVoiceNotes: string;
  marketMode: 'B2C' | 'B2B';
  audience: string;
  goals: string;
  channels: string[];
  colors: { primaryColor: string; secondaryColor: string; accentColor: string };
  materials: { filename: string; category: MaterialCategory; text: string }[];
}

const WORKSPACES: WorkspaceSpec[] = [
  {
    slug: 'sipn-bourbon',
    name: 'SIPN Bourbon',
    website: 'https://sipnbourbon.com',
    industry: 'Craft spirits (direct to consumer)',
    brandVoiceNotes:
      'Tone: Warm, unhurried, knowledgeable.\nWe talk about whiskey the way someone does across a bar, not the way a brochure does. We never say smooth, premium, or artisanal. We name the specifics — the mash bill, the barrel, the year — because the people who follow us actually care.',
    marketMode: 'B2C',
    audience:
      'People in their 30s and 40s who already drink bourbon and have opinions about it. They read the back label, they can tell you what a mash bill is, and they are tired of being sold "smooth" and "bold". They buy a bottle to open with someone, and they photograph the ones worth talking about.',
    goals:
      'Grow to 5,000 app downloads this quarter, and be the bottle people reach for when friends come over. Build a following that talks back rather than a follower count.',
    channels: ['Instagram', 'LinkedIn', 'Newsletter'],
    colors: { primaryColor: '#8c4a1f', secondaryColor: '#1c1917', accentColor: '#e0b877' },
    materials: [
      {
        filename: 'sipn-bourbon-brand-guidelines.txt',
        category: 'BRAND_GUIDELINES',
        text: [
          'SIPN Bourbon — voice and language',
          '',
          'How we sound: warm, unhurried, specific. Like someone who has spent a lot of time around whiskey and does not need to prove it.',
          '',
          'Words we never use: smooth, bold, premium, artisanal, hand-crafted, elevate, unlock, journey, experience like no other, notes of.',
          '',
          'Words we do use: the barrel, the mash bill, the pour, the char, the year, the distillery floor.',
          '',
          'We write to one person, never to "consumers" or "our audience". We never say "our product" — it is bourbon, or it is a bottle, or it is a pour.',
          '',
          'We never claim an age, an award, or a provenance we cannot point at. This is a regulated category; a wrong age statement is a legal problem, not a copy problem.',
          '',
          'Every post ends with one thing to do, asked the way a person would ask it. Never "click the link in bio to learn more today".',
        ].join('\n'),
      },
      {
        filename: 'sipn-bourbon-differentiators.txt',
        category: 'DIFFERENTIATORS',
        text: [
          'What makes SIPN Bourbon different',
          '',
          'Single-barrel, never blended to a house profile. Every batch tastes like the barrel it came from, and we print the barrel number on the label so you can tell the difference between two bottles.',
          '',
          'We publish the mash bill. Most brands in our price range will not tell you what is in the bottle. Ours is 70% corn, 21% rye, 9% malted barley, and it says so on the back.',
          '',
          'The app scans the barrel number and shows you that specific barrel: when it was filled, which rickhouse floor it sat on, and what the distiller wrote about it at bottling. Nobody else at this price connects a bottle in your hand to its own history.',
          '',
          'No age statement games. If it is four years old we say four years, not "aged to perfection".',
        ].join('\n'),
      },
      {
        filename: 'sipn-bourbon-icp.txt',
        category: 'AUDIENCE_ICP',
        text: [
          'Who drinks SIPN',
          '',
          'The person we write for is 32-48, has been drinking bourbon long enough to have a shelf rather than a bottle, and has strong opinions about at least one brand they used to like.',
          '',
          'They already know what a mash bill is. Explaining it insults them; naming ours respects them.',
          '',
          'They are sceptical of marketing language in this category specifically, because the category has been dishonest about age and provenance for decades.',
          '',
          'They buy a bottle for an occasion with someone else in the room. Bourbon is social; almost nothing is bought to drink alone.',
          '',
          'What makes them post: the barrel number and the story behind that specific barrel. What makes them scroll past: anything that sounds like it was written by a brand.',
        ].join('\n'),
      },
      {
        filename: 'sipn-bourbon-app-overview.txt',
        category: 'PRODUCT_DOCS',
        text: [
          'SIPN app — what it does',
          '',
          'Scan the barrel number on any SIPN bottle and the app shows that barrel: fill date, rickhouse and floor, entry proof, bottling proof, and the distiller’s own note from the day it was bottled.',
          '',
          'Your shelf: every barrel you have opened, kept in order, with room for your own note on each.',
          '',
          'Restock: tells you which shops within range currently have SIPN in stock, updated from distributor data weekly.',
          '',
          'Free, no account needed to scan. An account is only needed to keep a shelf across devices.',
        ].join('\n'),
      },
    ],
  },
  {
    slug: 'sipn-enterprises',
    name: 'SIPN Enterprises',
    website: 'https://sipnenterprises.com',
    industry: 'Beverage distribution & wholesale partnerships',
    brandVoiceNotes:
      'Tone: Direct, commercial, evidence-led.\nWe are talking to people who buy inventory for a living. Lead with the number. Margin, turn rate, and what a shelf slot returns. No romance about the liquid unless it moves product.',
    marketMode: 'B2B',
    audience:
      'Beverage buyers and category managers at regional distributors, plus bar and restaurant groups running 5-40 venues. They are measured on margin per shelf slot and inventory turn, not on what they personally like drinking. They have been burned by craft brands that could not supply consistently.',
    goals:
      'Sign 12 new regional distribution partners this year, and get SIPN onto the back bar at 200 venues. Shorten the time from first conversation to first order.',
    channels: ['LinkedIn', 'Newsletter'],
    colors: { primaryColor: '#1e3a5f', secondaryColor: '#0f172a', accentColor: '#c8a34a' },
    materials: [
      {
        filename: 'sipn-enterprises-partner-deck.txt',
        category: 'PITCH_DECK',
        text: [
          'SIPN Enterprises — partner overview',
          '',
          'The ask: one shelf slot, or one back-bar position.',
          '',
          'Margin: SIPN carries a 38% retail margin at our recommended price, against a category average of 29% in the same price band.',
          '',
          'Turn: in our first 40 accounts, SIPN turned 2.4x per quarter against a craft-bourbon shelf average of 1.6x. The barrel-number app is why — customers come back for a different barrel, not the same bottle.',
          '',
          'Supply: we hold 14 months of finished inventory before we open a new territory. The most common reason a craft brand loses a slot is that it could not supply for a quarter. We do not open a market we cannot keep stocked.',
          '',
          'Support: co-op marketing budget per account, staff training, and shelf-talker artwork with the barrel-scan call to action.',
          '',
          'Terms: net 30, no minimum reorder, freight paid above 12 cases.',
        ].join('\n'),
      },
      {
        filename: 'sipn-enterprises-differentiators.txt',
        category: 'DIFFERENTIATORS',
        text: [
          'Why a distributor takes SIPN over another craft bourbon',
          '',
          'The app closes the loop that every other craft brand leaves open. A scan is tied to a barrel, and a barrel is tied to a shipment, so we can tell a buyer which of their accounts actually moved product rather than guessing from sell-in.',
          '',
          'We do not open a territory we cannot supply. 14 months of finished inventory held before launch, which is the single most common failure in this category.',
          '',
          '38% retail margin against a 29% category average in the same price band.',
          '',
          '2.4x quarterly turn across our first 40 accounts, against a 1.6x shelf average for craft bourbon.',
          '',
          'Co-op marketing is per account and paid quarterly, not a rebate held against volume targets that most accounts never hit.',
        ].join('\n'),
      },
      {
        filename: 'sipn-enterprises-icp.txt',
        category: 'AUDIENCE_ICP',
        text: [
          'Who we sell to',
          '',
          'Regional beverage distributors, 50-400 people, covering one to three states. The decision sits with a category manager or beverage buyer.',
          '',
          'Bar and restaurant groups running 5-40 venues, where one beverage director decides the back bar for all of them.',
          '',
          'What they are measured on: margin per shelf slot, inventory turn, and dead stock. Not on brand affinity.',
          '',
          'What they have been burned by: craft brands that ran out of supply mid-quarter, and co-op marketing promises tied to volume targets that were never reachable.',
          '',
          'What ends a conversation fast: no proof of sell-through, and no answer on supply continuity.',
        ].join('\n'),
      },
      {
        filename: 'sipn-enterprises-competitor-notes.txt',
        category: 'COMPETITOR_INTEL',
        text: [
          'Competitive landscape — for our positioning only, never to be repeated as our claims',
          '',
          'Most craft bourbon brands in our price band compete on story and label design. They cannot show sell-through, so a buyer is being asked to take shelf risk on taste alone.',
          '',
          'The large houses compete on supply certainty and co-op spend. We cannot outspend them and should not try; we win where a buyer wants a differentiated slot that still supplies reliably.',
          '',
          'Two regional competitors have had publicised supply failures in the last 18 months, which is why supply continuity is now the second question every buyer asks.',
          '',
          'Nobody in our band offers barrel-level sell-through data. That is the gap we are in.',
        ].join('\n'),
      },
    ],
  },
];

/** Mirrors server/knowledge/chunk.ts so seeded material chunks identically. */
const TARGET_CHARS = 3200;
const MIN_CHUNK_CHARS = 80;

function chunkText(input: string): string[] {
  const normalized = input.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim().length >= MIN_CHUNK_CHARS) chunks.push(current.trim());
    current = '';
  };
  for (const para of paragraphs) {
    if (current.length + para.length + 2 > TARGET_CHARS) flush();
    current += (current ? '\n\n' : '') + para;
  }
  flush();
  return chunks;
}

async function main() {
  const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 10);
  const user = await prisma.user.upsert({
    where: { email: OWNER_EMAIL },
    update: {},
    create: {
      email: OWNER_EMAIL,
      name: 'SIPN Team',
      passwordHash,
      emailVerified: new Date(),
    },
  });

  for (const spec of WORKSPACES) {
    const company = await prisma.company.upsert({
      where: { slug: spec.slug },
      update: {
        name: spec.name,
        website: spec.website,
        industry: spec.industry,
        brandVoiceNotes: spec.brandVoiceNotes,
      },
      create: {
        slug: spec.slug,
        name: spec.name,
        website: spec.website,
        industry: spec.industry,
        brandVoiceNotes: spec.brandVoiceNotes,
        onboardedAt: new Date(),
      },
    });

    await prisma.companyMember.upsert({
      where: { userId_companyId: { userId: user.id, companyId: company.id } },
      update: { role: 'OWNER' },
      create: { userId: user.id, companyId: company.id, role: 'OWNER' },
    });

    // Merge into preferences rather than replacing: autopilot settings and
    // anything a later feature adds live in the same bag.
    const existing =
      company.preferences && typeof company.preferences === 'object' && !Array.isArray(company.preferences)
        ? (company.preferences as Record<string, unknown>)
        : {};
    await prisma.company.update({
      where: { id: company.id },
      data: {
        preferences: {
          ...existing,
          marketingProfile: {
            marketMode: spec.marketMode,
            audience: spec.audience,
            goals: spec.goals,
            channels: spec.channels,
          },
          brand: spec.colors,
        } as Prisma.InputJsonObject,
      },
    });

    // Rebuild this workspace's seeded material so re-running is idempotent.
    const filenames = spec.materials.map((m) => m.filename);
    await prisma.knowledgeChunk.deleteMany({
      where: { companyId: company.id, sourceUrl: { in: filenames } },
    });

    const rows: Prisma.KnowledgeChunkCreateManyInput[] = [];
    for (const material of spec.materials) {
      for (const content of chunkText(material.text)) {
        rows.push({
          companyId: company.id,
          sourceType: 'UPLOAD',
          sourceUrl: material.filename,
          category: material.category,
          title: material.filename,
          content,
          tokenCount: Math.ceil(content.length / 4),
        });
      }
    }
    if (rows.length) await prisma.knowledgeChunk.createMany({ data: rows });

    console.log(
      `  ${spec.name.padEnd(18)} ${spec.marketMode}  ${spec.materials.length} documents, ${rows.length} chunks`,
    );
  }

  console.log(
    [
      '',
      'SIPN is set up as two workspaces. Sign in and switch between them in the topbar:',
      `  email     ${OWNER_EMAIL}`,
      `  password  ${OWNER_PASSWORD}`,
      '',
      'The same brief written in each will read completely differently — that is the test.',
      '',
    ].join('\n'),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
