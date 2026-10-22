'use client';

import { useState } from 'react';
import { Check, Download, Layers, RotateCcw, Stamp, Wand2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RetryingImage } from '@/components/ui/retrying-image';
import { Textarea } from '@/components/ui/textarea';
import {
  LOGO_MODE_HINTS,
  LOGO_MODE_LABELS,
  LOGO_MODES,
  LOGO_POSITIONS,
  type LogoInfo,
  type LogoMode,
  type LogoPosition,
  type VariantInfo,
} from '@/lib/image-variants';

/**
 * One image variant: its versions side by side (original, refined,
 * regenerated, with or without the logo), and the actions that make its next
 * version. Nothing here changes another variant or the post's text, and no
 * version is ever overwritten — picking an earlier one is how to revert.
 */

export interface VariantVersion {
  id: string;
  url: string;
  provider: string;
  model: string;
  aspectRatio: string;
  width: number;
  height: number;
  mimeType: string;
  fileSize: number;
  createdAt: string;
  variant?: VariantInfo | null;
  logo?: LogoInfo | null;
  creative?: unknown;
}

const ACTION_LABEL: Record<string, string> = {
  generated: 'Original',
  refined: 'Refined',
  regenerated: 'Regenerated',
  logo: 'Logo change',
};

const EXAMPLES = [
  'Make the lighting warmer and the image more realistic.',
  'Change the background to a rustic wooden bar.',
  'Make it look less AI-generated, like professional product photography.',
];

