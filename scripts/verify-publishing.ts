/**
 * Can Aura publish when it should, and — far more importantly — is it unable
 * to when it should not?
 *
 * Automatic publishing is the one thing in this product that can do something
 * irreversible in public. The checks below spend most of their effort on the
 * negative case, because a feature that publishes slightly late is a nuisance
 * and a feature that publishes when it was told not to is a disaster.
 *
 * Run: pnpm verify:publishing
 *
 * Nothing here publishes anything. It exercises the decision, not the network.
 */
import { db } from '@/lib/db';
import {
  readAutopilotSettings,
  canPublishAutomatically,
  MAX_AUTO_PUBLISH_PER_WEEK,
} from '@/server/briefing/autopilot.service';
import { recommendSlot, recommendSlots } from '@/server/publishing/schedule.service';

let failures = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ok      ${label}`);
  else {
    failures += 1;
    console.log(`  BROKEN  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const company = await db.company.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!company) {
    console.log('No company in the database — seed one first.');
    process.exit(1);
  }
  console.log(`\nWorkspace: ${company.name}\n`);

  const originalPreferences = company.preferences;
  const bag =
    originalPreferences && typeof originalPreferences === 'object' && !Array.isArray(originalPreferences)
      ? (originalPreferences as Record<string, unknown>)
      : {};

  const setMode = async (autopilot: Record<string, unknown>) => {
    // Deliberately loose: the point of these checks is what happens when the
    // stored value is NOT one of the valid modes.
    await db.company.update({
      where: { id: company.id },
      data: { preferences: { ...bag, autopilot } as unknown as never },
    });
    const fresh = await db.company.findUniqueOrThrow({
      where: { id: company.id },
      select: { preferences: true },
    });
    return readAutopilotSettings(fresh);
  };

  try {
    // ---- The default is the safe one --------------------------------------
    const cleared = await db.company.update({
      where: { id: company.id },
      data: { preferences: { ...bag, autopilot: {} } as never },
      select: { preferences: true },
    });
    const defaults = readAutopilotSettings(cleared);
    check('a workspace that has never chosen does not publish', defaults.publishMode === 'review');
    check('and is still allowed to write', defaults.enabled === true);

    // ---- Nothing but an explicit, valid choice unlocks publishing ----------
    for (const bad of ['publish', 'AUTO', 'yes', 1, true, null]) {
      const settings = await setMode({ publishMode: bad });
      const verdict = await canPublishAutomatically(company.id, settings);
      check(
        `a stored publishMode of ${JSON.stringify(bad)} cannot publish`,
        settings.publishMode === 'review' && !verdict.allowed,
      );
    }

    // ---- 'schedule' schedules but does not publish -------------------------
    const scheduleMode = await setMode({ publishMode: 'schedule' });
    const scheduleVerdict = await canPublishAutomatically(company.id, scheduleMode);
    check(
      'scheduling mode still requires a human to approve',
      scheduleMode.publishMode === 'schedule' && !scheduleVerdict.allowed,
    );
    check(
      'and says why, rather than failing silently',
      Boolean(scheduleVerdict.reason),
      scheduleVerdict.reason,
    );

    // ---- 'auto' needs somewhere to publish TO ------------------------------
    const autoMode = await setMode({ publishMode: 'auto' });
    const connections = await db.linkedInConnection.count({ where: { companyId: company.id } });
    const autoVerdict = await canPublishAutomatically(company.id, autoMode);
    if (connections === 0) {
      check(
        'auto mode with no connected channel refuses to publish',
        !autoVerdict.allowed,
      );
      check(
        'and explains that it scheduled for approval instead',
        Boolean(autoVerdict.reason?.includes('no channel is connected')),
        autoVerdict.reason,
      );
    } else {
      check('auto mode with a connected channel is allowed', autoVerdict.allowed);
    }
    check('the setting itself was stored as chosen', autoMode.publishMode === 'auto');

    // ---- The weekly ceiling is real ---------------------------------------
    const greedy = await setMode({ publishMode: 'auto', postsPerWeek: 99 });
    check(
      'posts per week is clamped no matter what is stored',
      greedy.postsPerWeek <= 5,
      `${greedy.postsPerWeek}`,
    );
    check('the auto-publish ceiling is small and finite', MAX_AUTO_PUBLISH_PER_WEEK <= 5);

    // ---- Recommending a time ----------------------------------------------
    const slot = await recommendSlot({ companyId: company.id, platform: 'LINKEDIN' });
    check('every recommended slot is in the future', slot.at.getTime() > Date.now());
    check('and carries a reason the user can check', slot.reason.length > 20, slot.reason);
    check(
      'a slot with no learned data admits it is a default',
      slot.confidence === 'learned' ||
        slot.reason.includes('not seen enough of your own results'),
      `${slot.confidence}: ${slot.reason}`,
    );

    const batch = await recommendSlots({ companyId: company.id, count: 3, platform: 'LINKEDIN' });
    check('a batch produces one slot per post', batch.length === 3);
    const times = batch.map((s) => s.at.getTime()).sort((a, b) => a - b);
    const tooClose = times.some((t, i) => i > 0 && t - times[i - 1]! < 20 * 3_600_000);
    check(
      'posts in a batch are spread out rather than stacked',
      !tooClose,
      batch.map((s) => s.at.toISOString()).join(', '),
    );
    check(
      'every slot in the batch is still in the future',
      batch.every((s) => s.at.getTime() > Date.now()),
    );

    console.log(`\n  Next recommended slot: ${slot.at.toUTCString()}`);
    console.log(`  Because: ${slot.reason}`);
  } finally {
    await db.company.update({
      where: { id: company.id },
      data: { preferences: originalPreferences as never },
    });
    console.log('\nRestored original settings.');
  }

  console.log(
    failures === 0
      ? '\nAll publishing checks passed.\n'
      : `\n${failures} check(s) BROKEN.\n`,
  );
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exit(1);
});
