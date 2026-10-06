'use client';

import { useEffect } from 'react';

import { Label } from '@/components/ui/label';
import {
  defaultPlatformFor,
  platformSpec,
  platformsForType,
  type SocialPlatformKey,
} from '@/lib/platforms';
import {
  CONTENT_TONES,
  type ContentTone,
  type ContentTypeKey,
} from '@/lib/validations/content';

export interface GenerationChoices {
  platform: SocialPlatformKey | null;
  variations: number;
  tone: ContentTone | null;
}

export const DEFAULT_CHOICES: GenerationChoices = {
  platform: null,
  variations: 1,
  tone: null,
};

/** The extra fields generation accepts, from the choices. */
export function choicesPayload(c: GenerationChoices) {
  return {
    ...(c.platform ? { platform: c.platform } : {}),
    variations: c.variations,
    ...(c.tone ? { tone: c.tone } : {}),
  };
}

const select =
  'h-9 w-full rounded-md border border-input bg-background px-2 text-sm';

const TONE_LABEL: Record<ContentTone, string> = {
  professional: 'Professional',
  friendly: 'Friendly',
  playful: 'Playful',
  bold: 'Bold',
  warm: 'Warm',
  concise: 'Concise',
};

/**
 * Where the copy will run, how many versions to write, and an optional tone
 * — shared by every place content is generated, so they cannot drift.
 */
export function GenerationOptions({
  type,
  value,
  onChange,
}: {
  type: ContentTypeKey;
  value: GenerationChoices;
  onChange: (next: GenerationChoices) => void;
}) {
  const platforms = platformsForType(type);
  // Keep the platform valid for the chosen format.
  useEffect(() => {
    if (value.platform && !platforms.includes(value.platform)) {
      onChange({ ...value, platform: null });
    }
  }, [type]); // eslint-disable-line react-hooks/exhaustive-deps

  const variationsAllowed = type !== 'BLOG';

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {platforms.length > 1 && (
        <div className="space-y-1.5">
          <Label htmlFor="gen-platform">Write for</Label>
          <select
            id="gen-platform"
            className={select}
            value={value.platform ?? ''}
            onChange={(e) =>
              onChange({
                ...value,
                platform: (e.target.value || null) as SocialPlatformKey | null,
              })
            }
          >
            <option value="">
              {platformSpec(defaultPlatformFor(type)).label} (default)
            </option>
            {platforms
              .filter((p) => p !== defaultPlatformFor(type))
              .map((p) => (
                <option key={p} value={p}>
                  {platformSpec(p).label}
                </option>
              ))}
          </select>
        </div>
      )}
      {variationsAllowed && (
        <div className="space-y-1.5">
          <Label htmlFor="gen-variations">Versions</Label>
          <select
            id="gen-variations"
            className={select}
            value={value.variations}
            onChange={(e) =>
              onChange({ ...value, variations: Number(e.target.value) })
            }
          >
            <option value={1}>1</option>
            <option value={2}>2 — different angles</option>
            <option value={3}>3 — different angles</option>
          </select>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="gen-tone">Tone</Label>
        <select
          id="gen-tone"
          className={select}
          value={value.tone ?? ''}
          onChange={(e) =>
            onChange({
              ...value,
              tone: (e.target.value || null) as ContentTone | null,
            })
          }
        >
          <option value="">Brand voice</option>
          {CONTENT_TONES.map((t) => (
            <option key={t} value={t}>
              {TONE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export { TONE_LABEL };
