/**
 * Client-safe cookie name constants. Kept separate from active-company.ts
 * (which imports next/headers, a server-only module) so client components can
 * reference the name without pulling server code into the browser bundle.
 */
export const ACTIVE_COMPANY_COOKIE = 'aura.activeCompany';
