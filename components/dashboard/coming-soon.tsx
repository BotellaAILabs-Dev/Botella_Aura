import { Lock } from 'lucide-react';
import { PageHeader } from '@/components/dashboard/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { findNavItem } from '@/lib/nav';

/**
 * Placeholder page for features that ship in a later sprint. Reads its copy
 * from the central nav config so a feature only needs its `ready` flag flipped
 * (and a real page dropped in) when the sprint lands.
 */
export function ComingSoon({ href }: { href: string }) {
  const item = findNavItem(href);
  const title = item?.label ?? 'Coming soon';
  const Icon = item?.icon ?? Lock;

  return (
    <div>
      <PageHeader
        title={title}
        description={item?.description}
        actions={
          item?.sprint ? (
            <Badge variant="secondary">Sprint {item.sprint}</Badge>
          ) : null
        }
      />
      <EmptyState
        icon={Icon}
        title={`${title} is on the way`}
        description={
          item?.sprint
            ? `This feature ships in Sprint ${item.sprint}. We've reserved its place in the product so your workflow won't change when it arrives.`
            : 'This feature is coming in a future sprint.'
        }
      />
    </div>
  );
}
