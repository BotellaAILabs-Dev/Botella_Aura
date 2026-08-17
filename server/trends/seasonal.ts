/**
 * Seasonal & event-based marketing moments — a curated, first-party dataset (no
 * API, no scraping). We surface the ones coming up soon so teams can plan
 * timely content. Dates are month/day; the year is resolved to "this year or
 * next" relative to now, so an event that already passed rolls to next year.
 *
 * `tags` let us lightly bias relevance toward a company's keywords/industry —
 * an event with no tags is broadly relevant to everyone (e.g. New Year).
 */
import type { SeasonalEvent } from '@/server/trends/types';

interface SeasonalDef {
  month: number; // 1-12
  day: number; // 1-31
  name: string;
  angle: string;
  tags: string[];
}

/** Curated moments. Kept intentionally broad + evergreen (not exhaustive). */
const CALENDAR: SeasonalDef[] = [
  { month: 1, day: 1, name: 'New Year', angle: 'Share your team’s focus or a “this year we’re…” post.', tags: [] },
  { month: 1, day: 4, name: 'World Braille Day / Accessibility focus', angle: 'Highlight how your product improves accessibility.', tags: ['accessibility', 'design', 'saas'] },
  { month: 2, day: 4, name: 'World Cancer Day', angle: 'If relevant, share support or a values-led message.', tags: ['health', 'nonprofit', 'biotech'] },
  { month: 2, day: 11, name: 'Women & Girls in Science Day', angle: 'Spotlight women on your team or in your field.', tags: ['tech', 'science', 'saas', 'education'] },
  { month: 2, day: 14, name: 'Valentine’s Day', angle: 'A light “why we love our customers” post.', tags: ['ecommerce', 'retail', 'b2c', 'commerce'] },
  { month: 3, day: 8, name: 'International Women’s Day', angle: 'Celebrate the women driving your work and industry.', tags: [] },
  { month: 3, day: 20, name: 'International Day of Happiness', angle: 'Share a customer win or a feel-good story.', tags: ['b2c', 'wellness', 'hr'] },
  { month: 4, day: 22, name: 'Earth Day', angle: 'Share a sustainability commitment or practice.', tags: ['sustainability', 'energy', 'retail', 'commerce'] },
  { month: 5, day: 1, name: 'Global Labour Day', angle: 'Recognize your team and how you support them.', tags: ['hr', 'saas'] },
  { month: 5, day: 4, name: 'World Password Day', angle: 'A quick security tip — great for security/SaaS brands.', tags: ['security', 'saas', 'fintech', 'tech'] },
  { month: 6, day: 5, name: 'World Environment Day', angle: 'Concrete steps you’re taking on the environment.', tags: ['sustainability', 'energy'] },
  { month: 6, day: 1, name: 'Pride Month begins', angle: 'A genuine inclusion message (only if you back it up).', tags: [] },
  { month: 7, day: 30, name: 'International Day of Friendship', angle: 'Thank a partner or community you work with.', tags: ['community', 'b2c'] },
  { month: 8, day: 19, name: 'World Photography Day', angle: 'Behind-the-scenes photos of your team/product.', tags: ['design', 'creative', 'b2c'] },
  { month: 9, day: 5, name: 'International Day of Charity', angle: 'Share a cause your company supports.', tags: ['nonprofit', 'community'] },
  { month: 9, day: 21, name: 'World Gratitude Day', angle: 'Thank your customers publicly.', tags: [] },
  { month: 10, day: 1, name: 'International Coffee Day', angle: 'A fun, human post — pairs with “coffee chat” CTAs.', tags: ['b2c', 'community', 'saas'] },
  { month: 10, day: 10, name: 'World Mental Health Day', angle: 'How you support wellbeing — customers or team.', tags: ['hr', 'health', 'wellness'] },
  { month: 11, day: 13, name: 'World Kindness Day', angle: 'A customer-appreciation or give-back post.', tags: [] },
  { month: 11, day: 28, name: 'Black Friday', angle: 'Your offer — or an honest “why we’re not discounting”.', tags: ['ecommerce', 'retail', 'b2c', 'commerce', 'saas'] },
  { month: 12, day: 1, name: 'Cyber Monday', angle: 'Digital-first offer or a year-end product highlight.', tags: ['ecommerce', 'saas', 'commerce', 'tech'] },
  { month: 12, day: 3, name: 'Giving Tuesday', angle: 'Announce a give-back or match for the season.', tags: ['nonprofit', 'community'] },
  { month: 12, day: 31, name: 'Year in Review', angle: 'A “our year in numbers” recap post.', tags: [] },
];

/** Local YYYY-MM-DD without pulling in a date library. */
function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Return upcoming seasonal moments within `withinDays`, most-imminent first.
 * When `keywords` are given, we prefer tag matches but always include the
 * broadly-relevant (untagged) moments so the list is never empty off-season.
 */
export function upcomingSeasonalEvents(
  now: Date,
  keywords: string[] = [],
  withinDays = 45,
  limit = 4,
): SeasonalEvent[] {
  const kw = keywords.map((k) => k.toLowerCase());
  const nowMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const resolved = CALENDAR.map((ev) => {
    // This year's occurrence; if already passed, roll to next year.
    let year = now.getUTCFullYear();
    let ms = Date.UTC(year, ev.month - 1, ev.day);
    if (ms < nowMs) {
      year += 1;
      ms = Date.UTC(year, ev.month - 1, ev.day);
    }
    const daysUntil = Math.round((ms - nowMs) / 86_400_000);
    const relevant =
      ev.tags.length === 0 ||
      ev.tags.some((t) => kw.some((k) => k.includes(t) || t.includes(k)));
    return {
      ev,
      daysUntil,
      date: isoDate(new Date(ms)),
      relevant,
    };
  })
    .filter((r) => r.daysUntil >= 0 && r.daysUntil <= withinDays && r.relevant)
    .sort((a, b) => a.daysUntil - b.daysUntil)
    .slice(0, limit);

  return resolved.map((r) => ({
    date: r.date,
    name: r.ev.name,
    daysUntil: r.daysUntil,
    angle: r.ev.angle,
  }));
}
