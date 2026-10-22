import Link from 'next/link';
import type { Metadata } from 'next';

import { Confirm, Fact, LegalPage, List, Section } from '@/components/legal/legal-page';
import { LEGAL, operatorName } from '@/lib/legal';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'How Botella Aura collects, uses, shares and deletes information.',
  // A draft is not indexed until it is approved (lib/legal.ts).
  robots: LEGAL.approved ? undefined : { index: false, follow: false },
};

/**
 * DRAFT Privacy Policy. Every statement about what Aura does is taken from
 * the application itself; everything that is a business or legal decision is
 * marked "to confirm" (lib/legal.ts). Not final until approved.
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={
        <p>
          This policy explains what information {LEGAL.productName} (“Aura”, “we”) collects when you use it, how it is used, who it is shared
          with, how long it is kept and how you can have it deleted. Aura is operated by {operatorName()}
          {LEGAL.operatorLegalName ? '' : <> <Confirm>to confirm: operator’s legal name and registration</Confirm></>}.
        </p>
      }
    >
      <Section id="who" title="1. Who is responsible">
        <p>
          {operatorName()}, <Fact value={LEGAL.operatorAddress} missing="registered address" />, is responsible for the information described here. For
          privacy questions or requests, contact <Fact value={LEGAL.privacyEmail} missing="privacy contact email" />.
        </p>
        <p>
          When a business uses Aura, the business decides what its workspace contains and who may use it. Whether Aura acts as the business’s
          processor or as a controller for each kind of information is <Confirm>to confirm with legal advisers</Confirm>.
        </p>
      </Section>

      <Section id="collect" title="2. What we collect">
        <h3 className="font-medium">Account information</h3>
        <List>
          <li>Your name and email address, and your password (stored only as a one-way hash, never in readable form).</li>
          <li>If you sign in with Google: the name, email address and profile picture Google provides.</li>
          <li>The workspaces you belong to and your role in each (owner, admin, member or viewer).</li>
        </List>

        <h3 className="font-medium">Business workspace information</h3>
        <List>
          <li>What your business tells Aura: its description, offerings, audience, goals, brand voice and competitors.</li>
          <li>Content created in Aura: drafts, their versions and approvals, campaigns, outreach messages and schedules.</li>
          <li>Images you upload or that Aura generates for your content.</li>
          <li>Leads and market information gathered from public sources and from tools you connect.</li>
          <li>Results of published posts (for example likes, comments and shares) and the recommendations Aura derives from them.</li>
          <li>A record of actions taken in the workspace (who did what, and when), including the IP address and browser of the request, for security.</li>
        </List>

        <h3 className="font-medium">Facebook and Instagram</h3>
        <p>When an owner or admin connects Facebook &amp; Instagram, Aura receives and stores:</p>
        <List>
          <li>An access token for the connecting person’s Facebook account, stored encrypted (AES-256-GCM). Page access tokens are not stored; Aura obtains one when it publishes.</li>
          <li>The Facebook user ID, the Facebook Pages that person manages (ID and name) and the Instagram professional account linked to each Page (ID and username).</li>
          <li>Which permissions were granted.</li>
          <li>For posts Aura publishes: the post’s ID and link, and its engagement (reactions, comments, shares). Impressions and reach only if the insights permissions were granted.</li>
        </List>
        <p>
          Aura uses this only to publish content your business approved, to show whether it was published, and to report its results. It does not
          read or send direct messages, run ads, or monitor other accounts.
        </p>

        <h3 className="font-medium">LinkedIn</h3>
        <List>
          <li>An access token, stored encrypted, and the permissions granted.</li>
          <li>Your LinkedIn member ID, name, profile picture and email address (from LinkedIn’s sign-in).</li>
          <li>The posts Aura publishes for you and their links.</li>
        </List>

        <h3 className="font-medium">WhatsApp</h3>
        <p>If you use Aura’s WhatsApp assistant:</p>
        <List>
          <li>Your phone number, stored encrypted (only its last four digits are kept readable, to show you which number is linked), and your WhatsApp profile name.</li>
          <li>The text of messages between you and Aura’s WhatsApp number, and their delivery status.</li>
          <li>Which Aura account and workspace your number is linked to, and whether you have opted out (by sending STOP).</li>
        </List>

        <h3 className="font-medium">Other tools you connect</h3>
        <p>
          If your business connects Google Analytics, Google Search Console, HubSpot, Mailchimp, Slack or other supported tools, Aura stores the
          credentials (encrypted) and reads data from them to inform its recommendations.
        </p>

        <h3 className="font-medium">Payments</h3>
        <p>Payments are handled by Stripe. Aura stores your plan and subscription status, not your card number.</p>

        <h3 className="font-medium">Technical information</h3>
        <p>
          Cookies needed to keep you signed in and to protect sign-ins (for example a short-lived cookie that ties an account connection to the
          browser that started it), and error reports used to fix problems. Aura does not use advertising cookies{' '}
          <Confirm>to confirm: no analytics or advertising cookies are added</Confirm>.
        </p>
      </Section>

      <Section id="use" title="3. How we use information">
        <List>
          <li>To provide Aura: build your business context, write and review content, plan campaigns, and publish what you approve.</li>
          <li>To publish to Facebook, Instagram and LinkedIn — only content a person in your business approved, to the accounts your business connected.</li>
          <li>To answer you on WhatsApp, inside the workspace you chose.</li>
          <li>To keep Aura secure: authentication, preventing abuse and keeping a record of actions.</li>
          <li>To send service emails (for example invitations and password resets).</li>
        </List>
        <p>
          The legal bases for each use (for example contract, legitimate interests or consent) are <Confirm>to confirm with legal advisers</Confirm>.
        </p>
      </Section>

      <Section id="ai" title="4. AI-generated content">
        <p>
          Aura uses AI models to write and review content and to create images. To do so it sends the relevant parts of your workspace — for
          example your business description, brand voice, the brief and earlier drafts — to the AI provider configured for Aura. The text
          provider is Google (Gemini); depending on configuration, Anthropic, OpenAI, Replicate, Stability AI or Agnes AI may be used for text or
          images <Confirm>to confirm: which providers are enabled in production</Confirm>.
        </p>
        <p>
          AI output can be wrong. Aura checks drafts (a review, compliance and fact checks), but nothing is published until a person in your
          business approves it. Whether providers may use submitted data to train their models depends on each provider’s terms{' '}
          <Confirm>to confirm per provider and plan</Confirm>.
        </p>
      </Section>

      <Section id="share" title="5. Who we share information with">
        <p>Aura does not sell personal information <Confirm>to confirm as a business commitment</Confirm>. It shares information only with:</p>
        <List>
          <li>The social networks you publish to (Meta for Facebook, Instagram and WhatsApp; LinkedIn), when you connect them and publish.</li>
          <li>AI providers, as described above.</li>
          <li>Service providers that run Aura: hosting, database and file storage (<Fact value={LEGAL.hosting} missing="providers and regions" />), email delivery (Resend or an SMTP provider), payments (Stripe), and error monitoring (Sentry, if enabled).</li>
          <li>Tools your business connects, as needed to use them.</li>
          <li>Authorities, where the law requires it <Confirm>to confirm wording with legal advisers</Confirm>.</li>
        </List>
        <p>
          International transfers and the safeguards used for them are <Confirm>to confirm with legal advisers</Confirm>.
        </p>
      </Section>

      <Section id="retention" title="6. How long we keep information">
        <List>
          <li>Account and workspace information: while the account is active, and for <Fact value={LEGAL.retentionAfterClosure} missing="period after an account is closed" /> after it is closed.</li>
          <li>WhatsApp message text: deleted automatically after 90 days (the operator may set a different period).</li>
          <li>Access tokens: deleted when you disconnect the account, or when Facebook tells Aura you removed it.</li>
          <li>Sign-in links and codes for WhatsApp: valid for 10 minutes; a linked WhatsApp number stays signed in for 30 days unless you unlink it.</li>
          <li>Records of actions (audit log) and backups: <Confirm>to confirm: retention periods</Confirm>.</li>
        </List>
      </Section>

      <Section id="delete" title="7. Deleting your information">
        <List>
          <li><strong>Disconnect an account</strong> in Aura (Facebook &amp; Instagram and other tools under <em>Your tools</em>; LinkedIn under <em>Settings → Connections</em>): its stored tokens are deleted, and Aura asks the platform to withdraw its access.</li>
          <li><strong>Facebook:</strong> remove Botella Aura in your Facebook settings (Settings &amp; privacy → Settings → Apps and websites). Aura is notified, deletes the stored token and marks the connection removed. You can also send a data deletion request from there; Aura deletes the Facebook and Instagram connection data and gives you a confirmation code you can check.</li>
          <li><strong>WhatsApp:</strong> send STOP to stop messages, or “Log out” to unlink your number.</li>
          <li><strong>Your Aura account or a whole workspace:</strong> email <Fact value={LEGAL.privacyEmail} missing="privacy contact email" />. Self-service account deletion is not yet available in Aura.</li>
        </List>
        <p>
          See <Link href="/data-deletion" className="text-primary underline underline-offset-2">Data deletion</Link> for step-by-step instructions.
          The time within which requests are completed is <Confirm>to confirm</Confirm>.
        </p>
      </Section>

      <Section id="security" title="8. Security">
        <p>
          Access tokens, API keys and WhatsApp numbers are encrypted at rest (AES-256-GCM); passwords are stored as one-way hashes; each workspace’s
          data is separated from every other’s and access depends on your role; sign-ins to connected platforms are protected against forgery. No
          system is perfectly secure.
        </p>
      </Section>

      <Section id="rights" title="9. Your rights">
        <p>
          Depending on where you live, you may have the right to access, correct, delete or export your information, to object to or restrict
          some uses, and to complain to a data protection authority. To use these rights, contact{' '}
          <Fact value={LEGAL.privacyEmail} missing="privacy contact email" />. Which laws apply (for example GDPR, UK GDPR or US state laws) is{' '}
          <Confirm>to confirm with legal advisers</Confirm>.
        </p>
      </Section>

      <Section id="children" title="10. Children">
        <p>
          Aura is a business tool and is not intended for anyone under <Fact value={LEGAL.minimumAge} missing="minimum age" />.
        </p>
      </Section>

      <Section id="changes" title="11. Changes and contact">
        <p>
          If this policy changes, the new version will be posted here with its effective date <Confirm>to confirm: how users are notified</Confirm>.
          Questions: <Fact value={LEGAL.privacyEmail} missing="privacy contact email" />.
        </p>
      </Section>
    </LegalPage>
  );
}
