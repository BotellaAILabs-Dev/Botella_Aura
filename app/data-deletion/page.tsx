import Link from 'next/link';
import type { Metadata } from 'next';

import { Confirm, Fact, LegalPage, List, Section } from '@/components/legal/legal-page';
import { LEGAL } from '@/lib/legal';

export const metadata: Metadata = {
  title: 'Data Deletion',
  description: 'How to delete your data from Botella Aura.',
  robots: LEGAL.approved ? undefined : { index: false, follow: false },
};

/**
 * Public data-deletion instructions — usable as Meta's "Data deletion
 * instructions URL". Aura also implements the "Data deletion request
 * callback" (POST /api/meta/data-deletion, status at /meta/data-deletion).
 * Each step below matches what the code does.
 */
export default function DataDeletionPage() {
  const email = <Fact value={LEGAL.privacyEmail} missing="privacy contact email" />;
  return (
    <LegalPage
      title="Data Deletion"
      intro={<p>You can remove the data {LEGAL.productName} holds about you in the ways below. Choose the one that matches what you want removed.</p>}
    >
      <Section id="facebook" title="1. Facebook and Instagram data">
        <p><strong>From Facebook (no Aura sign-in needed):</strong></p>
        <List>
          <li>On Facebook, open <em>Settings &amp; privacy → Settings → Apps and websites</em>.</li>
          <li>Find <strong>Botella Aura</strong> and choose <em>Remove</em>. Aura is notified, deletes its stored Facebook access token and stops publishing to your Pages and Instagram accounts.</li>
          <li>To have the data deleted as well, choose to send a data deletion request from the same screen. Aura deletes the Facebook &amp; Instagram connection — the access token, your Facebook user ID, and the list of Pages and Instagram accounts — and gives you a confirmation code. You can check it at any time on the status page Facebook links you to.</li>
        </List>
        <p><strong>From Aura (owners and admins):</strong> open <em>Your tools</em> in the dashboard, find Facebook &amp; Instagram and select <em>Disconnect</em>. Aura asks Facebook to withdraw its access and deletes the stored token.</p>
        <p className="text-sm text-muted-foreground">
          Posts already published to your Page or Instagram account stay there — delete them on Facebook or Instagram. Aura’s record of what it
          published (post IDs and links) stays in the workspace history until the workspace is deleted <Confirm>to confirm: whether this record is also removed on a deletion request</Confirm>.
        </p>
      </Section>

      <Section id="linkedin" title="2. LinkedIn data">
        <List>
          <li>In Aura, open <em>Settings → Connections</em> and select <em>Disconnect</em> on LinkedIn. Aura deletes the stored access token.</li>
          <li>You can also remove Aura’s access in LinkedIn: <em>Settings → Data privacy → Permitted services</em>.</li>
        </List>
      </Section>

      <Section id="whatsapp" title="3. WhatsApp data">
        <List>
          <li>Send <strong>STOP</strong> to Aura’s WhatsApp number to stop all messages.</li>
          <li>Send <strong>Log out</strong> to unlink your number from your Aura account.</li>
          <li>Message text is deleted automatically after 90 days. To have your number and messages deleted sooner, email {email}.</li>
        </List>
      </Section>

      <Section id="account" title="4. Your whole Aura account or workspace">
        <p>
          Self-service deletion is not yet available in Aura. Email {email} from the address you sign in with, saying whether you want your
          personal account deleted or the whole workspace (workspace deletion must be requested by an owner). We will confirm the identity of the
          requester, delete the data and confirm when it is done.
        </p>
        <p>
          Time to complete a request: <Confirm>to confirm</Confirm>. Data kept after deletion where the law requires it (for example billing
          records) and removal from backups: <Confirm>to confirm</Confirm>.
        </p>
      </Section>

      <Section id="more" title="5. More information">
        <p>
          See the <Link href="/privacy" className="text-primary underline underline-offset-2">Privacy Policy</Link> for what Aura collects and how
          long it is kept.
        </p>
      </Section>
    </LegalPage>
  );
}
