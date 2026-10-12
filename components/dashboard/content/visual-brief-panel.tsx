import Link from 'next/link';
import { AlertTriangle, ImageIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { VisualBrief } from '@/lib/visual-brief';

/**
 * What the image is for (lib/visual-brief.ts), above the graphic studio:
 * whether this format needs one, the idea and product it shows, the brand's
 * palette, the channel's shape — and what is missing, with where to add it.
 */
const NEED: Record<
  VisualBrief['need'],
  { label: string; variant: 'destructive' | 'secondary' | 'muted' }
> = {
  required: { label: 'Image required', variant: 'destructive' },
  recommended: { label: 'Image recommended', variant: 'secondary' },
  none: { label: 'No image needed', variant: 'muted' },
};

export function VisualBriefPanel({
  brief: v,
  fromRecommendation,
  hasImage,
}: {
  brief: VisualBrief;
  /** Built from the recommendation's brief (else from the business context). */
  fromRecommendation: boolean;
  /** An image is already attached. */
  hasImage: boolean;
}) {
  const need = NEED[v.need];
  return (
    <Card>
      <CardContent className="space-y-2 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <ImageIcon className="h-4 w-4 text-primary" aria-hidden />
          <span className="font-medium text-foreground">Visual brief</span>
          <Badge variant={need.variant}>{need.label}</Badge>
          {v.need === 'required' && !hasImage && (
            <span className="text-xs text-foreground">— none attached yet</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {v.why}{' '}
          {fromRecommendation
            ? 'Built from the suggestion this was written for.'
            : 'Built from your business details and this post.'}
        </p>
        {v.need !== 'none' && (
          <div className="space-y-1 text-xs text-muted-foreground">
            {v.subject && (
              <p>
                <span className="font-medium text-foreground/80">Shows:</span>{' '}
                {v.subject.value}
              </p>
            )}
            {v.product && (
              <p>
                <span className="font-medium text-foreground/80">Product:</span>{' '}
                {v.product.value}
              </p>
            )}
            {v.audience && (
              <p>
                <span className="font-medium text-foreground/80">For:</span>{' '}
                {v.audience}
              </p>
            )}
            {v.brand.palette.length > 0 && (
              <p className="flex flex-wrap items-center gap-1">
                <span className="font-medium text-foreground/80">Palette:</span>
                {v.brand.palette.map((c) => (
                  <span
                    key={c}
                    className="inline-block h-3.5 w-3.5 rounded-full border border-border"
                    style={{ backgroundColor: c }}
                    title={c}
                    aria-label={c}
                  />
                ))}
              </p>
            )}
            <p>
              <span className="font-medium text-foreground/80">Shape:</span>{' '}
              {`${v.format.aspectRatio} · ${v.format.width}×${v.format.height}${
                v.format.channel ? ` for ${v.format.channel}` : ''
              }`}
            </p>
          </div>
        )}
        {v.missing.length > 0 && (
          <ul className="space-y-1">
            {v.missing.map((m) => (
              <li
                key={m.field}
                className="flex gap-1.5 text-xs text-muted-foreground"
              >
                <AlertTriangle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600"
                  aria-hidden
                />
                <span>
                  {m.whenMissing}{' '}
                  {m.fix && (
                    <Link
                      href={m.fix.href}
                      className="text-primary hover:underline"
                    >
                      {m.fix.label}
                    </Link>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {v.need !== 'none' && (
          <p className="text-xs text-muted-foreground">
            If an image fails to generate, your post is unaffected — edit it,
            try again, or try another model.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
