'use client';

import { useState } from 'react';
import { Check, CreditCard, Sparkles } from 'lucide-react';
import { toast } from '@/components/ui/toaster';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export interface PlanCard {
  plan: 'STARTER' | 'GROWTH' | 'AGENCY';
  label: string;
  purchasable: boolean;
  features: string[];
}

export function BillingPanel({
  currentPlan,
  status,
  active,
  trialDaysLeft,
  hasCustomer,
  stripeConfigured,
  canManage,
  plans,
}: {
  currentPlan: string;
  status: string;
  active: boolean;
  trialDaysLeft: number | null;
  hasCustomer: boolean;
  stripeConfigured: boolean;
  canManage: boolean;
  plans: PlanCard[];
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function checkout(plan: string) {
    setBusy(plan);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        toast.error(data.error ?? 'Could not start checkout.');
        return;
      }
      window.location.href = data.url;
    } finally {
      setBusy(null);
    }
  }

  async function portal() {
    setBusy('portal');
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        toast.error(data.error ?? 'Could not open the billing portal.');
        return;
      }
      window.location.href = data.url;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-primary" /> Current plan
          </CardTitle>
          <CardDescription>Your subscription and usage tier.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={active ? 'success' : 'destructive'}>{currentPlan}</Badge>
            <span className="text-sm text-muted-foreground">{status}</span>
            {trialDaysLeft != null && trialDaysLeft >= 0 && (
              <span className="text-sm">
                {trialDaysLeft} day{trialDaysLeft === 1 ? '' : 's'} left in trial
              </span>
            )}
          </div>
          {!active && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Your trial or subscription has ended. Your data is safe and read-only —
              upgrade to keep creating.
            </p>
          )}
          {hasCustomer && canManage && (
            <Button variant="outline" onClick={portal} loading={busy === 'portal'}>
              Manage billing
            </Button>
          )}
        </CardContent>
      </Card>

      {!stripeConfigured ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            Billing isn&apos;t configured on this environment yet (no Stripe keys).
            Plans are shown for reference; set the Stripe keys + price IDs to enable
            checkout.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((p) => {
          const isCurrent = p.plan === currentPlan;
          return (
            <Card key={p.plan} className={isCurrent ? 'border-primary/40' : ''}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base">
                  {p.label}
                  {isCurrent && <Badge variant="default">Current</Badge>}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="space-y-1.5 text-sm text-muted-foreground">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> {f}
                    </li>
                  ))}
                </ul>
                {canManage && !isCurrent && (
                  <Button
                    className="w-full"
                    disabled={!p.purchasable}
                    loading={busy === p.plan}
                    onClick={() => checkout(p.plan)}
                  >
                    <Sparkles className="h-4 w-4" />
                    {p.purchasable ? `Choose ${p.label}` : 'Not configured'}
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
