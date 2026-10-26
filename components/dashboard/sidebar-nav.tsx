'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { groupForPath, navByGroup, type NavItem } from '@/lib/nav';
import { cn } from '@/lib/utils';

/**
 * Primary navigation: six groups, with the pages of the one you are in.
 *
 * It used to render all twenty-one pages at once under labelled headings. The
 * headings gave it a reading order but not a size — every page was still on
 * screen, so the sidebar was a directory to be searched rather than a place to
 * be. The review named it directly: too many tabs.
 *
 * Now a group's pages appear only while you are inside it, which is the only
 * time they answer anything. At rest that is six links instead of twenty-one;
 * in context it is six plus the three or four that are actually relevant.
 *
 * Nothing moved. Every page kept its URL, so every link, bookmark and redirect
 * elsewhere in the app still resolves.
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

  const current = pending ?? pathname;
  const openGroup = groupForPath(current);

  /**
   * Warm the route on intent rather than on click.
   *
   * Dashboard routes are `force-dynamic`, so Next's automatic prefetch only
   * fetches the loading skeleton. Starting the real render when the pointer
   * arrives buys the server the ~200ms between hover and click — usually
   * enough that the page is already in the Router Cache by the time it is
   * needed. `router.prefetch` de-duplicates, so re-hovering is free.
   */
  const warm = (href: string) => ({
    onMouseEnter: () => router.prefetch(href),
    onFocus: () => router.prefetch(href),
    onTouchStart: () => router.prefetch(href),
  });

  const go = (href: string) => () => {
    setPending(href);
    onNavigate?.();
  };

  /** A page is current only on an exact match or a sub-route of it. */
  const isCurrent = (item: NavItem) =>
    item.href === '/dashboard'
      ? current === '/dashboard'
      : current === item.href || current.startsWith(`${item.href}/`);

  return (
    <nav className="flex flex-1 flex-col gap-1 px-3 py-4" aria-label="Primary">
      {navByGroup().map((group) => {
        const open = group.id === openGroup;
        // A group of one (nothing to expand into) is just that page's link.
        const single = group.items.length === 1 ? group.items[0]! : null;
        const groupHref = single ? single.href : group.href;
        const groupActive = open && (single ? true : !group.items.some(isCurrent));

        return (
          <div key={group.id} className="flex flex-col gap-1">
            <Link
              href={groupHref}
              onClick={go(groupHref)}
              {...warm(groupHref)}
              aria-current={open && groupActive ? 'page' : undefined}
              // The one-line "what you get" was written for every page and
              // rendered nowhere. Hovering is exactly when someone asks what
              // this one is for.
              title={group.description}
              className={cn(
                'group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                open
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                groupActive && 'bg-primary/10 text-primary',
              )}
            >
              <group.icon
                className={cn(
                  'h-4 w-4 shrink-0',
                  groupActive
                    ? 'text-primary'
                    : open
                      ? 'text-foreground'
                      : 'text-muted-foreground group-hover:text-foreground',
                )}
                aria-hidden
              />
              <span className="flex-1 truncate">{group.label}</span>
            </Link>

            {/* The group's pages, only while you are in it. */}
            {open && !single && (
              <div className="mb-1 ml-4 flex flex-col gap-0.5 border-l border-border pl-2">
                {group.items.map((item) => {
                  const active = isCurrent(item);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={go(item.href)}
                      {...warm(item.href)}
                      aria-current={active ? 'page' : undefined}
                      title={item.description}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors',
                        active
                          ? 'bg-primary/10 font-medium text-primary'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
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
            )}
          </div>
        );
      })}
    </nav>
  );
}
