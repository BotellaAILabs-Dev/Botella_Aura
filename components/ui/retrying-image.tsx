'use client';

import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { ImageOff, RotateCw } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * An image that does not fail silently.
 *
 * Generated graphics are served from our own API, freshly written to storage.
 * A preview requested a moment too early, a dropped connection, or a request
 * that raced a deploy all used to leave an empty box with no explanation —
 * the graphic existed, the user just never saw it. This retries a failed load
 * (twice, with a short pause, bypassing the cached failure), and only then
 * shows a clear "didn't load" state with a button to try again.
 *
 * A plain <img>, like the call sites it replaces: these bytes are session-
 * gated, and next/image's optimiser fetches server-side without the cookie.
 */
export function RetryingImage({
  src,
  className,
  retries = 2,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { src: string; retries?: number }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // A new image starts clean.
  useEffect(() => {
    setAttempt(0);
    setFailed(false);
  }, [src]);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (failed) {
    return (
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-1.5 bg-muted p-2 text-center text-xs text-muted-foreground',
          className,
        )}
        role="img"
        aria-label="Preview did not load"
      >
        <ImageOff className="h-4 w-4" aria-hidden />
        <span>Preview didn’t load</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          onClick={(e) => {
            // Inside clickable tiles: retry, do not select.
            e.stopPropagation();
            setFailed(false);
            setAttempt((a) => a + 1);
          }}
        >
          <RotateCw className="h-3 w-3" aria-hidden /> Retry
        </button>
      </div>
    );
  }

  // Each retry is a distinct URL, so the browser does not serve the failure
  // from cache. The first load uses the plain URL, which stays cacheable.
  const url =
    attempt === 0
      ? src
      : `${src}${src.includes('?') ? '&' : '?'}r=${attempt}`;

  return (
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img
      {...rest}
      src={url}
      className={className}
      onError={() => {
        if (attempt < retries) {
          timer.current = setTimeout(
            () => setAttempt((a) => a + 1),
            700 * (attempt + 1),
          );
        } else {
          setFailed(true);
        }
      }}
    />
  );
}
