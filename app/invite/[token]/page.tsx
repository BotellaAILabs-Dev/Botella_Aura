import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getCurrentUser } from '@/lib/auth-helpers';
import { AcceptInvite } from '@/components/auth/accept-invite';
import { Logo } from '@/components/brand/logo';

export const metadata: Metadata = { title: 'Accept invitation' };

/**
 * Invite accept landing. Logged-out users are sent to log in / sign up and
 * bounced back here afterward (via callbackUrl); logged-in users see the accept
 * card. The actual membership write happens in POST /api/invitations/accept.
 */
export default async function InvitePage({
  params,
}: {
  params: { token: string };
}) {
  const user = await getCurrentUser();
  const back = `/invite/${params.token}`;
  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent(back)}`);
  }

  return (
    <div className="aura-gradient flex min-h-screen flex-col">
      <header className="mx-auto w-full max-w-6xl px-6 py-6">
        <Logo />
      </header>
      <main className="flex flex-1 items-center justify-center px-6 pb-16">
        <div className="w-full max-w-md">
          <AcceptInvite token={params.token} />
        </div>
      </main>
    </div>
  );
}
