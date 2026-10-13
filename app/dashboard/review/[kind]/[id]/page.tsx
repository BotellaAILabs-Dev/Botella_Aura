import { notFound } from 'next/navigation';
import type { Metadata } from 'next';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getMembership } from '@/server/services/company.service';
import { getReviewItem } from '@/server/review/review-item.service';
import { ReviewScreen } from '@/components/dashboard/review/review-screen';

export const metadata: Metadata = { title: 'Review' };
export const dynamic = 'force-dynamic';

/** The unified review screen for one item of generated work (lib/review-item.ts). */
export default async function ReviewItemPage({
  params,
}: {
  params: { kind: string; id: string };
}) {
  if (params.kind !== 'content' && params.kind !== 'outreach') notFound();
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;
  const membership = await getMembership(user.id, active.id);
  if (!membership) notFound();
  const item = await getReviewItem(
    params.kind,
    active.id,
    params.id,
    membership.role,
  );
  if (!item) notFound();
  return <ReviewScreen item={item} />;
}
