import type { Metadata } from 'next';

import { Logo } from '@/components/brand/logo';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { deletionProcessed } from '@/server/connectors/meta.service';

export const metadata: Metadata = { title: 'Data deletion status', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * Where Meta sends people to check a data-deletion request (the URL returned
 * by /api/meta/data-deletion). Public, read-only: says whether the request
 * with this confirmation code was processed, and nothing else.
 */
export default async function DataDeletionStatus({ searchParams }: { searchParams: { code?: string } }) {
  const code = (searchParams.code ?? '').trim();
  const done = code ? await deletionProcessed(code) : false;
  return (
    <div className="aura-gradient flex min-h-screen flex-col">
      <header className="mx-auto w-full max-w-6xl px-6 py-6">
        <Logo />
      </header>
      <main className="flex flex-1 items-center justify-center px-6 pb-16">
        <Card className="w-full max-w-md shadow-lg">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">Facebook data deletion</CardTitle>
            <CardDescription>Confirmation code: {code || '—'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-foreground">
            {done ? (
              <p>
                This request has been processed. Botella Aura has deleted the Facebook and Instagram
                connection data linked to your Facebook account: access tokens and the Page and
                Instagram account ids. Content your business created in Aura is not Facebook data and
                is managed by your business in Aura.
              </p>
            ) : (
              <p>We have no processed request with this code. Check the code, or contact the business that connected Aura to Facebook.</p>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
