import Link from 'next/link';

import { Logo } from '@/components/brand/logo';
import { LEGAL } from '@/lib/legal';

/**
 * The public legal pages (/privacy, /terms, /data-deletion): Aura's branded
 * gradient, readable at phone width, with a DRAFT banner until the text is
 * approved (lib/legal.ts).
 */
export function LegalPage({ title, intro, children }: { title: string; intro?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="aura-gradient min-h-screen">
      <header className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-6 sm:px-6">
        <Link href="/" aria-label="Botella Aura home">
          <Logo />
        </Link>
        <nav className="flex gap-4 text-sm text-muted-foreground">
          <Link href="/privacy" className="hover:text-foreground">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-foreground">
            Terms
          </Link>
          <Link href="/data-deletion" className="hover:text-foreground">
            Data deletion
          </Link>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-3xl px-4 pb-16 sm:px-6">
        <article className="rounded-xl border border-border bg-card p-5 shadow-sm sm:p-8">
          {!LEGAL.approved ? (
            <div role="note" className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
              <strong>Draft — not yet approved.</strong> This text is being reviewed by the business and its legal advisers. Items marked{' '}
              <Confirm>to confirm</Confirm> are not final.
            </div>
          ) : null}
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {LEGAL.effectiveDate ? `Effective ${LEGAL.effectiveDate}` : <>Effective date: <Confirm>to confirm</Confirm></>}
          </p>
          {intro ? <div className="mt-4 text-[15px] leading-7">{intro}</div> : null}
          <div className="legal-body mt-6 space-y-8 text-[15px] leading-7">{children}</div>
        </article>
      </main>
    </div>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function List({ children }: { children: React.ReactNode }) {
  return <ul className="ml-5 list-disc space-y-1.5">{children}</ul>;
}

/** A fact the business or its lawyers still have to confirm — visible, never invented. */
export function Confirm({ children }: { children: React.ReactNode }) {
  return (
    <mark className="rounded bg-amber-100 px-1 text-amber-900 dark:bg-amber-900 dark:text-amber-100">
      [{children}]
    </mark>
  );
}

/** A value from lib/legal.ts, or a "to confirm" marker naming what is missing. */
export function Fact({ value, missing }: { value: string | number | null; missing: string }) {
  return value === null || value === '' ? <Confirm>to confirm: {missing}</Confirm> : <>{value}</>;
}
