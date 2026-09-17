/**
 * Password policy constants — deliberately dependency-free.
 *
 * This lives apart from `lib/password.ts` because the Zod schemas in
 * `lib/validations/auth.ts` need `MIN_PASSWORD_LENGTH`, and those schemas are
 * imported by the auth *client* forms. When the constant lived in
 * `lib/password.ts`, importing it dragged that module's top-level
 * `import bcrypt from 'bcryptjs'` into the browser bundle — and with it
 * webpack's Node polyfills for crypto/stream/buffer (elliptic, bn.js, sha.js,
 * readable-stream). That was ~317 kB of unused JavaScript on every auth page:
 * /login and /signup shipped 289 kB of First Load JS against 94-146 kB for the
 * entire dashboard.
 *
 * Nothing may be imported here. A single import of server-only code puts the
 * whole polyfill chain back.
 */

/** Minimum password length, enforced in the Zod schema AND at hash time. */
export const MIN_PASSWORD_LENGTH = 8;

/** bcrypt truncates silently past 72 bytes, so reject longer inputs outright. */
export const MAX_PASSWORD_LENGTH = 72;
