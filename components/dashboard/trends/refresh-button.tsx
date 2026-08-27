'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import { useGenerationJob } from '@/components/dashboard/jobs/use-generation-job';
import { JobProgressBar } from '@/components/dashboard/jobs/job-progress';

/**
 * Manual "Refresh digest" trigger.
 *
 * Generation runs as a background job rather than inline: a digest fans out to
 * every configured source and makes two model calls, which regularly outlives
 * the platform's function budget. The user now watches named steps ("Scanning
 * Hacker News, r/SaaS…") instead of a spinner that cannot say whether anything
 * is happening.
 */
export function RefreshDigestButton({ firstRun = false }: { firstRun?: boolean }) {
  const router = useRouter();
  const { job, start, attach, running } = useGenerationJob('TREND_DIGEST', {
    onDone(finished) {
      if (finished.status !== 'SUCCEEDED') return;
      const count = Number(finished.result?.itemCount ?? 0);
      toast.success(
        count > 0
          ? `Digest updated — ${count} trend${count === 1 ? '' : 's'}.`
          : 'Digest refreshed. No new trends matched your settings yet.',
      );
      router.refresh();
    },
  });

  // A digest kicked off before a reload is still running server-side; pick the
  // progress back up rather than offering to start a second one.
  useEffect(() => {
    void attach();
  }, [attach]);

  return (
    <div className="space-y-2">
      <Button
        onClick={() => void start()}
        loading={running}
        variant={firstRun ? 'default' : 'outline'}
      >
        {firstRun ? (
          <>
            <Sparkles className="h-4 w-4" /> Generate first digest
          </>
        ) : (
          <>
            <RefreshCw className="h-4 w-4" /> Refresh
          </>
        )}
      </Button>
      <JobProgressBar
        job={job}
        runningLabel="Building your trend digest"
        onRetry={() => void start()}
      />
    </div>
  );
}
