import Link from 'next/link';
import type { Metadata } from 'next';

import { Confirm, Fact, LegalPage, List, Section } from '@/components/legal/legal-page';
import { LEGAL, operatorName } from '@/lib/legal';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The terms for using Botella Aura.',
  // A draft is not indexed until it is approved (lib/legal.ts).
  robots: LEGAL.approved ? undefined : { index: false, follow: false },
};

/**
 * DRAFT Terms of Service. Describes how Aura actually works (approval before
 * publishing, connected accounts, AI drafts); every business or legal term is
 * marked "to confirm" (lib/legal.ts). Not final until approved.
 */
export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      intro={
        <p>
          These terms govern your use of {LEGAL.productName} (“Aura”), operated by {operatorName()}
          {LEGAL.operatorLegalName ? '' : <> <Confirm>to confirm: operator’s legal name</Confirm></>}. By creating an account or using Aura you
          agree to them. If you use Aura for a business, you confirm you may accept them on its behalf. Our{' '}
          <Link href="/privacy" className="text-primary underline underline-offset-2">Privacy Policy</Link> explains how information is handled.
        </p>
      }
    >
      <Section id="service" title="1. The service">
        <p>
          Aura helps businesses plan, write, review and publish marketing content. It builds a picture of your business, drafts content with AI,
          lets your team review and approve it, and publishes approved content to the social accounts you connect (currently Facebook,
          Instagram and LinkedIn). It also offers a WhatsApp assistant. Features may change over time.
        </p>
      </Section>

      <Section id="accounts" title="2. Your account and workspace">
        <List>
          <li>Give accurate information and keep your sign-in details secure. You are responsible for activity under your account.</li>
          <li>Workspace owners and admins decide who joins the workspace and what role each person has. Roles limit what each person can do — for example, only some roles can approve or publish content.</li>
          <li>You must be at least <Fact value={LEGAL.minimumAge} missing="minimum age" /> to use Aura.</li>
        </List>
      </Section>

      <Section id="use" title="3. Acceptable use">
        <p>You must not use Aura to:</p>
        <List>
          <li>publish content that is unlawful, deceptive, defamatory, hateful, or that infringes anyone’s rights;</li>
          <li>send spam or unsolicited messages, including through WhatsApp or connected tools;</li>
          <li>break the rules of the platforms you connect (including Meta’s and LinkedIn’s terms and policies);</li>
          <li>access accounts, Pages or data you are not authorised to use;</li>
          <li>disrupt, overload, reverse-engineer or bypass the security of Aura.</li>
        </List>
        <p>Additional prohibited uses: <Confirm>to confirm</Confirm>.</p>
      </Section>

      <Section id="connected" title="4. Connected accounts">
        <List>
          <li>You may connect only accounts, Pages and profiles you own or are authorised to manage, and you authorise Aura to act on them within the permissions you grant.</li>
          <li>Connected platforms are run by third parties under their own terms. They can change or withdraw features, limit how much can be posted, or revoke access; Aura cannot guarantee that they work.</li>
          <li>You can disconnect an account at any time in Aura (<em>Your tools</em>, or <em>Settings → Connections</em> for LinkedIn), or by removing Aura from the platform’s own settings.</li>
        </List>
      </Section>

      <Section id="publishing" title="5. Approval and publishing">
        <List>
          <li>Aura publishes only content that a person in your workspace with permission to approve has approved, and only to accounts your workspace connected.</li>
          <li>Approving and publishing or scheduling content is your instruction to Aura to publish it, as written, at the chosen time.</li>
          <li>You are responsible for content you approve. Review it before approving.</li>
          <li>Publishing can fail or be delayed (for example because a platform is unavailable, rate-limits requests or access has expired). Aura shows the result and, where it can, retries or asks you to act; it does not guarantee that a post will be published at an exact time.</li>
        </List>
      </Section>

      <Section id="ownership" title="6. Your content">
        <p>
          You keep ownership of the content and information you put into Aura and of the content Aura produces for you{' '}
          <Confirm>to confirm: ownership wording for AI output</Confirm>. You give {operatorName()} the permission needed to store, process and
          publish it in order to provide Aura to you. You confirm you have the rights to the material you upload.
        </p>
        <p>Aura’s software, design and brand belong to {operatorName()} and its licensors.</p>
      </Section>

      <Section id="ai" title="7. AI-generated content">
        <List>
          <li>Drafts, images and recommendations are produced by AI models from third-party providers. They can be inaccurate, incomplete or similar to content created for others.</li>
          <li>Aura’s automatic reviews (quality, compliance and fact checks) help but do not guarantee accuracy or legal compliance.</li>
          <li>Check facts, claims, prices and anything regulated before approving. Do not rely on AI output as legal, financial or medical advice.</li>
        </List>
      </Section>

      <Section id="fees" title="8. Plans and payment">
        <p>
          Paid plans are billed through Stripe. Prices, billing periods, renewals, cancellations and refunds: <Confirm>to confirm</Confirm>.
        </p>
      </Section>

      <Section id="termination" title="9. Suspension and termination">
        <List>
          <li>You can stop using Aura at any time. To close your account or delete a workspace, follow the steps on the <Link href="/data-deletion" className="text-primary underline underline-offset-2">Data deletion</Link> page.</li>
          <li>We may suspend or close accounts that break these terms or put Aura, its users or connected platforms at risk <Confirm>to confirm: notice period and process</Confirm>.</li>
          <li>When an account is closed, its information is handled as the Privacy Policy describes.</li>
        </List>
      </Section>

      <Section id="liability" title="10. Disclaimers and limitation of liability">
        <p>
          Aura is provided “as is”. Warranty disclaimers, the limit of liability, indemnities and the exclusions required by law:{' '}
          <Confirm>to confirm with legal advisers</Confirm>.
        </p>
      </Section>

      <Section id="legal" title="11. Legal provisions">
        <List>
          <li>Governing law and courts: <Fact value={LEGAL.governingLaw} missing="governing law and jurisdiction" />.</li>
          <li>Changes to these terms: posted here with a new effective date <Confirm>to confirm: notice to users</Confirm>.</li>
          <li>Contact: <Fact value={LEGAL.supportEmail} missing="support / legal contact email" />.</li>
          <li>Severability, assignment, entire agreement and other standard clauses: <Confirm>to confirm with legal advisers</Confirm>.</li>
        </List>
      </Section>
    </LegalPage>
  );
}
