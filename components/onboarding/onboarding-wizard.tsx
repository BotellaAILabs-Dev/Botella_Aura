'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ShieldCheck,
  Check,
  ArrowRight,
  ArrowLeft,
  Sparkles,
  Store,
  Briefcase,
} from 'lucide-react';
import { toast } from '@/components/ui/toaster';

import {
  companyStep1Schema,
  companyAudienceSchema,
  type CreateCompanyInput,
} from '@/lib/validations/company';
import type { MarketMode } from '@/lib/validations/profile';
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
import { ONBOARDING_STEPS } from '@/lib/onboarding';

/**
 * Onboarding, as the three things Aura cannot write without.
 *
 * The wizard used to ask for a company name, an optional industry and a tone,
 * then drop the user on a dashboard whose very first checklist item told them
 * to go and add their business information — the thing they thought they had
 * just done. Worse, the questions it skipped are the ones the generator leans
 * on hardest: what the business actually sells, and who it sells to. Both were
 * buried in Settings, so every new workspace generated its first content from a
 * company name alone.
 *
 * So the steps now mirror what the content engine actually reads:
 * business → audience → voice. Each one is short, and each is a question whose
 * answer visibly changes what Aura writes.
 */
const STEPS = ['Business', 'Audience', 'Voice', 'What happens next'] as const;

/**
 * Tone options, split by who is being sold to.
 *
 * The single list was written for B2B — "Technical", "No hype" and "Concise"
 * are the vocabulary of a software buyer, and offering them to a restaurant or
 * a clothing label invites a voice that reads like a procurement memo.
 */
const TONE_OPTIONS: Record<MarketMode, string[]> = {
  B2B: [
    'Professional',
    'Confident',
    'Direct',
    'Technical',
    'Analytical',
    'Concise',
    'No hype',
    'Authoritative',
  ],
  B2C: [
    'Friendly',
    'Warm',
    'Playful',
    'Bold',
    'Honest',
    'Inspirational',
    'Down to earth',
    'Cheeky',
  ],
};

const INDUSTRY_OPTIONS: Record<MarketMode, string[]> = {
  B2B: [
    'B2B SaaS',
    'Fintech',
    'Marketing agency',
    'Professional services',
    'Manufacturing',
    'Logistics',
    'Recruitment',
    'Consulting',
    'Healthcare',
    'Education',
  ],
  B2C: [
    'Food & beverage',
    'Restaurant & hospitality',
    'Beauty & skincare',
    'Fashion & apparel',
    'Fitness & wellness',
    'Retail & e-commerce',
    'Travel & leisure',
    'Home & interiors',
    'Real estate',
    'Events',
  ],
};

/**
 * Placeholders are worked examples, not shapes.
 *
 * "Acme Inc." tells someone the field wants a company name, which they already
 * knew. A filled-in answer from a plausible business shows the LEVEL OF DETAIL
 * that makes the field useful — which is the actual thing people get wrong
 * when they write one vague line and wonder why the output is vague.
 */
const EXAMPLES: Record<
  MarketMode,
  { description: string; offerings: string; audience: string; goals: string }
