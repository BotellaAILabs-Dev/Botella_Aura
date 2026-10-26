import { describe, it, expect } from 'vitest';

import {
  NAV_ITEMS,
  NAV_GROUPS,
  navByGroup,
  groupForPath,
  findNavItem,
} from '@/lib/nav';

/**
 * Navigation has to be readable by a marketer, not by the team that built it.
 *
 * Labels were product names — "Marketing Memory", "AI Trend Insights",
 * "Connectors". Those describe machinery. Someone scanning a sidebar is asking
 * "which of these gets me what I need right now", and a name that only makes
 * sense once you already know the feature cannot answer that.
 *
 * These are guardrails against drift, not style policing: every rule below
 * describes something that actively confused a reader.
 */

/** Words that describe the machine rather than the user's outcome. */
const JARGON = [
  'memory',
  'connector',
  'engine',
  'module',
  'pipeline',
  'orchestrat',
  'intelligence layer',
];

describe('nav labels', () => {
  it('names nothing after its internal machinery', () => {
    for (const item of NAV_ITEMS) {
      const label = item.label.toLowerCase();
      for (const word of JARGON) {
        expect(
          label.includes(word),
          `"${item.label}" reads as product jargon ("${word}")`,
        ).toBe(false);
      }
    }
  });

  it('does not lead with the technology', () => {
    // "AI Trend Insights" sold the implementation. What the user wants is to
    // know what their market is talking about; that it uses AI is our problem.
    for (const item of NAV_ITEMS) {
      expect(item.label.startsWith('AI ')).toBe(false);
    }
  });

  it('keeps labels short enough to scan', () => {
    for (const item of NAV_ITEMS) {
      expect(item.label.length, `"${item.label}" is too long for a sidebar`).toBeLessThanOrEqual(20);
    }
  });

  it('has no two labels that read as the same thing', () => {
    // "Marketing Intelligence", "Marketing Advisor" and "Marketing Planner"
    // were three different features whose names a user could not tell apart.
    const labels = NAV_ITEMS.map((i) => i.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);

    const startingWithMarketing = labels.filter((l) => l.startsWith('marketing'));
    expect(startingWithMarketing.length).toBeLessThanOrEqual(1);
  });
});

describe('nav descriptions', () => {
  it('explains every feature page, so nothing is unexplained on hover', () => {
    // Home and Settings are self-evident; everything else needs a line.
    const needsDescription = NAV_ITEMS.filter(
      (i) => i.href !== '/dashboard' && i.href !== '/dashboard/settings',
    );
    for (const item of needsDescription) {
      expect(item.description, `${item.label} has no description`).toBeTruthy();
    }
  });

  it('describes an outcome for the user, not a mechanism', () => {
    for (const item of NAV_ITEMS) {
      if (!item.description) continue;
      expect(
        /\byou\b|\byour\b/i.test(item.description),
        `"${item.label}" describes the system rather than the user`,
      ).toBe(true);
    }
  });

  it('keeps descriptions to a single readable line', () => {
    for (const item of NAV_ITEMS) {
      if (!item.description) continue;
      expect(item.description.length).toBeLessThanOrEqual(100);
    }
  });
});

describe('nav structure', () => {
  it('shows a handful of groups, not a directory of every page', () => {
    // The review asked for "approximately four or five tabs". Six, with Setup
    // as the last of them, is that. If this ever creeps back toward twenty,
    // the sidebar has become a directory again.
    expect(NAV_GROUPS.length).toBeLessThanOrEqual(6);
    expect(NAV_GROUPS.length).toBeGreaterThanOrEqual(4);
  });

  it('names groups for what the user is trying to do', () => {
    for (const group of NAV_GROUPS) {
      expect(group.label.length).toBeGreaterThan(3);
      // Short enough to scan in a sidebar.
      expect(group.label.length).toBeLessThanOrEqual(16);
      expect(group.description.length).toBeGreaterThan(10);
    }
  });

  it('puts every page in a real group', () => {
    const ids = new Set(NAV_GROUPS.map((g) => g.id));
    for (const item of NAV_ITEMS) {
      expect(ids.has(item.group), `${item.label} has an unknown group`).toBe(true);
    }
  });

  it('leaves no group empty', () => {
    for (const group of navByGroup()) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it('sends every group somewhere that exists', () => {
    // A group header that lands on a page with no nav entry is a dead end.
    const hrefs = new Set(NAV_ITEMS.map((i) => i.href));
    for (const group of NAV_GROUPS) {
      expect(hrefs.has(group.href), `${group.label} points nowhere`).toBe(true);
    }
  });

  it('keeps no more than a readable handful of pages in any one group', () => {
    // "Too much information on individual pages" applies to the sidebar too:
    // a group of nine is the old flat list with a lid on it.
    for (const group of navByGroup()) {
      expect(
        group.items.length,
        `${group.label} has ${group.items.length} pages`,
      ).toBeLessThanOrEqual(5);
    }
  });

  it('keeps every route resolvable — regrouping must not move a page', () => {
    // Grouping changed the sidebar only. If an href drifted, a link somewhere
    // else in the app is now broken.
    for (const item of NAV_ITEMS) {
      expect(findNavItem(item.href)).toBeDefined();
      expect(item.href.startsWith('/dashboard')).toBe(true);
    }
  });

  it('has one nav entry per page', () => {
    // Campaigns and Campaign ideas were two entries into overlapping work.
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('no longer competes with itself over campaigns', () => {
    // The page still exists at /dashboard/advisor — it is reached from
    // Campaigns, rather than sitting beside it in the sidebar.
    expect(NAV_ITEMS.some((i) => i.href === '/dashboard/advisor')).toBe(false);
    expect(NAV_ITEMS.some((i) => i.href === '/dashboard/campaigns')).toBe(true);
  });
});

describe('which group a page belongs to', () => {
  it('opens the group of the page you are on', () => {
    expect(groupForPath('/dashboard')).toBe('home');
    expect(groupForPath('/dashboard/suggestions')).toBe('home');
    expect(groupForPath('/dashboard/trends')).toBe('market');
    expect(groupForPath('/dashboard/content')).toBe('create');
    expect(groupForPath('/dashboard/leads')).toBe('customers');
    expect(groupForPath('/dashboard/analytics')).toBe('results');
    expect(groupForPath('/dashboard/settings')).toBe('setup');
  });

  it('does not put everything in Home just because /dashboard is a prefix', () => {
    // The bug a startsWith scan in declaration order would produce: every
    // route begins with /dashboard, so Home would always win and the sidebar
    // would never open the group the user is in.
    for (const item of NAV_ITEMS) {
      if (item.href === '/dashboard') continue;
      expect(groupForPath(item.href)).toBe(item.group);
    }
  });

  it('keeps a sub-route in its parent page’s group', () => {
    expect(groupForPath('/dashboard/content/new')).toBe('create');
    expect(groupForPath('/dashboard/suggestions/history')).toBe('home');
    expect(groupForPath('/dashboard/settings/trends')).toBe('setup');
  });

  it('does not match a page whose href is merely a string prefix of another', () => {
    // /dashboard/content must not claim /dashboard/contentfoo.
    expect(groupForPath('/dashboard/contentfoo')).not.toBe('create');
  });

  it('falls back to a group rather than throwing on an unknown page', () => {
    expect(NAV_GROUPS.some((g) => g.id === groupForPath('/dashboard/nowhere'))).toBe(
      true,
    );
  });
});
