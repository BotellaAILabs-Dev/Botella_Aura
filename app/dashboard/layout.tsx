import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { JobIndicator } from '@/components/dashboard/jobs/job-indicator';

/**
 * Protected dashboard layout. Middleware already blocks unauthenticated users;
 * here we additionally require a company — if the user hasn't onboarded, send
 * them to the wizard. The resolved company list feeds the topbar switcher.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const { active, companies } = await resolveActiveCompany(user.id);

  if (!active) redirect('/onboarding');

  return (
    <DashboardShell
      user={{ name: user.name ?? null, email: user.email ?? null, image: user.image ?? null }}
      companies={companies}
      activeCompanyId={active.id}
    >
      {children}
      {/* Background generations report progress and completion from anywhere,
          so a long run does not require staying on the page that started it. */}
      <JobIndicator />
    </DashboardShell>
  );
}
