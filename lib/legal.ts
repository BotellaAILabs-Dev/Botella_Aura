/**
 * Facts the legal pages (/privacy, /terms, /data-deletion) depend on.
 *
 * Every `null` is a business or legal decision not yet made. The pages show
 * it as a visible "To confirm" marker instead of inventing a value. Fill
 * these in, have the text reviewed, then set `approved: true`. Until then
 * the pages carry a DRAFT banner and ask search engines not to index them.
 */
export const LEGAL = {
  /** Set to true only after business and legal sign-off. */
  approved: false,
  productName: 'Botella Aura',
  /** Legal name of the company that operates Aura (the site footer says "Botella AI Labs"). */
  operatorLegalName: null as string | null,
  /** Registered address. */
  operatorAddress: null as string | null,
  /** Where privacy and deletion requests go (a monitored mailbox). */
  privacyEmail: null as string | null,
  /** General support / legal notices. */
  supportEmail: null as string | null,
  /** Date the approved version takes effect. */
  effectiveDate: null as string | null,
  /** Governing law and courts for the Terms. */
  governingLaw: null as string | null,
  /** Minimum age to use Aura. */
  minimumAge: null as number | null,
  /** How long account/workspace data is kept after an account is closed. */
  retentionAfterClosure: null as string | null,
  /** Where the database, files and backups are hosted (provider and region). */
  hosting: null as string | null,
} as const;

/** The name to show for the operator: the confirmed legal name, or the brand marked unconfirmed. */
export function operatorName(): string {
  return LEGAL.operatorLegalName ?? 'Botella AI Labs';
}
