/**
 * Seed script — creates a demo user + company so the dashboard isn't empty on
 * first run. Idempotent: safe to run multiple times (upserts by unique keys).
 *
 *   Demo login →  email: demo@botella.ai   password: Password123
 *
 * Run with: pnpm db:seed
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// `tsx prisma/seed.ts` does not auto-load .env the way the Prisma CLI does, so
// load it here to keep `pnpm db:seed` working standalone from a clean clone.
// process.loadEnvFile is built into Node >= 20.12 (zero dependencies).
try {
  process.loadEnvFile();
} catch {
  // .env is optional — env vars may already be set in the shell / CI.
}

const prisma = new PrismaClient();

const DEMO_EMAIL = 'demo@botella.ai';
const DEMO_PASSWORD = 'Password123';
const DEMO_COMPANY_SLUG = 'botella-demo';

async function main() {
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
      onboardedAt: new Date(),
    },
  });

  await prisma.companyMember.upsert({
    where: { userId_companyId: { userId: user.id, companyId: company.id } },
    update: {},
    create: { userId: user.id, companyId: company.id, role: 'OWNER' },
  });

  // A couple of audit entries so the trail isn't empty either.
  await prisma.auditLog.create({
    data: {
      action: 'USER_SIGNED_UP',
      userId: user.id,
      metadata: { method: 'seed' },
    },
  });
  await prisma.auditLog.create({
    data: {
      action: 'COMPANY_CREATED',
      userId: user.id,
      companyId: company.id,
      metadata: { seeded: true },
    },
  });

  // eslint-disable-next-line no-console
  console.info('✅ Seed complete.');
  // eslint-disable-next-line no-console
  console.info(`   Login → ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
