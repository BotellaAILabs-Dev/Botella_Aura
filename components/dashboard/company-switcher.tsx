'use client';

import { useRouter } from 'next/navigation';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getInitials } from '@/lib/utils';
import { ACTIVE_COMPANY_COOKIE } from '@/lib/cookies';
import type { CompanySummary } from '@/types';

/**
 * Topbar company switcher. Writes the active-company cookie and refreshes so
 * server components re-render for the selected tenant. Shown even with a single
 * company (as a workspace label); the dropdown offers switching + create.
 */
export function CompanySwitcher({
  companies,
  activeId,
}: {
  companies: CompanySummary[];
  activeId: string | null;
}) {
  const router = useRouter();
  const active = companies.find((c) => c.id === activeId) ?? companies[0];
  if (!active) return null;

  function select(id: string) {
    // 1 year, root path. Server reads this via resolveActiveCompany().
    document.cookie = `${ACTIVE_COMPANY_COOKIE}=${id}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex max-w-[220px] items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Switch company"
      >
        <Avatar className="h-6 w-6 rounded-md">
          {active.logoUrl && <AvatarImage src={active.logoUrl} alt="" />}
          <AvatarFallback className="rounded-md text-[10px]">
            {getInitials(active.name)}
          </AvatarFallback>
        </Avatar>
        <span className="truncate">{active.name}</span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {companies.map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => select(c.id)}>
            <Avatar className="h-6 w-6 rounded-md">
              {c.logoUrl && <AvatarImage src={c.logoUrl} alt="" />}
              <AvatarFallback className="rounded-md text-[10px]">
                {getInitials(c.name)}
              </AvatarFallback>
            </Avatar>
            <span className="flex-1 truncate">{c.name}</span>
            {c.id === active.id && <Check className="h-4 w-4 text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push('/onboarding?new=1')}>
          <Plus className="h-4 w-4" />
          <span>Create workspace</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
