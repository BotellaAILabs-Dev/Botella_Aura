import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import { getCurrentUser } from '@/lib/auth-helpers';
import { Logo } from '@/components/brand/logo';
import { LinkWhatsApp } from '@/components/whatsapp/link-whatsapp';
import { viewChallenge } from '@/server/whatsapp/link.service';

export const metadata: Metadata = {
  title: 'Link WhatsApp',
  // The token is in the URL: never index it, never send it on as a referrer
  // (the page links out to wa.me).
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export const dynamic = 'force-dynamic';

/** Tokens are 32 random bytes, base64url — anything else is not one of ours. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Where the sign-in link sent on WhatsApp lands (lib/whatsapp-link.ts).
 * Signed-out visitors log in first (Aura's own login, back here after);
 * signed-in ones see which number they are linking and confirm — or say it
 * isn't theirs. Viewing never uses the link up: WhatsApp's link preview and
 * security scanners open links too. Confirming is a POST.
 */
export default async function LinkWhatsAppPage({ params }: { params: { token: string } }) {
  const user = await getCurrentUser();
  const back = `/whatsapp/link/${params.token}`;
  if (!user) redirect(`/login?callbackUrl=${encodeURIComponent(back)}`);

  const view = TOKEN.test(params.token)
    ? await viewChallenge(params.token, user.id)
    : ({ state: 'invalid' } as const);

  return (
    <div className="aura-gradient flex min-h-screen flex-col">
      <header className="mx-auto w-full max-w-6xl px-6 py-6">
        <Logo />
      </header>
      <main className="flex flex-1 items-center justify-center px-6 pb-16">
        <div className="w-full max-w-md">
          <LinkWhatsApp
            token={params.token}
            email={user.email ?? ''}
            view={
              view.state === 'pending' || view.state === 'confirmed_by_you'
                ? { ...view, expiresAt: view.expiresAt.toISOString() }
                : { state: view.state }
            }
          />
        </div>
      </main>
    </div>
  );
}
