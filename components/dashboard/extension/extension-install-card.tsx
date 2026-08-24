import { Download, Puzzle, ShieldCheck } from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export interface ExtensionBuildInfo {
  version: string;
  bytes: number;
  sha256Prefix: string;
}

/**
 * Download + sideload instructions for the companion extension.
 *
 * The extension is not on the Chrome Web Store yet (that needs the client's own
 * Google developer account and Google's review), but "not on the store" is not
 * the same as "untestable". This ships the exact build the app was deployed
 * with as a downloadable zip, so it can be installed and tested end-to-end in
 * about a minute.
 */
export function ExtensionInstallCard({
  build,
  appUrl,
}: {
  build: ExtensionBuildInfo | null;
  appUrl: string;
}) {
  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Puzzle className="h-5 w-5 text-primary" />
            <div>
              <CardTitle className="text-base">Install the extension</CardTitle>
              <CardDescription>
                Load it unpacked in Chrome or Edge — no store listing required.
              </CardDescription>
            </div>
          </div>
          {build && (
            <Badge variant="muted" title={`Build ${build.sha256Prefix}`}>
              v{build.version} · {Math.round(build.bytes / 1024)} KB
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {build ? (
          <Button asChild>
            <a href="/downloads/botella-aura-extension.zip" download>
              <Download className="h-4 w-4" /> Download extension (.zip)
            </a>
          </Button>
        ) : (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-muted-foreground">
            The packaged build isn&apos;t available on this deployment. Run{' '}
            <span className="font-mono">pnpm ext:package</span> (it also runs
            automatically during <span className="font-mono">pnpm build</span>) and
            redeploy, or load the <span className="font-mono">extension/</span>{' '}
            folder from the repository directly.
          </p>
        )}

        <ol className="ml-5 list-decimal space-y-1.5 text-muted-foreground">
          <li>Download and unzip the file above.</li>
          <li>
            Open <span className="font-mono">chrome://extensions</span> (or{' '}
            <span className="font-mono">edge://extensions</span>).
          </li>
          <li>
            Turn on <span className="font-medium text-foreground">Developer mode</span>{' '}
            (top right).
          </li>
          <li>
            Click{' '}
            <span className="font-medium text-foreground">Load unpacked</span> and
            select the unzipped folder.
          </li>
          <li>
            Come back here and press{' '}
            <span className="font-medium text-foreground">Send to extension</span> on
            a fresh pairing token below.
          </li>
        </ol>

        <div className="rounded-md border border-border bg-muted/30 p-3 text-muted-foreground">
          <p>
            This build talks to{' '}
            <span className="font-mono text-foreground">{appUrl}</span>. Pairing from
            this page sets that automatically. For a custom domain the browser may
            ask for permission — open the extension popup, expand{' '}
            <span className="font-medium text-foreground">Advanced</span> and press{' '}
            <span className="font-medium text-foreground">Grant access to this URL</span>.
          </p>
        </div>

        <p className="flex items-start gap-2 text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          The extension never posts, connects, or messages on its own. Every action
          is one deliberate click by you, capped at a healthy daily and hourly rate.
        </p>
      </CardContent>
    </Card>
  );
}
