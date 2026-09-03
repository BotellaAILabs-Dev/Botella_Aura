'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImagePlus, Upload, Palette } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';

interface BrandInitial {
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
}

const SWATCHES: { key: keyof Omit<BrandInitial, 'logoUrl'>; label: string; hint: string }[] = [
  { key: 'primaryColor', label: 'Primary', hint: 'Your main brand colour' },
  { key: 'secondaryColor', label: 'Secondary', hint: 'Supporting colour' },
  { key: 'accentColor', label: 'Accent', hint: 'Highlights and detail' },
];

/**
 * Logo upload and brand palette.
 *
 * The colour inputs are paired: a native colour picker for people who want to
 * click, and a text field for people who know their hex codes and would rather
 * paste them. Designers almost always have the hex, so the text field is the
 * one that carries the value.
 */
export function BrandAssetsForm({
  initial,
  canManage,
}: {
  initial: BrandInitial;
  canManage: boolean;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [colors, setColors] = useState({
    primaryColor: initial.primaryColor,
    secondaryColor: initial.secondaryColor,
    accentColor: initial.accentColor,
  });

  async function uploadLogo(file: File) {
    setUploading(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/company/logo', { method: 'POST', body });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.url) {
        toast.error(data.error ?? 'That logo could not be saved.');
        return;
      }
      setLogoUrl(data.url);
      toast.success('Logo saved.');
      router.refresh();
    } catch {
      toast.error('Could not reach the server. Try again.');
    } finally {
      setUploading(false);
      // Clear the input so re-picking the same file still fires onChange.
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function saveColors() {
    setSaving(true);
    try {
      const res = await fetch('/api/company/brand', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(colors),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? 'Could not save your colours.');
        return;
      }
      toast.success('Brand colours saved.');
      router.refresh();
    } catch {
      toast.error('Could not reach the server. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ImagePlus className="h-4 w-4 text-primary" /> Logo
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/40">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- the asset route is session-gated and not a static file the optimiser can reach.
                <img src={logoUrl} alt="Your logo" className="h-full w-full object-contain" />
              ) : (
                <ImagePlus className="h-6 w-6 text-muted-foreground" aria-hidden />
              )}
            </div>
            <div className="space-y-1.5">
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadLogo(file);
                }}
              />
              <Button
                variant="outline"
                onClick={() => fileInput.current?.click()}
                loading={uploading}
                disabled={!canManage}
              >
                <Upload className="h-4 w-4" />
                {logoUrl ? 'Replace logo' : 'Upload logo'}
              </Button>
              <p className="text-xs text-muted-foreground">
                PNG, JPEG or WebP, up to 4 MB. Only people in this workspace can
                see it.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette className="h-4 w-4 text-primary" /> Brand colours
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Aura builds graphics around these — in the lighting, surfaces and
            background rather than as blocks of flat colour.
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            {SWATCHES.map((s) => (
              <div key={s.key} className="space-y-1.5">
                <Label htmlFor={s.key}>{s.label}</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={`${s.label} colour picker`}
                    value={colors[s.key] || '#ffffff'}
                    disabled={!canManage}
                    onChange={(e) =>
                      setColors((c) => ({ ...c, [s.key]: e.target.value }))
                    }
                    className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-1 disabled:cursor-not-allowed"
                  />
                  <Input
                    id={s.key}
                    value={colors[s.key]}
                    disabled={!canManage}
                    placeholder="#1d4ed8"
                    onChange={(e) =>
                      setColors((c) => ({ ...c, [s.key]: e.target.value }))
                    }
                  />
                </div>
                <p className="text-xs text-muted-foreground">{s.hint}</p>
              </div>
            ))}
          </div>

          {canManage ? (
            <Button onClick={saveColors} loading={saving}>
              Save colours
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Your role can view brand assets but not change them.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
