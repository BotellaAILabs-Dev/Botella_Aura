import type { LucideIcon } from 'lucide-react';
import {
  Building2,
  FileUp,
  Palette,
  Users,
  Plug,
  CalendarRange,
  Sparkles,
} from 'lucide-react';

/**
 * Setting Aura up, as a sequence.
 *
 * Aura cannot do anything useful until it knows the business, and each step
 * makes the next one better: materials teach it what you actually sell, brand
 * assets decide what the graphics look like, audience and goals decide what the
 * plan aims at. Presented as an unordered list of settings links — which is
 * what it was — a new user has no way to tell which of them matters first, or
 * whether they are done.
 *
 * So the steps are ORDERED and their completion is DERIVED from real data
 * (see server/onboarding/checklist.service.ts). Nothing here is a flag someone
 * can tick; a step is done when the thing it asks for exists in the database.
 * That means the checklist stays honest if a user deletes what they added, and
 * that it can be picked up mid-way on any device.
 */
export const ONBOARDING_STEP_IDS = [
  'business',
  'materials',
  'brand',
  'audience',
  'channels',
  'plan',
  'review',
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export interface OnboardingStepDef {
  id: OnboardingStepId;
  /** What the user is doing, in their words. */
  title: string;
  /**
   * Why it is worth doing — stated as the difference it makes to the output,
   * never as a description of the feature. Someone deciding whether to spend
   * two minutes on a step needs to know what they get back.
   */
  why: string;
  /** Where the step is actually completed. */
  href: string;
  /** The button, phrased as the action. */
  cta: string;
  icon: LucideIcon;
  /**
   * Whether Aura is usable without it. Only the first step is truly required —
   * the rest improve the output, and saying so honestly is what stops the
   * checklist reading as six chores blocking the door.
   */
  required: boolean;
}

export const ONBOARDING_STEPS: OnboardingStepDef[] = [
  {
    id: 'business',
    title: 'Add your business information',
    why: 'Everything Aura writes starts from what your company does and who it is.',
    href: '/dashboard/settings',
    cta: 'Review your details',
    icon: Building2,
    required: true,
  },
  {
    id: 'materials',
    title: 'Upload your marketing materials',
    why: 'Decks, one-pagers and your website teach Aura your real products and claims, so posts stop being generic.',
    href: '/dashboard/settings/knowledge-base',
    cta: 'Add materials',
    icon: FileUp,
    required: false,
  },
  {
    id: 'brand',
    title: 'Add your brand assets',
    why: 'Your logo and colours steer every graphic Aura makes, so creatives look like they came from you.',
    href: '/dashboard/settings/brand',
    cta: 'Add logo and colours',
    icon: Palette,
    required: false,
  },
  {
    id: 'audience',
    title: 'Define your audience and goals',
    why: 'Aura writes TO a person and aims at a number. Without these it writes about your subject, to nobody.',
    href: '/dashboard/settings/audience',
    cta: 'Describe your buyers',
    icon: Users,
    required: false,
  },
  {
    id: 'channels',
    title: 'Connect your marketing channels',
    why: 'Connecting LinkedIn or your analytics lets Aura publish approved posts and report real numbers instead of estimates.',
    href: '/dashboard/settings/connections',
    cta: 'Connect a channel',
    icon: Plug,
    required: false,
  },
  {
    id: 'plan',
    title: 'Generate your first marketing plan',
    why: 'A dated month of topics tied to your goals — this is what Aura works from every week.',
    href: '/dashboard/planner',
    cta: 'Build your plan',
    icon: CalendarRange,
    required: false,
  },
  {
    id: 'review',
    title: 'Review your first week of work',
    why: 'Your calendar, written posts, graphics and recommendations — all in one place, waiting for your approval.',
    href: '/dashboard',
    cta: 'See what Aura made',
    icon: Sparkles,
    required: false,
  },
];

export function onboardingStep(id: OnboardingStepId): OnboardingStepDef {
  const step = ONBOARDING_STEPS.find((s) => s.id === id);
  // The id type makes this unreachable; the throw is here so a future edit that
  // adds an id to the union without adding the step fails loudly.
  if (!step) throw new Error(`Unknown onboarding step: ${id}`);
  return step;
}