export function ImageVariantPanel(props: {
  versions: VariantVersion[];
  selectedId: string;
  attached: Set<string>;
  canEdit: boolean;
  /** Another image job is running for this post. */
  busy: boolean;
  busyLabel: string | null;
  /** A configured model can refine images. */
  canRefine: boolean;
  /** The post has media and room for more (an Instagram carousel). */
  canAdd: boolean;
  onSelect: (id: string) => void;
  onAttach: (id: string) => void;
  onAdd: (id: string) => void;
  onRefine: (id: string, instruction: string) => void;
  onRegenerate: (id: string) => void;
  onLogo: (id: string, mode: LogoMode, position: LogoPosition) => void;
  /** Open the full-screen preview on this version, stepping through all of them. */
  onPreview?: (id: string, versions: VariantVersion[]) => void;
}) {
  const current = props.versions.find((v) => v.id === props.selectedId) ?? props.versions[props.versions.length - 1]!;
  const isCreative = Boolean(current.creative);
  const [instruction, setInstruction] = useState('');
  const [logoMode, setLogoMode] = useState<LogoMode>(current.logo?.mode ?? 'none');
  const [position, setPosition] = useState<LogoPosition>(current.logo?.position ?? 'bottom-right');
  const isAttached = props.attached.has(current.id);
  const logo = current.logo ?? null;
  const logoChanged = logoMode !== (logo?.mode ?? 'none') || (logoMode !== 'none' && position !== (logo?.position ?? 'bottom-right'));

  return (
    <section className="space-y-4 border-t border-border pt-4" aria-label="Selected image and its versions">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">Selected graphic</h3>
        <Badge variant="muted">
          {props.versions.length} version{props.versions.length === 1 ? '' : 's'}
        </Badge>
        {logo && (
          <Badge variant={logo.mode === 'include' && !logo.applied ? 'warning' : 'outline'}>
            {logo.mode === 'include' ? (logo.applied ? 'Logo placed' : 'Logo not placed') : LOGO_MODE_LABELS[logo.mode]}
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <div className={`w-full max-w-[18rem] shrink-0 overflow-hidden rounded-lg border border-border ${aspect(current.aspectRatio)}`}>
          <button
            type="button"
            onClick={() => props.onPreview?.(current.id, props.versions)}
            className="block h-full w-full cursor-zoom-in"
            aria-label="Open this image in a larger view"
          >
            <RetryingImage
              src={current.url}
              alt={`Version ${props.versions.indexOf(current) + 1} of this image`}
              className="h-full w-full object-cover"
              decoding="async"
              width={current.width}
              height={current.height}
            />
          </button>
        </div>
        <div className="min-w-0 flex-1 space-y-3 text-sm">
          <p className="text-muted-foreground">
            {current.width}×{current.height} · {current.provider} · {current.model}
          </p>
          {current.variant?.instruction && (
            <p className="break-words">
              <span className="text-muted-foreground">Refined with: </span>“{current.variant.instruction}”
            </p>
          )}
          {logo?.mode === 'include' && !logo.applied && logo.reason && (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">{logo.reason}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => props.onAttach(current.id)} disabled={!props.canEdit || isAttached || props.busy}>
              <Check aria-hidden /> {isAttached ? 'Used in post' : 'Use this image'}
            </Button>
            {props.canAdd && !isAttached && (
              <Button size="sm" variant="outline" onClick={() => props.onAdd(current.id)} disabled={!props.canEdit || props.busy}>
                <Layers aria-hidden /> Add to carousel
              </Button>
            )}
            {!isCreative && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => props.onRegenerate(current.id)}
                disabled={!props.canEdit || props.busy || current.provider === 'UPLOAD'}
                loading={props.busyLabel === 'regenerate'}
                title={current.provider === 'UPLOAD' ? 'An uploaded image cannot be regenerated — refine it instead.' : 'A new take on this image only'}
              >
                <RotateCcw aria-hidden /> Regenerate this image
              </Button>
            )}
            <Button asChild size="sm" variant="ghost">
              <a href={current.url} download>
                <Download aria-hidden /> Download
              </a>
            </Button>
          </div>
        </div>
      </div>

      {/* Versions: compare and go back. */}
      {props.versions.length > 1 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Versions — pick one to compare or go back to it</p>
          <ol className="flex gap-2 overflow-x-auto pb-1">
            {props.versions.map((v, i) => (
              <li key={v.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => props.onSelect(v.id)}
                  aria-pressed={v.id === current.id}
                  aria-label={`Version ${i + 1}: ${ACTION_LABEL[v.variant?.action ?? 'generated']}`}
                  className={`block w-20 overflow-hidden rounded-md border ${v.id === current.id ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-primary/50'}`}
                >
                  <span className={`block ${aspect(v.aspectRatio)}`}>
                    <RetryingImage src={v.url} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" width={v.width} height={v.height} />
                  </span>
                  <span className="block truncate px-1 py-0.5 text-[10px] text-muted-foreground">
                    V{i + 1} · {ACTION_LABEL[v.variant?.action ?? 'generated']}
                    {props.attached.has(v.id) ? ' ✓' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}

      {props.canEdit && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Refine with one instruction */}
          <form
            className="space-y-2 rounded-md border border-border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (instruction.trim().length >= 3) props.onRefine(current.id, instruction.trim());
            }}
          >
            <Label htmlFor={`refine-${current.id}`} className="flex items-center gap-1.5">
              <Wand2 className="h-4 w-4 text-primary" aria-hidden /> Edit / refine this image
            </Label>
            <Textarea
              id={`refine-${current.id}`}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="Describe every change in one instruction, e.g. “Move the glass to the right and leave space for a headline on the left.”"
              disabled={!props.canRefine || props.busy}
            />
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                  onClick={() => setInstruction(ex)}
                  disabled={!props.canRefine || props.busy}
                >
                  {ex}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              type="submit"
              loading={props.busyLabel === 'refine'}
              disabled={!props.canRefine || props.busy || instruction.trim().length < 3}
            >
              Refine — keep the original
            </Button>
            <p className="text-xs text-muted-foreground">
              {props.canRefine
                ? isCreative
                  ? 'The photo is refined; the text, layout and logo are put back exactly as they were. Uses one image from your allowance.'
                  : 'Makes a new version; this one is kept. Uses one image from your allowance.'
                : 'No configured image model can edit images (Gemini image models or gpt-image-1 can).'}
            </p>
          </form>

          {/* Logo setting for this image only */}
          {isCreative ? (
            <div className="space-y-2 rounded-md border border-border p-3 text-sm">
              <p className="flex items-center gap-1.5 font-medium">
                <Stamp className="h-4 w-4 text-primary" aria-hidden /> Logo
              </p>
              <p className="text-xs text-muted-foreground">This is a creative: its logo is part of the design — set it in the creative settings above.</p>
            </div>
          ) : (
            <fieldset className="space-y-2 rounded-md border border-border p-3">
              <legend className="flex items-center gap-1.5 px-1 text-sm font-medium">
                <Stamp className="h-4 w-4 text-primary" aria-hidden /> Logo for this image
              </legend>
              {LOGO_MODES.map((m) => (
                <label key={m} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name={`logo-${current.id}`}
                    className="mt-1"
                    checked={logoMode === m}
                    onChange={() => setLogoMode(m)}
                    disabled={props.busy}
                  />
                  <span>
                    {LOGO_MODE_LABELS[m]}
                    <span className="block text-xs text-muted-foreground">{LOGO_MODE_HINTS[m]}</span>
                  </span>
                </label>
              ))}
              {logoMode !== 'none' && (
                <div className="space-y-1">
                  <Label htmlFor={`logo-pos-${current.id}`}>Corner</Label>
                  <select
                    id={`logo-pos-${current.id}`}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={position}
                    onChange={(e) => setPosition(e.target.value as LogoPosition)}
                    disabled={props.busy}
                  >
                    {LOGO_POSITIONS.map((p) => (
                      <option key={p} value={p}>
                        {p.replace('-', ' ')}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => props.onLogo(current.id, logoMode, position)}
                loading={props.busyLabel === 'logo'}
                disabled={props.busy || !logoChanged || (logoMode === 'space' && !props.canRefine)}
              >
                Apply to this image
              </Button>
              <p className="text-xs text-muted-foreground">
                Applies to this image only, as a new version.
                {logoMode === 'space' ? ' Making room uses one image from your allowance.' : ''}
              </p>
            </fieldset>
          )}
        </div>
      )}
    </section>
  );
}

function aspect(ratio: string): string {
  switch (ratio) {
    case '4:5':
      return 'aspect-[4/5]';
    case '9:16':
      return 'aspect-[9/16]';
    case '16:9':
      return 'aspect-video';
    default:
      return 'aspect-square';
  }
}
