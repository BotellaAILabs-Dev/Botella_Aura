import { describe, it, expect } from 'vitest';

import { NAV_ITEMS, NAV_SECTIONS, navBySection, findNavItem } from '@/lib/nav';

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
  it('groups items by what the user is trying to do', () => {
    const labels = NAV_SECTIONS.map((s) => s.label).filter(Boolean);
    // Verb-led groups ("Know your market") answer "where do I go for X" far
    // better than nouns ("Intelligence").
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(3);
    }
    expect(labels.length).toBeGreaterThanOrEqual(4);
  });

  it('puts every item in a real section', () => {
    const ids = new Set(NAV_SECTIONS.map((s) => s.id));
    for (const item of NAV_ITEMS) {
      expect(ids.has(item.section), `${item.label} has an unknown section`).toBe(true);
    }
  });

  it('leaves no section empty', () => {
    for (const section of navBySection()) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });

  it('keeps every route resolvable — renaming must not move a page', () => {
    // The rename changed labels only. If an href drifted, a link somewhere
    // else in the app is now broken.
    for (const item of NAV_ITEMS) {
      expect(findNavItem(item.href)).toBeDefined();
      expect(item.href.startsWith('/dashboard')).toBe(true);
    }
  });
});
