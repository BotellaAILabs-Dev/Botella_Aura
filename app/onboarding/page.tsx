import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { requireUser } from '@/lib/auth-helpers';
import { getCompaniesForUser } from '@/server/services/company.service';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';
import { Logo } from '@/components/brand/logo';

export const metadata: Metadata = { title: 'Set up your workspace' };

/**
 * Onboarding lives OUTSIDE the dashboard shell (no sidebar) so new users focus
 * on setup. If the user already belongs to a company, skip straight to the app.
 */
export default async function OnboardingPage() {
  const user = await requireUser();
  const companies = await getCompaniesForUser(user.id);
  if (companies.length > 0) redirect('/dashboard');

  return (
    <div className="aura-gradient flex min-h-screen flex-col">
      <header className="mx-auto w-full max-w-3xl px-6 py-6">
        <Logo />
      </header>
      <main className="flex flex-1 items-start justify-center px-6 pb-16 pt-4">
        <div className="w-full max-w-2xl">
          <OnboardingWizard userName={user.name ?? null} />
        </div>
      </main>
    </div>
  );
}
