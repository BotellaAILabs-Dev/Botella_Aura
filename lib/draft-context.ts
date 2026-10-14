/**
 * The recommendation context a Content Studio draft carries after it is
 * written — `aiMetadata.brief` (lib/content-brief.ts) and
 * `aiMetadata.recommendation` (lib/recommendation-creation.ts) — for the steps
 * that come later: regenerating, marketing creatives, images, the board.
 *
 * Read loosely, on purpose: drafts written by hand have neither, and older
 * drafts have only the recommendation's id and title. Every value is null (or
 * empty) when the draft does not have it, so a manual draft reads exactly as
 * it did before. Pure and client-safe.
 */

export interface DraftContext {
  /** Written for an Aura recommendation. */
  fromRecommendation: boolean;
  recommendationId: string | null;
  title: string | null;
  keyMessage: string | null;
  audience: string | null;
  goal: string | null;
  why: string | null;
  expectedOutcome: string | null;
  /** Evidence labels — the only market claims the copy may make. */
  evidence: string[];
  /** Whether the brief expects a call to action (null: the format decides). */
  ctaExpected: boolean | null;
  /** Where the call to action points — the business's own site only. */
  ctaDestination: string | null;
}

type Bag = Record<string, unknown>;

const bag = (v: unknown): Bag | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Bag) : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;
/** `{ value }` fields in the brief, or a plain string in the provenance. */
const val = (v: unknown): string | null => str(v) ?? str(bag(v)?.value);
const labels = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((e) => str(bag(e)?.label)).filter((x): x is string => Boolean(x))
    : [];

export function draftContext(aiMetadata: unknown): DraftContext {
  const meta = bag(aiMetadata) ?? {};
  const b = bag(meta.brief);
  const r = bag(meta.recommendation);
  const cta = bag(b?.cta);
  const evidence = labels(b?.evidence);
  return {
    fromRecommendation: Boolean(str(r?.id)),
    recommendationId: str(r?.id),
    title: str(r?.title),
    keyMessage: val(b?.keyMessage),
    audience: val(b?.targetAudience) ?? str(r?.audience),
    goal: val(b?.marketingGoal) ?? str(r?.goal),
    why: str(bag(b?.reason)?.why) ?? str(r?.why),
    expectedOutcome:
      str(bag(b?.expectedOutcome)?.outcome) ?? str(r?.expectedOutcome),
    evidence: evidence.length ? evidence : labels(r?.evidence),
    ctaExpected: typeof cta?.expected === 'boolean' ? cta.expected : null,
    ctaDestination: val(cta?.destination),
  };
}

/**
 * The writer's reminder of what the piece is for, when a later step rewrites
 * it. Empty for a draft not written from a recommendation.
 */
export function draftContextPrompt(c: DraftContext): string {
  if (!c.fromRecommendation) return '';
  return [
    `WRITTEN FOR AURA'S SUGGESTION${c.title ? `: "${c.title}"` : ''} — keep to it:`,
    c.keyMessage ? `Key message: ${c.keyMessage}` : '',
    c.why ? `Why now: ${c.why}` : '',
    c.goal ? `Marketing goal: ${c.goal}` : '',
    c.audience ? `Audience: ${c.audience}` : '',
    c.expectedOutcome ? `Expected outcome: ${c.expectedOutcome}` : '',
    c.evidence.length
      ? `Evidence (cite only this; invent nothing beyond it): ${c.evidence.join('; ')}`
      : 'Evidence: none recorded — make no claims about the market, competitors or results.',
    c.ctaDestination
      ? `Call to action: send people to ${c.ctaDestination}.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
