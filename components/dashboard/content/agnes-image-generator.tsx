'use client';

import { useState } from 'react';
import Image from 'next/image';
import { Loader2, Sparkles, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Text-to-image, across the configured providers.
 *
 * This component talks ONLY to our own `/api/generate-image`. It never holds a
 * provider key and never calls a provider directly — the browser sends a prompt
 * and a model name, and receives an image.
 *
 * If you are tempted to call a provider from here to save a hop: that requires
 * the key in the browser, which publishes it to every visitor. The extra hop is
 * the feature.
 */
const MAX_PROMPT = 2000;

/**
 * The models on offer.
 *
 * `note` is the honest state of each one rather than marketing copy — a picker
 * that presents a provider with no credential as equal to a working one just
 * moves the disappointment to after the click.
 */
const MODELS = [
  {
    value: 'huggingface',
    label: 'Hugging Face FLUX.1-schnell',
    note: 'Fast, free tier. First call may wait for the model to load.',
  },
  {
    value: 'nano-banana',
    label: 'Nano Banana (Gemini)',
    note: 'Google Gemini image model. Needs billing enabled on the key.',
  },
  {
    value: 'agnes',
    label: 'Agnes Image 2.0',
    note: 'Square 1024px output.',
  },
] as const;

type ModelValue = (typeof MODELS)[number]['value'];

interface GenerateResponse {
  imageUrl?: string;
  error?: string;
}

export function AgnesImageGenerator({
  configured,
  initialPrompt,
}: {
  /**
   * A starting prompt from the draft's visual brief, when it was written for
   * an Aura suggestion. Editable; without it the box starts empty as before.
   */
  initialPrompt?: string | null;
  /**
   * Which models this deployment has a key for (decided server-side; the
   * keys themselves never reach the browser). Unconfigured ones are shown but
   * disabled, and the default is the first that works — defaulting to one
   * with no key made the very first click fail.
   */
  configured?: Partial<Record<ModelValue, boolean>>;
} = {}) {
  const isOn = (v: ModelValue) => configured?.[v] ?? true;
  const [prompt, setPrompt] = useState(initialPrompt ?? '');
  const [model, setModel] = useState<ModelValue>(
    () => MODELS.find((m) => isOn(m.value))?.value ?? 'huggingface',
  );
  const [loading, setLoading] = useState(false);
  /** A real-looking marketing photograph (lib/photo-realism.ts), unless turned off. */
  const [realistic, setRealistic] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  /** The model that produced the image on screen, which may not be the
      currently selected one after the user changes the dropdown. */
  const [producedBy, setProducedBy] = useState<string | null>(null);

  const tooLong = prompt.trim().length > MAX_PROMPT;
  const canSubmit = prompt.trim().length > 0 && !tooLong && !loading;
  const selected = MODELS.find((m) => m.value === model)!;

  async function generate() {
    if (!canSubmit) return;

    setLoading(true);
    setError(null);
    // The previous image is cleared so a failure cannot leave a stale picture
    // sitting under a new prompt, looking like it was the result.
    setImageUrl(null);
    setProducedBy(null);

    try {
      const res = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), model, realistic }),
      });

      const data = (await res.json().catch(() => ({}))) as GenerateResponse;

      if (!res.ok) {
        // The route writes messages meant to be read — a loading model, a
        // missing permission, a rate limit — so they are shown as-is rather
        // than replaced with something generic.
        setError(data.error ?? `Image generation failed (HTTP ${res.status}).`);
        return;
      }

      if (!data.imageUrl) {
        setError('The service returned no image. Try rewording the prompt.');
        return;
      }

      setImageUrl(data.imageUrl);
      setProducedBy(selected.label);
    } catch {
      setError('Could not reach the server. Check your connection and retry.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" /> Generate an image
        </CardTitle>
        <CardDescription>
          {initialPrompt
            ? 'Started from the visual brief for Aura’s suggestion — edit it freely.'
            : 'Describe the picture you want. Be concrete about subject, setting and mood — a vague prompt produces a generic stock image.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="image-model">Model</Label>
          <select
            id="image-model"
            value={model}
            disabled={loading}
            onChange={(e) => setModel(e.target.value as ModelValue)}
            className={cn(
              'h-10 w-full rounded-md border border-input bg-background px-3 text-sm',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value} disabled={!isOn(m.value)}>
                {m.label}
                {isOn(m.value) ? '' : ' (not set up)'}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{selected.note}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="image-prompt">Prompt</Label>
          <Textarea
            id="image-prompt"
            rows={3}
            value={prompt}
            disabled={loading}
            aria-invalid={tooLong}
            aria-describedby="image-prompt-help"
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. A small-batch coffee roastery at dawn, sacks of green beans, warm light through a window"
          />
          <div className="flex items-start justify-between gap-3">
            <p id="image-prompt-help" className="text-xs text-muted-foreground">
              {tooLong ? (
                <span className="text-destructive">
                  {prompt.trim().length} characters — keep it under {MAX_PROMPT}.
                </span>
              ) : (
                'Nothing is published automatically. The image appears here for you to review.'
              )}
            </p>
            {prompt.trim().length > MAX_PROMPT * 0.75 && (
              <span
                className={cn(
                  'shrink-0 tabular-nums text-xs',
                  tooLong
                    ? 'font-medium text-destructive'
                    : 'text-muted-foreground',
                )}
              >
                {prompt.trim().length}/{MAX_PROMPT}
              </span>
            )}
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-primary"
            checked={realistic}
            disabled={loading}
            onChange={(e) => setRealistic(e.target.checked)}
          />
          <span>
            <span className="font-medium text-foreground">Real photograph</span>
            <span className="block text-xs text-muted-foreground">
              Natural light, real textures and authentic people — not an AI-art
              look. Prompts asking for an illustration or 3D are kept as
              written.
            </span>
          </span>
        </label>

        <Button onClick={generate} disabled={!canSubmit}>
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Generating…
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" /> Generate image
            </>
          )}
        </Button>

        {/* Error state. `role="alert"` so it is announced, not just shown. */}
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">Image generation failed</p>
              <p className="mt-0.5 break-words">{error}</p>
            </div>
          </div>
        )}

        {/* Loading placeholder, sized to the 1024x1024 the route requests, so
            the panel does not jump when the image arrives. */}
        {loading && (
          <div className="flex aspect-square w-full max-w-sm items-center justify-center rounded-lg border border-border bg-muted/40">
            <div className="flex flex-col items-center gap-2 px-6 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              {selected.value === 'huggingface'
                ? 'Usually a few seconds. A cold model can take longer on the first call.'
                : 'This usually takes a few seconds'}
            </div>
          </div>
        )}

        {imageUrl && !loading && (
          <div className="space-y-2">
            <div className="relative aspect-square w-full max-w-sm overflow-hidden rounded-lg border border-border">
              {/*
                An unoptimised <Image> on purpose: the source is a data: URI,
                and routing it through /_next/image would re-encode bytes we
                already hold for no benefit.
              */}
              <Image
                src={imageUrl}
                alt={`Generated image for: ${prompt.trim().slice(0, 120)}`}
                fill
                unoptimized
                sizes="(max-width: 640px) 100vw, 384px"
                className="object-cover"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {producedBy ? `Generated by ${producedBy}. ` : ''}Nothing has been
              saved or published.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
