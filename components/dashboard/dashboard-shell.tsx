'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { SidebarNav } from '@/components/dashboard/sidebar-nav';
import { CompanySwitcher } from '@/components/dashboard/company-switcher';
import { UserMenu } from '@/components/dashboard/user-menu';
import { RecommendationContextBar } from '@/components/dashboard/recommendations/recommendation-context-bar';
import { cn } from '@/lib/utils';
import type { CompanySummary } from '@/types';

interface DashboardShellProps {
  user: { name: string | null; email: string | null; image: string | null };
  companies: CompanySummary[];
  activeCompanyId: string | null;
  children: React.ReactNode;
}

/**
 * Persistent app shell: fixed sidebar on desktop, slide-over drawer on mobile,
 * and a sticky topbar with the company switcher + account menu. Every future
 * feature renders inside {children}.
 */
export function DashboardShell({
  user,
  companies,
  activeCompanyId,
  children,
}: DashboardShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-border bg-card lg:flex">
        <div className="flex h-16 items-center border-b border-border px-5">
          <Link href="/dashboard" aria-label="Botella Aura home">
            <Logo />
          </Link>
        </div>
        <SidebarNav />
        <div className="border-t border-border p-4">
          <p className="text-xs text-muted-foreground">
            Human-in-the-loop. Aura never acts without your approval.
          </p>
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal>
          <div
            className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col bg-card shadow-lg">
            <div className="flex h-16 items-center justify-between border-b border-border px-5">
              <Logo />
              <button
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
                className="rounded-md p-1 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <SidebarNav onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="lg:pl-64">
        {/* Opaque, not translucent-with-backdrop-blur.

            A `backdrop-filter` on a `position: sticky` element forces the
            compositor to re-blur the region behind the header on every scroll
            frame, which is the classic source of stuttery scrolling on
            integrated graphics. The card surface is opaque white anyway, so
            at 80% + blur it was already reading as solid — this drops the
            per-frame cost and looks the same. */}
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-card px-4 sm:px-6">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="rounded-md p-2 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>

          <CompanySwitcher companies={companies} activeId={activeCompanyId} />

          <div className="ml-auto flex items-center gap-2">
            <UserMenu
              name={user.name}
              email={user.email}
              image={user.image}
            />
          </div>
        </header>

        <main
          className={cn(
            'mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-8',
          )}
        >
          {/* The Aura recommendation being worked on follows the person
              between modules (?rec=). Suspense: it reads search params. */}
          <Suspense fallback={null}>
            <RecommendationContextBar />
          </Suspense>
          {children}
        </main>
      </div>
    </div>
  );
}
