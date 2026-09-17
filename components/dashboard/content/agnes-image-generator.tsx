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

/**
 * Text-to-image via Agnes AI.
 *
 * This component talks ONLY to our own `/api/generate-image`. It never sees
 * AGNES_API_KEY and never calls the provider directly — the key stays on the
 * server, and the browser sends a prompt and receives a URL.
 *
 * If you are tempted to call the provider from here to save a hop: that
 * requires the key in the browser, which publishes it to every visitor. The
 * extra hop is the feature.
 */
const MAX_PROMPT = 2000;

interface GenerateResponse {
  imageUrl?: string;
  error?: string;
}

export function AgnesImageGenerator() {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const tooLong = prompt.trim().length > MAX_PROMPT;
  const canSubmit = prompt.trim().length > 0 && !tooLong && !loading;

  async function generate() {
    if (!canSubmit) return;

    setLoading(true);
    setError(null);
    // The previous image is cleared so a failure cannot leave a stale picture
    // sitting under a new prompt, looking like it was the result.
    setImageUrl(null);

    try {
      const res = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });

      const data = (await res.json().catch(() => ({}))) as GenerateResponse;

      if (!res.ok) {
        // The route writes messages meant to be read, including the
        // missing-key case, so they are shown rather than replaced with
        // something generic.
        setError(data.error ?? `Image generation failed (HTTP ${res.status}).`);
        return;
      }

      if (!data.imageUrl) {
        setError('The service returned no image. Try rewording the prompt.');
        return;
      }

      setImageUrl(data.imageUrl);
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
          Describe the picture you want. Be concrete about subject, setting and
          mood — a vague prompt produces a generic stock image.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="agnes-prompt">Prompt</Label>
          <Textarea
            id="agnes-prompt"
            rows={3}
            value={prompt}
            disabled={loading}
            aria-invalid={tooLong}
            aria-describedby="agnes-prompt-help"
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. A small-batch coffee roastery at dawn, sacks of green beans, warm light through a window"
          />
          <div className="flex items-start justify-between gap-3">
            <p id="agnes-prompt-help" className="text-xs text-muted-foreground">
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
                className={`shrink-0 tabular-nums text-xs ${
                  tooLong
                    ? 'font-medium text-destructive'
                    : 'text-muted-foreground'
                }`}
              >
                {prompt.trim().length}/{MAX_PROMPT}
              </span>
            )}
          </div>
        </div>

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
            <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              This usually takes a few seconds
            </div>
          </div>
        )}

        {imageUrl && !loading && (
          <div className="space-y-2">
            <div className="relative aspect-square w-full max-w-sm overflow-hidden rounded-lg border border-border">
              {/*
                An unoptimised <Image> on purpose: the source is either a
                remote provider URL or a data: URI, and routing arbitrary
                third-party images through /_next/image would make it an open
                proxy. See the remotePatterns note in next.config.mjs.
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
              Generated from your prompt. Nothing has been saved or published.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