> = {
  B2B: {
    description:
      'e.g. We run payroll and compliance for Indian startups with 10–200 staff, so founders never touch a spreadsheet or a filing deadline.',
    offerings: 'e.g. Monthly payroll runs, PF/ESI filing, contractor payments',
    audience:
      'e.g. Founders and ops leads at 10–200 person startups who are still doing payroll in Excel and have been burned by a late filing.',
    goals: 'e.g. 15 demo calls a month, and rank for "startup payroll India"',
  },
  B2C: {
    description:
      'e.g. We roast single-origin coffee in small batches in Hyderabad and ship it within 48 hours of roasting.',
    offerings: 'e.g. Whole bean subscriptions, gift boxes, a café in Jubilee Hills',
    audience:
      'e.g. People in their 20s–40s who already own a grinder, care where the beans come from, and are bored of supermarket coffee.',
    goals: 'e.g. 200 subscription signups this quarter, more weekday café footfall',
  },
};

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
    description: '',
    offerings: '',
    marketMode: 'B2B',
    audience: '',
    goals: '',
    brandVoiceNotes: '',
  });
  // Step 3 structure + live preview.
  const [tones, setTones] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  /** Whether the last preview failure is worth offering a retry for. */
  const [previewRetryable, setPreviewRetryable] = useState(false);
  /** Set once the user has confirmed they really want a same-named workspace. */
  const [duplicateConfirmed, setDuplicateConfirmed] = useState(false);

  const mode: MarketMode = data.marketMode ?? 'B2B';
  const examples = EXAMPLES[mode];

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

  /**
   * The preview now carries the whole profile, not just a name and a tone.
   *
   * This is the first thing Aura ever writes for someone, and it used to be
   * generated from the company name alone — so it invented a product and a
   * "recent win" that had never happened. Shown during onboarding, that reads
   * as the product being confidently wrong about your business. Sending the
   * description, audience and market mode makes the sample checkable, which is
   * the only version of this feature worth showing.
   */
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
          description: data.description ?? '',
          offerings: data.offerings ?? '',
          marketMode: mode,
          audience: data.audience ?? '',
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
      // A network drop must not read like a broken product on the voice step.
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

  /** Map a Zod failure onto per-field messages, first issue per field wins. */
  function applyIssues(issues: { path: (string | number)[]; message: string }[]) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      }
    }
    setErrors(fieldErrors);
  }

  function validateBusiness(): boolean {
    const result = companyStep1Schema.safeParse({
      name: data.name,
      website: data.website ?? '',
      industry: data.industry ?? '',
      description: data.description ?? '',
      offerings: data.offerings ?? '',
    });
    if (!result.success) {
      applyIssues(result.error.issues);
      return false;
    }
    setErrors({});
    return true;
  }

  function validateAudience(): boolean {
    const result = companyAudienceSchema.safeParse({
      marketMode: mode,
      audience: data.audience ?? '',
      goals: data.goals ?? '',
    });
    if (!result.success) {
      applyIssues(result.error.issues);
      return false;
    }
    setErrors({});
    return true;
  }

  function next() {
    if (step === 0 && !validateBusiness()) return;
    if (step === 1 && !validateAudience()) return;
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
          description: data.description ?? '',
          offerings: data.offerings ?? '',
          marketMode: mode,
          audience: data.audience ?? '',
          goals: data.goals ?? '',
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
          {step === 0 && 'What does your business do?'}
          {step === 1 && 'Who are you selling to?'}
          {step === 2 && 'How should Aura sound?'}
          {step === 3 &&
            `Nice to meet you${userName ? `, ${userName.split(' ')[0]}` : ''}`}
        </CardTitle>
        <CardDescription>
          {step === 0 &&
            'Aura writes from this. The more concrete you are, the less it has to guess.'}
          {step === 1 &&
            'The biggest single thing you can tell Aura — it changes how everything is written.'}
          {step === 2 &&
            'Describe your brand voice so drafts sound like you — not a robot.'}
          {step === 3 && 'Your workspace is ready. Here is what happens next.'}
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
                placeholder="Your company's name"
              />
              {errors.name && (
                <p className="text-xs text-destructive">{errors.name}</p>
              )}
            </div>

            {/* The field the whole product was missing. Required, and asked
                first, because nothing downstream works without it. */}
            <div className="space-y-1.5">
              <Label htmlFor="description">What do you do?</Label>
              <Textarea
                id="description"
                rows={3}
                value={data.description ?? ''}
                onChange={(e) => update('description', e.target.value)}
                aria-invalid={!!errors.description}
                placeholder={examples.description}
              />
              {errors.description ? (
                <p className="text-xs text-destructive">{errors.description}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Plain language, like you would explain it to someone at a
                  party. This is the single biggest input to everything Aura
                  writes.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="offerings">
                What do you sell?{' '}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="offerings"
                value={data.offerings ?? ''}
                onChange={(e) => update('offerings', e.target.value)}
                placeholder={examples.offerings}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="website">
                Website <span className="text-muted-foreground">(optional)</span>
              </Label>
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
                placeholder="Start typing…"
              />
              <datalist id="industry-options">
                {[...INDUSTRY_OPTIONS.B2C, ...INDUSTRY_OPTIONS.B2B].map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
            </div>
          </>
        )}

        {step === 1 && (
          <div className="space-y-5">
            {/* Market mode leads, because it changes the meaning of every
                answer below it — and of every post Aura writes afterwards. */}
            <div className="space-y-1.5">
              <Label>Who buys from you?</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                <ModeCard
                  active={mode === 'B2C'}
                  icon={Store}
                  title="People"
                  detail="Someone spending their own money"
                  onClick={() => {
                    update('marketMode', 'B2C');
                    setTones([]);
                    setPreview(null);
                  }}
                />
                <ModeCard
                  active={mode === 'B2B'}
                  icon={Briefcase}
                  title="Businesses"
                  detail="Someone buying for their company"
                  onClick={() => {
                    update('marketMode', 'B2B');
                    setTones([]);
                    setPreview(null);
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {mode === 'B2C'
                  ? 'Aura will write about how something looks, tastes or feels — not about ROI.'
                  : 'Aura will tie every claim to revenue, cost, risk or time saved.'}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="audience">Describe your typical customer</Label>
              <Textarea
                id="audience"
                rows={3}
                value={data.audience ?? ''}
                onChange={(e) => update('audience', e.target.value)}
                aria-invalid={!!errors.audience}
                placeholder={examples.audience}
              />
              {errors.audience ? (
                <p className="text-xs text-destructive">{errors.audience}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  One real person, not a segment. What are they already doing,
                  and what annoys them about it?
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="goals">
                What are you trying to achieve?{' '}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="goals"
                rows={2}
                value={data.goals ?? ''}
                onChange={(e) => update('goals', e.target.value)}
                placeholder={examples.goals}
              />
              <p className="text-xs text-muted-foreground">
                Aura aims content at this. It never mentions it in a post.
              </p>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            {/* Quick-select tone chips give non-writers structure to start
                from, drawn from the market they just picked. */}
            <div className="space-y-1.5">
              <Label>Pick a tone (tap any)</Label>
              <div className="flex flex-wrap gap-1.5">
                {TONE_OPTIONS[mode].map((t) => {
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
                rows={4}
                value={data.brandVoiceNotes ?? ''}
                onChange={(e) => {
                  update('brandVoiceNotes', e.target.value);
                  setPreview(null);
                }}
                placeholder={
                  mode === 'B2C'
                    ? 'e.g. Never call it "premium". Talk about the people who make it. Short sentences.'
                    : 'e.g. Speak to busy founders. Prefer concrete examples over buzzwords. Never overpromise.'
                }
              />
              <p className="text-xs text-muted-foreground">
                You can refine this anytime in Settings.
              </p>
            </div>

            {/* Live preview — now written from the real business profile, so
                it is something the user can actually check for accuracy. */}
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
                <>
                  <p className="mt-3 whitespace-pre-line rounded-md bg-background p-3 text-sm text-foreground shadow-xs">
                    {preview}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Written from what you told Aura about your business. If
                    anything here is wrong, go back and sharpen your
                    description — that is what fixes it.
                  </p>
                </>
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
                  See a real post about your business before you continue.
                </p>
              )}
            </div>
          </div>
        )}

        {step === 3 && <ConfirmationSummary />}
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

/** One half of the B2C/B2B choice. */
function ModeCard({
  active,
  icon: Icon,
  title,
  detail,
  onClick,
}: {
  active: boolean;
  icon: typeof Store;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors',
        active
          ? 'border-primary bg-primary/5'
          : 'border-border hover:bg-muted/50',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 h-5 w-5 shrink-0',
          active ? 'text-primary' : 'text-muted-foreground',
        )}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">
          {title}
        </span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </button>
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

/**
 * The end of the wizard is the START of setup, not the end of it.
 *
 * This used to list three things Aura can do — true, but it left the user at
 * the door of an app with no idea what to do first. Showing the actual
 * remaining steps, drawn from the same ONBOARDING_STEPS the dashboard
 * checklist renders, means the sequence they are about to see is the sequence
 * they were just promised.
 *
 * The wizard now completes the business AND audience steps, so both are
 * dropped from the remaining list — the checklist they land on agrees.
 */
function ConfirmationSummary() {
  const done = new Set(['business', 'audience']);
  const remaining = ONBOARDING_STEPS.filter(
    (s) => !done.has(s.id) && s.id !== 'review',
  );

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-foreground">
          A few short steps and Aura can start working
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          None of these are required. Each one makes what Aura writes noticeably
          better, and your dashboard walks you through them one at a time.
        </p>
      </div>

      <ol className="space-y-3">
        {remaining.map((step, i) => (
          <li key={step.id} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
              {i + 1}
            </span>
            <div>
              <p className="text-sm font-medium text-foreground">{step.title}</p>
              <p className="text-sm text-muted-foreground">{step.why}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4">
        <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <p className="text-sm text-foreground">
          <span className="font-medium">Then Aura goes to work.</span> Every
          Monday it writes your week&apos;s posts, makes a graphic for each,
          checks what competitors changed, and leaves it all on your home page.
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-border p-4">
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
