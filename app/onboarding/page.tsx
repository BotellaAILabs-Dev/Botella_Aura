import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { requireUser } from '@/lib/auth-helpers';
import { getCompaniesForUser } from '@/server/services/company.service';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';
import { Logo } from '@/components/brand/logo';

export const metadata: Metadata = { title: 'Set up your workspace' };

/**
 * Onboarding lives OUTSIDE the dashboard shell (no sidebar) so new users focus
 * on setup. First-time users (no company) always see the wizard. Existing users
 * are normally sent to the app — UNLESS they explicitly chose to create ANOTHER
 * workspace (`?new=1`, from the topbar "Create workspace" action).
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: { new?: string };
}) {
  const user = await requireUser();
  const companies = await getCompaniesForUser(user.id);
  const creatingAnother = searchParams.new === '1';
  if (companies.length > 0 && !creatingAnother) redirect('/dashboard');

  return (
    <div className="aura-gradient flex min-h-screen flex-col">
      <header className="mx-auto w-full max-w-3xl px-6 py-6">
        <Logo />
      </header>
      <main className="flex flex-1 items-start justify-center px-6 pb-16 pt-4">
        <div className="w-full max-w-2xl">
          <OnboardingWizard
            userName={user.name ?? null}
            additional={creatingAnother}
          />
        </div>
      </main>
    </div>
  );
}
