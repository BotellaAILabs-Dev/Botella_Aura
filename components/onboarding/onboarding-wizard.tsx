'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ShieldCheck,
  Radar,
  PenLine,
  MessageSquare,
  Check,
  ArrowRight,
  ArrowLeft,
  Sparkles,
} from 'lucide-react';
import { toast } from '@/components/ui/toaster';

import {
  companyStep1Schema,
  type CreateCompanyInput,
} from '@/lib/validations/company';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ACTIVE_COMPANY_COOKIE } from '@/lib/cookies';

const STEPS = ['Company', 'Brand voice', 'All set'] as const;

const TONE_OPTIONS = [
  'Professional',
  'Friendly',
  'Confident',
  'Warm',
  'Bold',
  'Playful',
  'Technical',
  'Inspirational',
  'Concise',
  'No hype',
];

const INDUSTRY_OPTIONS = [
  'B2B SaaS',
  'E-commerce',
  'Fintech',
  'Healthcare',
  'Marketing agency',
  'Real estate',
  'Education',
  'Professional services',
  'Manufacturing',
  'Hospitality',
  'Non-profit',
];

export function OnboardingWizard({
  userName,
  additional = false,
}: {
  userName: string | null;
  /** True when creating an ADDITIONAL workspace (user already has one). */
  additional?: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [data, setData] = useState<CreateCompanyInput>({
    name: '',
    website: undefined,
    industry: '',
    brandVoiceNotes: '',
  });
  // Step 2 structure + live preview.
  const [tones, setTones] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  /** Whether the last preview failure is worth offering a retry for. */
  const [previewRetryable, setPreviewRetryable] = useState(false);
  /** Set once the user has confirmed they really want a same-named workspace. */
  const [duplicateConfirmed, setDuplicateConfirmed] = useState(false);

  function toggleTone(t: string) {
    setTones((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
    setPreview(null);
  }

  /** Compose the tone chips + free text into the brand-voice string we save. */
  function composeNotes(): string {
    const base = (data.brandVoiceNotes ?? '').trim();
    if (tones.length === 0) return base;
    const toneLine = `Tone: ${tones.join(', ')}.`;
    return base ? `${toneLine}\n${base}` : toneLine;
  }

  function validateWebsite() {
    const w = (data.website ?? '').trim();
    if (w && !/^(https?:\/\/)?([\w-]+\.)+[\w-]{2,}(\/[^\s]*)?$/i.test(w)) {
      setErrors((e) => ({
        ...e,
        website: 'Enter a valid website (e.g. acme.com)',
      }));
    } else {
      setErrors((e) => {
        const { website: _drop, ...rest } = e;
        return rest;
      });
    }
  }

  async function runPreview() {
    if (!data.name.trim()) return;
    setPreviewLoading(true);
    setPreview(null);
    setPreviewNote(null);
    try {
      const res = await fetch('/api/onboarding/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: data.name,
          industry: data.industry ?? '',
          brandVoiceNotes: composeNotes(),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        sample?: string | null;
        note?: string | null;
        error?: string;
        retryable?: boolean;
      };
      if (!res.ok) {
        setPreviewNote(
          body.error ??
            'Could not generate a preview. Your details are saved — you can continue.',
        );
        setPreviewRetryable(true);
        return;
      }
      setPreview(body.sample ?? null);
      setPreviewNote(body.note ?? null);
      setPreviewRetryable(Boolean(body.retryable));
    } catch {
      // A network drop must not read like a broken product on step 2.
      setPreviewNote(
        'We could not reach the preview service. Your details are saved — you can continue and try later.',
      );
      setPreviewRetryable(true);
    } finally {
      setPreviewLoading(false);
    }
  }

  function update<K extends keyof CreateCompanyInput>(
    key: K,
    value: CreateCompanyInput[K],
  ) {
    setData((prev) => ({ ...prev, [key]: value }));
  }

  function validateStep1(): boolean {
    const result = companyStep1Schema.safeParse({
      name: data.name,
      website: data.website ?? '',
      industry: data.industry ?? '',
    });
    if (!result.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path[0];
        if (typeof key === 'string' && !fieldErrors[key]) {
          fieldErrors[key] = issue.message;
        }
      }
      setErrors(fieldErrors);
      return false;
    }
    setErrors({});
    return true;
  }

  function next() {
    if (step === 0 && !validateStep1()) return;
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }
  function back() {
    setStep((s) => Math.max(s - 1, 0));
  }

  async function finish() {
    setSubmitting(true);
    try {
      const res = await fetch('/api/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: data.name,
          website: data.website ?? '',
          industry: data.industry ?? '',
          brandVoiceNotes: composeNotes(),
          confirmDuplicate: duplicateConfirmed,
        }),
      });
      if (res.status === 409) {
        // A name clash is recoverable, not a failure — offer the second
        // workspace rather than making them retype everything.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (
          confirm(
            `${body.error ?? 'You already have a workspace with this name.'}

Create it anyway?`,
          )
        ) {
          setDuplicateConfirmed(true);
          toast('Press Create again to confirm.');
        }
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? 'Could not create your workspace.');
        return;
      }
      const created = (await res.json().catch(() => ({}))) as {
        id?: string;
        intelligenceJobId?: string;
      };
      // Make the new workspace the active one so the app opens into it.
      if (created.id) {
        document.cookie = `${ACTIVE_COMPANY_COOKIE}=${created.id}; path=/; max-age=31536000; samesite=lax`;
      }
      // Start the first analysis now, so the dashboard has a real score by the
      // time they land on it instead of a wall of "Not measured". Not awaited:
      // it runs server-side and the redirect below must not wait for it.
      if (created.intelligenceJobId) {
        void fetch(`/api/jobs/${created.intelligenceJobId}/run`, {
          method: 'POST',
          keepalive: true,
        }).catch(() => {
          // The cron reaper picks it up if this kick never lands.
        });
      }
      toast.success(additional ? 'New workspace created!' : 'Workspace created!');
      router.push('/dashboard');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="shadow-lg">
      <CardHeader>
        <Stepper current={step} />
        <CardTitle className="mt-4 text-2xl">
          {step === 0 && 'Tell us about your company'}
          {step === 1 && 'How should Aura sound?'}
          {step === 2 &&
            `You're all set${userName ? `, ${userName.split(' ')[0]}` : ''}`}
        </CardTitle>
        <CardDescription>
          {step === 0 &&
            'Aura analyzes this profile to tailor trends, content, and outreach.'}
          {step === 1 &&
            'Describe your brand voice so drafts sound like you — not a robot.'}
          {step === 2 && "Here's what Botella Aura will do for you."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {step === 0 && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="name">Company name</Label>
              <Input
                id="name"
                value={data.name}
                onChange={(e) => update('name', e.target.value)}
                aria-invalid={!!errors.name}
                placeholder="Acme Inc."
              />
              {errors.name && (
                <p className="text-xs text-destructive">{errors.name}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="website">Website</Label>
              <Input
                id="website"
                value={data.website ?? ''}
                onChange={(e) => update('website', e.target.value)}
                onBlur={validateWebsite}
                aria-invalid={!!errors.website}
                placeholder="acme.com"
              />
              {errors.website ? (
                <p className="text-xs text-destructive">{errors.website}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Aura reads your site to ground content in your real products.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="industry">
                Industry <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="industry"
                list="industry-options"
                value={data.industry ?? ''}
                onChange={(e) => update('industry', e.target.value)}
                placeholder="Start typing… e.g. B2B SaaS"
              />
              <datalist id="industry-options">
                {INDUSTRY_OPTIONS.map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
            </div>
          </>
        )}

        {step === 1 && (
          <div className="space-y-4">
            {/* Quick-select tone chips give non-writers structure to start from. */}
            <div className="space-y-1.5">
              <Label>Pick a tone (tap any)</Label>
              <div className="flex flex-wrap gap-1.5">
                {TONE_OPTIONS.map((t) => {
                  const on = tones.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleTone(t)}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                        on
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:bg-muted',
                      )}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="brandVoiceNotes">
                Anything else about your voice{' '}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="brandVoiceNotes"
                rows={5}
                value={data.brandVoiceNotes ?? ''}
                onChange={(e) => {
                  update('brandVoiceNotes', e.target.value);
                  setPreview(null);
                }}
                placeholder="e.g. Speak to busy founders. Prefer concrete examples over buzzwords. Never overpromise."
              />
              <p className="text-xs text-muted-foreground">
                You can refine this anytime in Settings.
              </p>
            </div>

            {/* Live preview — makes the abstract "voice" concrete before committing. */}
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Sparkles className="h-4 w-4 text-primary" /> Hear your voice
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  loading={previewLoading}
                  onClick={runPreview}
                  disabled={!data.name.trim()}
                >
                  Preview a sample post
                </Button>
              </div>
              {preview && (
                <p className="mt-3 whitespace-pre-line rounded-md bg-background p-3 text-sm text-foreground shadow-xs">
                  {preview}
                </p>
              )}
              {!preview && previewNote && (
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-muted-foreground">{previewNote}</p>
                  {/* Onboarding is never blocked on this step — a failed
                      preview offers a retry and nothing more. */}
                  {previewRetryable && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={runPreview}
                      loading={previewLoading}
                    >
                      Try again
                    </Button>
                  )}
                </div>
              )}
              {!preview && !previewNote && !previewLoading && (
                <p className="mt-2 text-xs text-muted-foreground">
                  See a real post written in this voice before you continue.
                </p>
              )}
            </div>
          </div>
        )}

        {step === 2 && <ConfirmationSummary />}
      </CardContent>

      <div className="flex items-center justify-between gap-3 p-6 pt-0">
        {step > 0 ? (
          <Button variant="ghost" onClick={back} disabled={submitting}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        ) : (
          <span />
        )}
        {step < STEPS.length - 1 ? (
          <Button onClick={next}>
            Continue <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button onClick={finish} loading={submitting}>
            Enter Botella Aura <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    </Card>
  );
}

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Onboarding progress">
      {STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                done && 'bg-primary text-primary-foreground',
                active && 'border-2 border-primary text-primary',
                !done && !active && 'bg-muted text-muted-foreground',
              )}
              aria-current={active ? 'step' : undefined}
            >
              {done ? <Check className="h-4 w-4" /> : i + 1}
            </span>
            <span
              className={cn(
                'hidden text-xs font-medium sm:inline',
                active ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="h-px flex-1 bg-border" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ConfirmationSummary() {
  const items = [
    {
      icon: Radar,
      title: 'Track trends',
      body: 'Daily digests of what your market cares about.',
    },
    {
      icon: PenLine,
      title: 'Draft on-brand content',
      body: 'Posts and carousels tuned to your voice.',
    },
    {
      icon: MessageSquare,
      title: 'Prepare outreach',
      body: 'Personalized drafts you review before anything sends.',
    },
  ];
  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.title} className="flex gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <item.icon className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">{item.title}</p>
              <p className="text-sm text-muted-foreground">{item.body}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <p className="text-sm text-foreground">
          <span className="font-medium">You&apos;re always in control.</span>{' '}
          Aura never posts, connects, or comments on your behalf without your
          explicit approval.
        </p>
      </div>
    </div>
  );
}
