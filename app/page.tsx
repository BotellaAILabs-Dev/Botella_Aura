import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ArrowRight,
  ShieldCheck,
  Radar,
  PenLine,
  Target,
  MessageCircle,
  Megaphone,
  Brain,
  Check,
  MousePointerClick,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Logo } from '@/components/brand/logo';
import { getCurrentUser } from '@/lib/auth-helpers';
import { PLAN_LIMITS } from '@/server/billing/entitlements';

/**
 * Public marketing homepage (Sprint 6). Communicates the killer features and the
 * core safety differentiator ("we never risk your LinkedIn account"), with a
 * pricing preview and signup CTA. Authenticated users go straight to the app.
 */
export default async function HomePage() {
  const user = await getCurrentUser();
  if (user) redirect('/dashboard');

  const features = [
    { icon: Radar, title: 'Market trends', body: 'A daily digest of what your market is talking about, with a suggested angle for each.' },
    { icon: PenLine, title: 'Content Studio', body: 'On-brand posts, carousels, and threads generated in your voice — you approve every one.' },
    { icon: Target, title: 'Lead Discovery & Outreach', body: 'Find qualified prospects from legitimate public sources and draft personalized outreach.' },
    { icon: MessageCircle, title: 'Engagement Copilot', body: 'Thoughtful, on-brand comments drafted for posts you’re already reading.' },
    { icon: Megaphone, title: 'Campaign Orchestrator', body: 'One goal in, a full reviewable 30-day plan out — content, outreach, and discovery, scheduled.' },
    { icon: Brain, title: 'What works for you', body: 'It learns what works from your real results and makes every future draft smarter.' },
  ];

  const plans = (['STARTER', 'GROWTH', 'AGENCY'] as const).map((p) => ({
    label: PLAN_LIMITS[p].label,
    limits: PLAN_LIMITS[p],
    featured: p === 'GROWTH',
  }));

  return (
    <div className="aura-gradient min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Logo />
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost"><Link href="/login">Log in</Link></Button>
          <Button asChild><Link href="/signup">Start free</Link></Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        {/* Hero */}
        <section className="flex flex-col items-center py-20 text-center md:py-28">
          <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-xs">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" />
            Your AI Marketing Co-Pilot — safe by design
          </span>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-foreground md:text-6xl">
            An AI employee that markets for you — and never risks your account.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-muted-foreground">
            Botella Aura researches trends, writes on-brand content, finds leads, and
            drafts outreach — then waits for your approval. Every LinkedIn action is
            one human click, inside your own browser. Nothing automated. Ever.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg">
              <Link href="/signup">Start your free trial <ArrowRight className="h-4 w-4" /></Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/login">I already have an account</Link>
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">14-day free trial · no card required to start</p>
        </section>

        {/* Safety differentiator */}
        <section className="mb-20 rounded-2xl border border-primary/20 bg-card p-8 shadow-sm">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <h2 className="text-2xl font-semibold tracking-tight">We never risk your LinkedIn account</h2>
            <p className="mt-3 text-muted-foreground">
              Our backend never logs into LinkedIn, never stores your cookies, and never
              automates a single click. Every message, comment, and post happens through
              our Chrome extension — executed by <span className="font-medium text-foreground">you</span>,
              one click at a time, in your own browser. No scraping, no bots, no bans.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-4 text-sm">
              <span className="inline-flex items-center gap-1.5"><MousePointerClick className="h-4 w-4 text-primary" /> One human, one click</span>
              <span className="inline-flex items-center gap-1.5"><Check className="h-4 w-4 text-primary" /> Human approval on everything</span>
              <span className="inline-flex items-center gap-1.5"><Check className="h-4 w-4 text-primary" /> Official APIs only</span>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="mb-20">
          <h2 className="mb-8 text-center text-2xl font-semibold tracking-tight">Everything you need, in one co-pilot</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {features.map((f) => (
              <div key={f.title} className="rounded-lg border border-border bg-card p-6 shadow-sm">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <f.icon className="h-5 w-5" />
                </div>
                <h3 className="text-base font-semibold text-foreground">{f.title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Pricing preview */}
        <section className="mb-20">
          <h2 className="mb-2 text-center text-2xl font-semibold tracking-tight">Simple, honest pricing</h2>
          <p className="mb-8 text-center text-sm text-muted-foreground">Start free for 14 days. Upgrade when you’re ready.</p>
          <div className="grid gap-4 md:grid-cols-3">
            {plans.map((p) => (
              <div
                key={p.label}
                className={`rounded-lg border bg-card p-6 shadow-sm ${p.featured ? 'border-primary/40 ring-1 ring-primary/20' : 'border-border'}`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">{p.label}</h3>
                  {p.featured && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Popular</span>}
                </div>
                <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                  <li className="flex items-center gap-2"><Check className="h-4 w-4 text-primary" /> {p.limits.maxActiveCampaigns} active campaign{p.limits.maxActiveCampaigns === 1 ? '' : 's'}</li>
                  <li className="flex items-center gap-2"><Check className="h-4 w-4 text-primary" /> {p.limits.maxDiscoveryRunsPerMonth} discovery runs / month</li>
                  <li className="flex items-center gap-2"><Check className="h-4 w-4 text-primary" /> {p.limits.maxLinkedInAccounts} connected account{p.limits.maxLinkedInAccounts === 1 ? '' : 's'}</li>
                  <li className="flex items-center gap-2"><Check className="h-4 w-4 text-primary" /> {p.limits.maxImagesPerMonth} generated graphics / month</li>
                  <li className="flex items-center gap-2"><Check className="h-4 w-4 text-primary" /> All AI features + extension</li>
                </ul>
                <Button asChild className="mt-6 w-full" variant={p.featured ? 'default' : 'outline'}>
                  <Link href="/signup">Start free</Link>
                </Button>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="mb-24 rounded-2xl bg-primary px-8 py-12 text-center text-primary-foreground">
          <h2 className="text-2xl font-semibold tracking-tight">Ready to market smarter — safely?</h2>
          <p className="mx-auto mt-2 max-w-xl text-primary-foreground/90">
            Set up your workspace in minutes. Your first trend digest and content draft are moments away.
          </p>
          <Button asChild size="lg" variant="secondary" className="mt-6">
            <Link href="/signup">Start your free trial <ArrowRight className="h-4 w-4" /></Link>
          </Button>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-8 text-sm text-muted-foreground sm:flex-row">
          <Logo />
          <span>© {new Date().getFullYear()} Botella AI Labs · Human-in-the-loop by design</span>
        </div>
      </footer>
    </div>
  );
}
