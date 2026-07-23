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

const STEPS = ['Company', 'Brand voice', 'All set'] as const;

export function OnboardingWizard({ userName }: { userName: string | null }) {
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
          brandVoiceNotes: data.brandVoiceNotes ?? '',
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? 'Could not create your workspace.');
        return;
      }
      toast.success('Workspace created!');
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
                aria-invalid={!!errors.website}
                placeholder="acme.com"
              />
              {errors.website && (
                <p className="text-xs text-destructive">{errors.website}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="industry">
                Industry <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="industry"
                value={data.industry ?? ''}
                onChange={(e) => update('industry', e.target.value)}
                placeholder="B2B SaaS, e-commerce, fintech…"
              />
            </div>
          </>
        )}

        {step === 1 && (
          <div className="space-y-1.5">
            <Label htmlFor="brandVoiceNotes">
              Brand voice notes{' '}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="brandVoiceNotes"
              rows={7}
              value={data.brandVoiceNotes ?? ''}
              onChange={(e) => update('brandVoiceNotes', e.target.value)}
              placeholder="e.g. Confident but warm. Practical, no hype. Speak to busy founders. Prefer concrete examples over buzzwords. Never overpromise."
            />
            <p className="text-xs text-muted-foreground">
              You can refine this anytime in Settings.
            </p>
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
      body: 'Daily digests of what your market cares about (Sprint 2).',
    },
    {
      icon: PenLine,
      title: 'Draft on-brand content',
      body: 'Posts and carousels tuned to your voice (Sprint 3).',
    },
    {
      icon: MessageSquare,
      title: 'Prepare outreach',
      body: 'Personalized drafts you review before anything sends (Sprint 4).',
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
