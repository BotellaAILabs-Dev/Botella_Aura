import {
  SkeletonPageHeader,
  SkeletonCard,
  SkeletonRows,
} from '@/components/ui/skeleton';

/**
 * Route-level loading UI for every page under /dashboard.
 *
 * Every dashboard route is `force-dynamic` and loads its data in the server
 * component body. Without a loading boundary, the App Router has nothing to
 * show while that work runs, so a navigation blocks: the browser stays on the
 * previous page, the click produces no visible response, and the app reads as
 * frozen for as long as the slowest query takes. That delay is the "buttons
 * respond a second late" symptom — the click *was* handled, it just had
 * nothing to paint.
 *
 * With this file, Next streams the shell immediately and swaps in the real
 * page when the data lands. It does not make the queries faster; it makes the
 * navigation instant, which is the part a person actually feels.
 *
 * Nested routes can override this with their own loading.tsx where a more
 * specific shape helps. This is the shared fallback for the rest.
 */
export default function DashboardLoading() {
  return (
    <div>
      <SkeletonPageHeader />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SkeletonCard lines={3} />
        <SkeletonCard lines={3} />
        <SkeletonCard lines={3} />
      </div>
      <div className="mt-6">
        <SkeletonRows rows={5} />
      </div>
    </div>
  );
}
