'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toLocalInput } from '@/lib/timezone';
import { CalendarClock, ListPlus, AlertTriangle, ImageOff, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from '@/components/ui/toaster';
import {
  platformSpec,
  type SocialPlatformKey,
} from '@/lib/platforms';
import { aspectClass, formatFileSize } from '@/lib/graphics-ui';

/**
 * Post composer — content + graphic + platform + schedule, as one post.
 *
 * This is the step between "I have a draft and a picture" and "it is in the
 * queue". It exists as its own card because the decision it captures (where
 * this goes and when) is genuinely separate from writing the copy or making the
 * image, and because it is where a platform mismatch has to be visible: a
 * graphic that is fine for LinkedIn and wrong for Instagram should say so HERE,
 * not silently fail at publish time.
 *
 * "Add to queue" sets platform + time and submits for approval. It does not
 * approve — the human approval gate is untouched.
 */
export interface ComposerMedia {
  id: string;
  assetId: string;
  url: string;
  width: number;
  height: number;
  mimeType: string;
  fileSize: number;
  aspectRatio: string;
  altText: string | null;
  problems: string[];
}

interface Props {
  draftId: string;
  status: string;
  contentPreview: string;
  platform: SocialPlatformKey;
  /** Platforms this content type can sensibly target. */
  platformOptions: SocialPlatformKey[];
  media: ComposerMedia[];
  scheduledFor: string | null;
  /** The workspace timezone the schedule is picked and shown in. */
  timeZone?: string;
  canEdit: boolean;
}

export function PostComposer({
  draftId,
  status,
  contentPreview,
  platform: initialPlatform,
  platformOptions,
  media,
  scheduledFor,
  canEdit,
  timeZone = 'UTC',
}: Props) {
  const router = useRouter();
  const [platform, setPlatform] = useState<SocialPlatformKey>(initialPlatform);
  const [when, setWhen] = useState(toLocalInput(scheduledFor, timeZone));
  const [busy, setBusy] = useState(false);

  const spec = platformSpec(platform);

  // Media problems are computed server-side against the CURRENT platform. The
  // selector saves immediately (see retarget below) and refreshes, but the
  // warning is recomputed client-side from the same rules so the feedback lands
  // on the change rather than a round-trip later.
  const platformChanged = platform !== initialPlatform;
  const problems = platformChanged
    ? media.flatMap((m) => localProblems(m, platform))
    : media.flatMap((m) => m.problems);

  /**
   * Persist the platform as soon as it is chosen.
   *
   * The Graphic Studio above generates for the draft's SAVED platform — its art
   * direction and default format both depend on it. Deferring this to "Add to
   * queue" would mean picking Instagram and then generating a LinkedIn-shaped
   * graphic, which is exactly the mismatch this card exists to prevent.
   */
  async function retarget(next: SocialPlatformKey) {
    const previous = platform;
    setPlatform(next); // optimistic — the selector must not feel laggy
    const res = await fetch(`/api/content/drafts/${draftId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: next }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setPlatform(previous);
      toast.error(body.error ?? 'Could not change the platform.');
      return;
    }
    router.refresh();
  }

  const missingMedia = spec.requiresMedia && media.length === 0;
  const blocked = missingMedia || problems.length > 0;

  async function addToQueue() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/content/drafts/${draftId}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          // A wall time in the workspace's timezone (converted on the server).
          ...(when ? { localTime: when, timeZone } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? 'Could not add this post to the queue.');
        return;
      }
      const data = (await res.json()) as { status: string };
      toast.success(
        data.status === 'PENDING_APPROVAL'
          ? 'Added to the queue — it is now waiting for approval.'
          : 'Queue updated.',
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function detach(assetId: string) {
    const res = await fetch(`/api/content/graphics/${assetId}/attach`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(body.error ?? 'Could not remove that graphic.');
      return;
    }
    toast.success('Graphic removed from this post.');
    router.refresh();
  }

  const selectCls =
    'h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Post preview</h2>
          <Badge variant="outline" style={{ borderColor: spec.color }}>
            {spec.label}
          </Badge>
        </div>

        {/* ---- What will go out ---- */}
        <div className="rounded-md border border-border bg-muted/20 p-3">
          <p className="line-clamp-4 whitespace-pre-wrap text-sm text-foreground">
            {contentPreview}
          </p>

          {media.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {media.map((m) => (
                <div key={m.id} className="relative">
                  <div
                    className={`w-24 overflow-hidden rounded-md border border-border ${aspectClass(
                      m.aspectRatio,
                    )}`}
                  >
                    {m.mimeType.startsWith('video/') ? (
                      <video
                        src={m.url}
                        className="h-full w-full object-cover"
                        muted
                        playsInline
                        preload="metadata"
                        aria-label="Attached video"
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={m.url}
                        alt={m.altText ?? 'Attached graphic'}
                        className="h-full w-full object-cover"
                        loading="lazy"
                        decoding="async"
                        width={m.width}
                        height={m.height}
                      />
                    )}
                  </div>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => detach(m.assetId)}
                      title="Remove from post"
                      aria-label="Remove graphic from post"
                      className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground shadow-sm hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {m.width}×{m.height} · {formatFileSize(m.fileSize)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        {missingMedia && (
          <Notice
            icon={ImageOff}
            title={`${spec.label} posts need an image`}
            body="Generate a graphic above and attach it before adding this to the queue."
          />
        )}

        {problems.length > 0 && (
          <Notice
            icon={AlertTriangle}
            title={`This graphic isn't valid for ${spec.label}`}
            body={problems.join(' ')}
          />
        )}

        {/* ---- Where and when ---- */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="composer-platform">Platform</Label>
            <select
              id="composer-platform"
              className={selectCls}
              value={platform}
              onChange={(e) => retarget(e.target.value as SocialPlatformKey)}
              disabled={!canEdit || platformOptions.length < 2}
            >
              {platformOptions.map((option) => (
                <option key={option} value={option}>
                  {platformSpec(option).label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Graphics are generated for this platform&apos;s format and style.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="composer-when">
              Schedule (optional) <span className="font-normal text-muted-foreground">— {timeZone} time</span>
            </Label>
            <input
              id="composer-when"
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              disabled={!canEdit}
              className={selectCls}
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to queue it for review without a set time.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button onClick={addToQueue} loading={busy} disabled={!canEdit || blocked}>
            <ListPlus className="h-4 w-4" /> Add to queue
          </Button>
          {status === 'PENDING_APPROVAL' && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" />
              In the queue, waiting for approval.
            </span>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Adding to the queue submits this post for approval. Nothing publishes
          until someone approves it.
        </p>
      </CardContent>
    </Card>
  );
}

function Notice({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof AlertTriangle;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-foreground/70" />
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

/**
 * Re-check a graphic against a platform the user has just selected but not yet
 * saved.
 *
 * Mirrors server/media/validate.ts deliberately: this is a preview so the
 * warning appears the moment the selector moves, and the server still runs the
 * authoritative check before anything is queued or published.
 */
function localProblems(
  media: ComposerMedia,
  platform: SocialPlatformKey,
): string[] {
  const spec = platformSpec(platform);
  const problems: string[] = [];
  // Video: Instagram only (length and format are checked on the server).
  if (media.mimeType.startsWith('video/')) {
    return platform === 'INSTAGRAM' ? [] : [`Aura publishes video to Instagram only — post the video to ${spec.label} by hand.`];
  }
  if (!spec.acceptedMimeTypes.includes(media.mimeType)) {
    problems.push(
      `${spec.label} does not accept ${media.mimeType} (it takes ${spec.acceptedMimeTypes.join(', ')}).`,
    );
  }
  if (media.fileSize > spec.maxFileSizeBytes) {
    problems.push(
      `The image is ${formatFileSize(media.fileSize)}; ${spec.label} allows up to ${formatFileSize(
        spec.maxFileSizeBytes,
      )}.`,
    );
  }
  if (Math.min(media.width, media.height) < spec.minDimension) {
    problems.push(
      `${spec.label} wants at least ${spec.minDimension}px on the short edge.`,
    );
  }
  if (Math.max(media.width, media.height) > spec.maxDimension) {
    problems.push(`${spec.label} caps the long edge at ${spec.maxDimension}px.`);
  }
  return problems;
}


