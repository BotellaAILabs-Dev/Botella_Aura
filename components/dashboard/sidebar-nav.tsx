'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS } from '@/lib/nav';
import { cn } from '@/lib/utils';

/**
 * Sidebar navigation links. Marks the active route, and tags not-yet-shipped
 * features with a subtle "Sprint N" chip so the roadmap is visible in-product.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-1 flex-col gap-1 px-3 py-4" aria-label="Primary">
      {NAV_ITEMS.map((item) => {
        const active =
          item.href === '/dashboard'
            ? pathname === '/dashboard'
            : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
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
            {!item.ready && item.sprint && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                S{item.sprint}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
