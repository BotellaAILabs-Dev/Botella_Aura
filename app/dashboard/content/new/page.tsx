import { Suspense } from 'react';
import type { Metadata } from 'next';

import { requireUser } from '@/lib/auth-helpers';
import { resolveActiveCompany } from '@/lib/active-company';
import { getEnabledContentTypes } from '@/server/company/profile.service';
import { getCreation } from '@/server/recommendations/creation.service';
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
export default async function NewFromSourcePage({
  searchParams,
}: {
  searchParams: { rec?: string };
}) {
  const user = await requireUser();
  const { active } = await resolveActiveCompany(user.id);
  if (!active) return null;

  // `?rec=`: written for an Aura recommendation — the brief comes from its
  // Context Handoff (lib/recommendation-context-handoff.ts), with what is
  // missing stated rather than filled in; whether it can be written from at
  // all comes from lib/recommendation-creation.ts.
  const [types, creation] = await Promise.all([
    getEnabledContentTypes(active.id),
    searchParams.rec
      ? getCreation(active.id, searchParams.rec, 'content-studio')
      : null,
  ]);

  return (
    <Suspense>
      <NewContentForm
        types={types}
        handoff={creation?.handoff ?? null}
        creation={creation?.plan ?? null}
        recUnavailable={Boolean(searchParams.rec) && !creation}
      />
    </Suspense>
  );
}
