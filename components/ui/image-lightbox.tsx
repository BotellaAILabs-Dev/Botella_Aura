'use client';

import { useCallback, useEffect, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, Download, Loader2, X } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * A full-screen preview for images (Content Studio's generated graphics,
 * versions and creatives).
 *
 * Built on the same Radix dialog as the rest of the app, which brings Escape
 * to close, focus trapping and background-scroll locking. The image is shown
 * whole — `object-contain`, never cropped — at the largest size the screen
 * allows, from its full-resolution URL. Several images: previous / next
 * buttons and the arrow keys move between them.
 */

export interface LightboxImage {
  /** Full-resolution URL. */
  src: string;
  alt: string;
  width?: number;
  height?: number;
  /** File name for Download. */
  downloadName?: string;
  /** A short line under the image ("Version 2 · Refined"). */
  caption?: string;
}

interface Props {
  images: LightboxImage[];
  /** The image shown; null when closed. */
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

export function ImageLightbox({ images, index, onIndexChange, onClose }: Props) {
  const open = index !== null && images.length > 0;
  const i = open ? Math.min(Math.max(index, 0), images.length - 1) : 0;
  const image = open ? images[i]! : null;
  const many = images.length > 1;
  // Which image has finished loading (or failed) — per source, so a cached
  // image that loads before any effect runs is never mistaken for loading.
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const state: 'loading' | 'loaded' | 'error' = !image
    ? 'loading'
    : failed === image.src
      ? 'error'
      : loaded === image.src
        ? 'loaded'
        : 'loading';
  // An image already in the browser's cache may be complete before React
  // attaches onLoad: count it as loaded the moment it mounts.
  const imgRef = useCallback((el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth > 0) setLoaded(el.getAttribute('src'));
  }, []);

  // Warm the neighbours, so stepping through is instant.
  useEffect(() => {
    if (!open || !many || typeof window === 'undefined') return;
    for (const n of [i - 1, i + 1]) {
      const next = images[(n + images.length) % images.length];
      if (next) new window.Image().src = next.src;
    }
  }, [open, many, i, images]);

  const go = useCallback(
    (step: number) => {
      if (!many) return;
      onIndexChange((i + step + images.length) % images.length);
    },
    [i, many, images.length, onIndexChange],
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          // Anywhere but the image or a control counts as "outside the image"
          // (the space around it, the bars above and below).
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest('img, button, a')) onClose();
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') {
              e.preventDefault();
              go(1);
            } else if (e.key === 'ArrowLeft') {
              e.preventDefault();
              go(-1);
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            {image ? `Image preview${many ? `, ${i + 1} of ${images.length}` : ''}: ${image.alt}` : 'Image preview'}
          </DialogPrimitive.Title>

          {/* Top bar: position, download, close. */}
          <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-3 text-white sm:px-5">
            <span className="text-sm tabular-nums text-white/80" aria-hidden>
              {many ? `${i + 1} / ${images.length}` : ''}
            </span>
            <div className="flex items-center gap-1">
              {image && (
                <a
                  href={image.src}
                  download={image.downloadName ?? ''}
                  className="inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-white/90 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  <Download className="h-4 w-4" aria-hidden />
                  <span className="hidden sm:inline">Download</span>
                  <span className="sr-only sm:hidden">Download image</span>
                </a>
              )}
              <DialogPrimitive.Close
                aria-label="Close preview"
                className="inline-flex h-10 w-10 items-center justify-center rounded-md text-white/90 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <X className="h-5 w-5" aria-hidden />
              </DialogPrimitive.Close>
            </div>
          </div>

          {/* The image area. */}
          <div
            className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-2 sm:px-16 sm:pb-6"
            data-testid="lightbox-backdrop"
          >
            {image && (
              <>
                {state === 'loading' && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
                    <Loader2 className="h-8 w-8 animate-spin text-white/80" aria-hidden />
                    <span className="sr-only">Loading image…</span>
                  </div>
                )}
                {state === 'error' ? (
                  <p className="rounded-md bg-white/10 px-4 py-3 text-sm text-white">This image could not be loaded. Close and try again.</p>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- private, session-gated bytes (and data: URIs); next/image would fetch them without the session.
                  <img
                    key={image.src}
                    ref={imgRef}
                    src={image.src}
                    alt={image.alt}
                    width={image.width}
                    height={image.height}
                    decoding="async"
                    onLoad={() => setLoaded(image.src)}
                    onError={() => setFailed(image.src)}
                    className={cn(
                      'h-auto max-h-full w-auto max-w-full select-none rounded-md object-contain shadow-2xl transition-opacity duration-200',
                      state === 'loaded' ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                )}
              </>
            )}

            {many && (
              <>
                <button
                  type="button"
                  onClick={() => go(-1)}
                  aria-label="Previous image"
                  className="absolute left-1 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-slate-950/50 text-white hover:bg-slate-950/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:left-3"
                >
                  <ChevronLeft className="h-6 w-6" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => go(1)}
                  aria-label="Next image"
                  className="absolute right-1 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-slate-950/50 text-white hover:bg-slate-950/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:right-3"
                >
                  <ChevronRight className="h-6 w-6" aria-hidden />
                </button>
              </>
            )}
          </div>

          {image?.caption && (
            <p className="shrink-0 px-4 pb-4 text-center text-sm text-white/80">{image.caption}</p>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
