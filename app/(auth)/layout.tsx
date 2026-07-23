import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Logo } from '@/components/brand/logo';
import { getCurrentUser } from '@/lib/auth-helpers';

/**
 * Auth surfaces (login/signup/reset) share a centered, single-column layout on
 * the branded gradient. Already-authenticated users are bounced to the app.
 */
export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (user) redirect('/dashboard');

  return (
    <div className="aura-gradient flex min-h-screen flex-col">
      <header className="mx-auto w-full max-w-6xl px-6 py-6">
        <Link href="/" aria-label="Botella Aura home">
          <Logo />
        </Link>
      </header>
      <main className="flex flex-1 items-center justify-center px-6 pb-16">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
