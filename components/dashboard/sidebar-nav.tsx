'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { navBySection } from '@/lib/nav';
import { cn } from '@/lib/utils';

/**
 * Sidebar navigation links, grouped into labelled sections.
 *
 * The flat fourteen-item list read as a menu of separate tools. Sections give
 * the sidebar an obvious top — the score — and a reading order that follows
 * what someone is trying to do, while every page stays exactly where it was.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();

  /**
   * The link the user just clicked, highlighted before the router commits.
   *
   * `usePathname` only changes once the navigation lands, so on a slow route
   * the clicked item stayed grey and the old one stayed highlighted — the nav
   * looked like it had ignored the click. Painting the target immediately is
   * the difference between "nothing happened" and "it's loading", and it costs
   * one state update.
   */
  const [pending, setPending] = useState<string | null>(null);

  // The navigation landed (or the user went somewhere else entirely) — the
  // real pathname takes over again.
  useEffect(() => {
    setPending(null);
  }, [pathname]);

  return (
    <nav className="flex flex-1 flex-col gap-1 px-3 py-4" aria-label="Primary">
      {navBySection().map((section) => (
        <div key={section.id} className="flex flex-col gap-1">
          {section.label && (
            <p className="px-3 pb-0.5 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {section.label}
            </p>
          )}
          {section.items.map((item) => {
            const current = pending ?? pathname;
            const active =
              item.href === '/dashboard'
                ? current === '/dashboard'
                : current.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => {
                  setPending(item.href);
                  onNavigate?.();
                }}
                /**
                 * Warm the route on intent rather than on click.
                 *
                 * Dashboard routes are `force-dynamic`, so Next's automatic
                 * prefetch only fetches the loading skeleton. Starting the real
                 * render when the pointer arrives buys the server the ~200ms
                 * between hover and click — usually enough that the page is
                 * already in the Router Cache by the time it is needed.
                 * `router.prefetch` de-duplicates, so re-hovering is free.
                 */
                onMouseEnter={() => router.prefetch(item.href)}
                onFocus={() => router.prefetch(item.href)}
                onTouchStart={() => router.prefetch(item.href)}
                aria-current={active ? 'page' : undefined}
                // The one-line "what you get" was already written for every
                // item and rendered nowhere. Hovering a nav item is exactly
                // when someone is asking "what is this one for".
                title={item.description}
                className={cn(
                  'group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <item.icon
                  className={cn(
                    'h-4 w-4 shrink-0',
                    active
                      ? 'text-primary'
                      : 'text-muted-foreground group-hover:text-foreground',
                  )}
                  aria-hidden
                />
                <span className="flex-1 truncate">{item.label}</span>
                {!item.ready && (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    Soon
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
