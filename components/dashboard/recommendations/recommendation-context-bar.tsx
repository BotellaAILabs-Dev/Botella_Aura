'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, Sparkles, X } from 'lucide-react';

import { moduleForPath } from '@/lib/aura-modules';
import type { RecommendationContext } from '@/lib/recommendation-context';

/**
 * The recommendation a person is working on, kept in view as they move
 * between Aura's modules (lib/aura-modules.ts).
 *
 * Opening any module with `?rec=<id>` loads the recommendation's context and
 * remembers it for this browser tab, so moving on to Competitors, Lead
 * discovery or Content Studio — with or without the parameter — keeps it in
 * view, with what to do in the module they are in and where else helps. It
 * goes when they dismiss it, or start working on another recommendation.
 */

const STORAGE_KEY = 'aura:recommendation-context';
/** How long a remembered context stays without being reopened. */
const KEEP_MS = 12 * 60 * 60 * 1000;
/** Pages where the recommendation is already in front of the person. */
const HIDDEN_ON = ['/dashboard', '/dashboard/suggestions'];

function remember(ctx: RecommendationContext | null) {
  try {
    if (ctx) {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ savedAt: Date.now(), ctx }),
      );
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage unavailable (private mode): the bar still works for this page.
  }
}

function recall(): RecommendationContext | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { savedAt, ctx } = JSON.parse(raw) as {
      savedAt: number;
      ctx: RecommendationContext;
    };
    return Date.now() - savedAt < KEEP_MS ? ctx : null;
  } catch {
    return null;
  }
}

export function RecommendationContextBar() {
  const pathname = usePathname();
  const params = useSearchParams();
  const rec = params.get('rec');
  const [ctx, setCtx] = useState<RecommendationContext | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!rec) {
      setCtx(recall());
      return;
    }
    const known = recall();
    if (known?.id === rec) setCtx(known);
    void fetch(`/api/recommendations/${encodeURIComponent(rec)}/context`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          // Not this workspace's, or gone: forget it rather than show it.
          if (known?.id === rec) remember(null);
          setCtx(known?.id === rec ? null : known);
          return;
        }
        const { context } = (await res.json()) as {
          context: RecommendationContext;
        };
        remember(context);
        setCtx(context);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [rec]);

  if (!ctx || HIDDEN_ON.includes(pathname)) return null;

  const here = moduleForPath(pathname);
  const destinations = [ctx.primary, ...ctx.related];
  const current = destinations.find((d) => d.module === here) ?? null;
  const elsewhere = destinations.filter((d) => d.module !== here);

  return (
    <aside
      aria-label="The suggestion you are working on"
      className="mb-5 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-x-1.5 font-medium text-foreground">
            <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <span className="text-muted-foreground">
              Working on Aura’s suggestion:
            </span>
            <span>{ctx.title}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80">Goal:</span>{' '}
            {ctx.expectedOutcome}
          </p>
          {!ctx.actionable ? (
            <p className="text-xs text-muted-foreground">
              This suggestion is {ctx.status.toLowerCase().replace('_', ' ')} —
              nothing more to do for it.
            </p>
          ) : (
            current && (
              <p className="text-xs text-foreground">
                <span className="font-medium">Here:</span> {current.hint}
              </p>
            )
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-xs">
            {ctx.actionable &&
              elsewhere.map((d) => (
                <Link
                  key={d.module}
                  href={d.href}
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                  title={d.hint}
                >
                  {d.module === ctx.primary.module ? d.verb : d.label}
                  <ArrowRight className="h-3 w-3" aria-hidden />
                </Link>
              ))}
            <Link
              href={ctx.backHref}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
            >
              <ArrowLeft className="h-3 w-3" aria-hidden /> Back to the
              suggestion
            </Link>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            remember(null);
            setCtx(null);
          }}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Stop showing this suggestion"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}
