import { Suspense } from 'react';
import type { Metadata } from 'next';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getEnabledContentTypes } from '@/server/company/profile.service';
import { NewContentForm } from '@/components/dashboard/content/new-content-form';

export const metadata: Metadata = { title: 'Generate content' };
export const dynamic = 'force-dynamic';

/**
 * Server shell for the generate form.
 *
 * This page used to be a client component reading the full CONTENT_TYPES list
 * directly. It resolves the workspace's enabled formats here instead, so the
 * buttons are right on first paint rather than after a fetch — the form itself
 * stays a client component because it reads search params and posts.
 *
 * The Suspense boundary is required: useSearchParams opts its subtree into
 * client-side rendering, and Next will not build a server page containing one
 * without it.
 */
export default async function NewFromSourcePage() {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  const types = await getEnabledContentTypes(active.id);

  return (
    <Suspense>
      <NewContentForm types={types} />
    </Suspense>
  );
}
