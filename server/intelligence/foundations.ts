import { db } from '@/lib/db';

import type { ScoreBlock } from '@/server/intelligence/types';

/**
 * Setup foundations — the one thing that is always measurable.
 *
 * Every other scorer needs activity that a brand-new workspace has not had
 * time to produce, so a first-run dashboard reported "Not measured" across the
 * board and the headline score was null. That is technically honest and
 * practically useless: the user is told nothing and given nine equally-weighted
 * dead cards.
 *
 * Setup completeness is knowable the moment onboarding ends. Scoring it means
 * the dashboard always opens with a real number, a real basis, and — because
 * each incomplete step carries its own next action — one obvious thing to do
 * next rather than a wall of blanks.
 */
export interface FoundationStep {
  key: string;
  label: string;
  /** Points toward the foundations score. */
  weight: number;
  done: boolean;
  /** Shown when the step is outstanding. */
  action: string;
  href: string;
}

export interface FoundationsResult {
  block: ScoreBlock;
  steps: FoundationStep[];
  /** The highest-value incomplete step, or null when setup is complete. */
  nextStep: FoundationStep | null;
}

/** Enough competitors that comparison means something (client asked for 2–3). */
const COMPETITOR_TARGET = 3;

export async function analyseFoundations(
  companyId: string,
): Promise<FoundationsResult> {
  const [company, knowledgeSources, competitors, discoveryProfiles, drafts, connections] =
    await Promise.all([
      db.company.findUnique({
        where: { id: companyId },
        select: {
          website: true,
          industry: true,
          brandVoiceProfile: true,
          brandVoiceNotes: true,
        },
      }),
      db.knowledgeSource.count({ where: { companyId, status: 'SYNCED' } }),
      db.competitorProfile.count({ where: { companyId } }),
      db.discoveryProfile.count({ where: { companyId } }),
      db.contentDraft.count({ where: { companyId } }),
      db.connection.count({ where: { companyId, status: 'CONNECTED' } }),
    ]);

  const steps: FoundationStep[] = [
    {
      key: 'website',
      label: 'Company website set',
      weight: 10,
      done: Boolean(company?.website),
      action: 'Add your website so Aura can learn how you already talk.',
      href: '/dashboard/settings',
    },
    {
      key: 'industry',
      label: 'Industry set',
      weight: 5,
      done: Boolean(company?.industry),
      action: 'Set your industry — it focuses trends, leads and competitors.',
      href: '/dashboard/settings',
    },
    {
      key: 'brandVoice',
      label: 'Brand voice profile',
      weight: 20,
      done: Boolean(company?.brandVoiceProfile),
      action:
        'Generate your brand voice profile so every draft sounds like you.',
      href: '/dashboard/settings/knowledge-base',
    },
    {
      key: 'knowledge',
      label: 'Knowledge base content',
      weight: 15,
      done: knowledgeSources > 0,
      action:
        'Add a page or document to your knowledge base — it grounds every generation in real facts.',
      href: '/dashboard/settings/knowledge-base',
    },
    {
      key: 'competitors',
      label: `${COMPETITOR_TARGET} competitors tracked`,
      weight: 20,
      done: competitors >= COMPETITOR_TARGET,
      action:
        competitors === 0
          ? `Add your first competitor — Competitor Intelligence stays empty until you track at least one (aim for ${COMPETITOR_TARGET}).`
          : `Track ${COMPETITOR_TARGET - competitors} more competitor${
              COMPETITOR_TARGET - competitors === 1 ? '' : 's'
            } — comparison needs more than one point of reference.`,
      href: '/dashboard/competitors',
    },
    {
      key: 'discovery',
      label: 'Lead requirement defined',
      weight: 15,
      done: discoveryProfiles > 0,
      action:
        'Define what a good lead looks like, then run discovery — fit scores are only meaningful against stated criteria.',
      href: '/dashboard/leads/discover',
    },
    {
      key: 'content',
      label: 'First content drafted',
      weight: 10,
      done: drafts > 0,
      action: 'Draft your first post — content scores need something to read.',
      href: '/dashboard/content/new',
    },
    {
      key: 'connectors',
      label: 'A data source connected',
      weight: 5,
      done: connections > 0,
      action:
        'Connect Google Analytics (or log results manually) so Aura can measure what your marketing actually did.',
      href: '/dashboard/connectors',
    },
  ];

  const totalWeight = steps.reduce((sum, s) => sum + s.weight, 0);
  const earned = steps.reduce((sum, s) => sum + (s.done ? s.weight : 0), 0);
  const score = Math.round((earned / totalWeight) * 100);
  const outstanding = steps.filter((s) => !s.done);

  // Highest weight first so the suggested next step is the one that unlocks most.
  const nextStep =
    outstanding.slice().sort((a, b) => b.weight - a.weight)[0] ?? null;

  return {
    block: {
      score,
      // Always true: setup completeness is knowable from the moment a
      // workspace exists, which is what keeps the headline score from being null.
      hasData: true,
      basis: `${steps.length - outstanding.length} of ${steps.length} setup steps complete.`,
      recommendation: nextStep?.action,
      detail: {
        completed: steps.length - outstanding.length,
        total: steps.length,
        competitors,
        knowledgeSources,
        connections,
      },
    },
    steps,
    nextStep,
  };
}
