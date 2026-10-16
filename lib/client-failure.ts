'use client';

import { toast } from 'sonner';

/**
 * How a failed request is told to the person, the same way everywhere in
 * Content Studio (client-side; the server's messages are already plain).
 *
 *   401          the session ended: their work on the page is kept (forms
 *                save it in sessionStorage) — a button signs them in and
 *                brings them back here
 *   with `fix`   the server said where to fix it: shown as a button
 *   otherwise    the server's own message, or the fallback
 *   no response  a network error: nothing was changed, try again
 */

export interface FailureBody {
  error?: string;
  fix?: { label: string; href: string } | null;
}

export function signInHref(): string {
  const back = typeof window === 'undefined' ? '/dashboard' : `${window.location.pathname}${window.location.search}`;
  return `/login?callbackUrl=${encodeURIComponent(back)}`;
}

export function showFailure(status: number, body: FailureBody, fallback: string): void {
  if (status === 401) {
    toast.error('Your session ended. Your work on this page is kept — sign in again to continue.', {
      duration: 15000,
      action: { label: 'Sign in', onClick: () => window.location.assign(signInHref()) },
    });
    return;
  }
  const message = body.error ?? fallback;
  if (body.fix) {
    const fix = body.fix;
    toast.error(message, { duration: 12000, action: { label: fix.label, onClick: () => window.location.assign(fix.href) } });
    return;
  }
  toast.error(message);
}

export function showNetworkFailure(): void {
  toast.error('Could not reach Aura — check your connection. Nothing was changed; your work is still here. Try again.');
}

/** A form's unsent work, kept across a lost session or a reload (best effort). */
export function keepWork<T>(key: string, value: T | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: work lives in memory only */
  }
}

export function keptWork<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** One per open form: a retried generate returns the same draft (server-side idempotency). */
export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
