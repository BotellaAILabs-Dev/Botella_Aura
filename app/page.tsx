import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, ShieldCheck, Sparkles, Radar, PenLine } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Logo } from '@/components/brand/logo';
import { getCurrentUser } from '@/lib/auth-helpers';

/**
 * Public landing page. Authenticated users are sent straight to the app.
 * Deliberately lightweight — the marketing site proper is out of Sprint 1
 * scope, but this should already feel like a real product's front door.
 */
export default async function HomePage() {
  const user = await getCurrentUser();
  if (user) redirect('/dashboard');

  const pillars = [
    {
      icon: Radar,
      title: 'Trend Intelligence',
      body: 'Surface what your market is talking about before your competitors do.',
    },
    {
      icon: PenLine,
      title: 'On-brand Content',
      body: 'Drafts that sound like you — tuned to your brand voice, never generic.',
    },
    {
      icon: ShieldCheck,
      title: 'Human-in-the-loop',
      body: 'Nothing posts, connects, or comments without your explicit approval.',
    },
  ];

  return (
    <div className="aura-gradient min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Logo />
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost">
            <Link href="/login">Log in</Link>
          </Button>
          <Button asChild>
            <Link href="/signup">Get started</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        <section className="flex flex-col items-center py-20 text-center md:py-28">
          <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-xs">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            Your AI Marketing Co-Pilot
          </span>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-foreground md:text-6xl">
            Market smarter, stay in control.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-muted-foreground">
            Botella Aura researches trends, analyzes your company, and drafts
            on-brand content and outreach — then waits for your approval before
            anything goes live.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg">
              <Link href="/signup">
                Start free <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/login">I already have an account</Link>
            </Button>
          </div>
        </section>

        <section className="grid gap-4 pb-24 md:grid-cols-3">
          {pillars.map((p) => (
            <div
              key={p.title}
              className="rounded-lg border border-border bg-card p-6 shadow-sm"
            >
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <p.icon className="h-5 w-5" />
              </div>
              <h3 className="text-base font-semibold text-foreground">
                {p.title}
              </h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
