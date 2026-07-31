import { Lock } from 'lucide-react';
import { PageHeader } from '@/components/dashboard/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { findNavItem } from '@/lib/nav';

/**
 * Placeholder page for a feature that isn't live yet. Reads its copy from the
 * central nav config; a feature only needs its `ready` flag flipped (and a real
 * page dropped in) to replace this.
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
        actions={<Badge variant="secondary">Coming soon</Badge>}
      />
      <EmptyState
        icon={Icon}
        title={`${title} is on the way`}
        description="We've reserved its place in the product so your workflow won't change when it arrives."
      />
    </div>
  );
}
