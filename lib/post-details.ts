import { z } from 'zod';

/**
 * Post details: the factual contact information a post may carry — its
 * website link, business address, phone and email.
 *
 * They live in the post body (`body.details`), so each content version keeps
 * its own values, and they are versioned, fingerprinted and re-approved like
 * the rest of the copy. They are NEVER written by the AI: the writer is given
 * a schema without them (aiBodySchemaFor), and every rewrite re-attaches the
 * version's own details untouched.
 *
 * Each value records where it came from. A value taken unchanged from the
 * business profile (Settings → Business) is already approved business
 * information; anything typed for this post has to be confirmed by a person
 * before the post can be approved (checkQuality → `details-unconfirmed`).
 */

export const DETAIL_KEYS = ['website', 'address', 'phone', 'email'] as const;
export type DetailKey = (typeof DETAIL_KEYS)[number];

export const DETAIL_LABELS: Record<DetailKey, string> = {
  website: 'Website',
  address: 'Address',
  phone: 'Phone',
  email: 'Email',
};

const PHONE_RE = /^\+?[0-9][0-9 ().\-/]{5,28}[0-9]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Why a value is not acceptable for its field, or null. */
export function detailProblem(key: DetailKey, value: string): string | null {
  const v = value.trim();
  if (!v) return 'Empty.';
  switch (key) {
    case 'website': {
      try {
        const u = new URL(v);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Use a web address starting with https://';
        if (!u.hostname.includes('.')) return 'That is not a full web address.';
        return null;
      } catch {
        return 'Use a full web address, e.g. https://example.com/page';
      }
    }
    case 'phone':
      return PHONE_RE.test(v) && v.replace(/\D/g, '').length >= 6 ? null : 'That does not look like a phone number.';
    case 'email':
      return EMAIL_RE.test(v) ? null : 'That does not look like an email address.';
    case 'address':
      // At least a street and a place ("12 Harbour Street, Leith").
      return v.length >= 8 && /\s/.test(v) ? null : 'Add the full address.';
  }
}

const detailSchema = z.object({
  value: z.string().trim().min(1).max(300),
  /** "profile": unchanged from the business profile; "user": typed for this post. */
  source: z.enum(['profile', 'user']).default('user'),
  /** A person confirmed this value is correct for this post. */
  confirmed: z.boolean().default(false),
});
export type PostDetail = z.infer<typeof detailSchema>;

export const postDetailsSchema = z
  .object({
    website: detailSchema.optional(),
    address: detailSchema.optional(),
    phone: detailSchema.optional(),
    email: detailSchema.optional(),
  })
  .superRefine((d, ctx) => {
    for (const key of DETAIL_KEYS) {
      const item = d[key];
      if (!item) continue;
      const problem = detailProblem(key, item.value);
      if (problem) ctx.addIssue({ code: 'custom', path: [key, 'value'], message: `${DETAIL_LABELS[key]}: ${problem}` });
    }
  });
export type PostDetails = z.infer<typeof postDetailsSchema>;

/** The details stored on a body (invalid or missing → none). */
export function detailsOf(body: unknown): PostDetails {
  const raw = (body as { details?: unknown } | null)?.details;
  if (!raw || typeof raw !== 'object') return {};
  const parsed = postDetailsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/** `body` with these details (or none) — everything else untouched. */
export function withDetails<T>(body: T, details: PostDetails | null | undefined): T {
  const copy = { ...((body ?? {}) as Record<string, unknown>) };
  delete copy.details;
  const kept = Object.fromEntries(DETAIL_KEYS.flatMap((k) => (details?.[k] ? [[k, details[k]]] : [])));
  if (Object.keys(kept).length) copy.details = kept;
  return copy as T;
}

/** Details still waiting for a person to confirm them. */
export function unconfirmedDetails(details: PostDetails): DetailKey[] {
  return DETAIL_KEYS.filter((k) => details[k] && !details[k]!.confirmed && details[k]!.source !== 'profile');
}

/** The lines a published post carries for its details, in a fixed order. */
export function renderDetails(details: PostDetails): string[] {
  return DETAIL_KEYS.flatMap((k) => {
    const v = details[k]?.value.trim();
    if (!v) return [];
    return [k === 'website' ? v : `${DETAIL_LABELS[k]}: ${v}`];
  });
}

/**
 * The business's approved facts (Settings → Business), as offered to every
 * post. Missing ones are simply absent — never guessed.
 */
export interface BusinessFacts {
  website: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * A value as stored on a post: "profile" (pre-approved) only when it is
 * exactly the business's own value; otherwise typed by the user, unconfirmed
 * unless they ticked confirm.
 */
export function makeDetail(
  key: DetailKey,
  value: string,
  facts: BusinessFacts,
  confirmed: boolean,
): PostDetail {
  const v = value.trim();
  const fromProfile = facts[key] !== null && facts[key]!.trim() === v;
  return { value: v, source: fromProfile ? 'profile' : 'user', confirmed: fromProfile || confirmed };
}

/**
 * Details as the server stores them: "profile" is re-derived from the real
 * business facts (a client cannot mark its own value pre-approved); a typed
 * value keeps the person's confirmation.
 */
export function normaliseDetails(details: PostDetails, facts: BusinessFacts): PostDetails {
  const out: PostDetails = {};
  for (const key of DETAIL_KEYS) {
    const d = details[key];
    if (d) out[key] = makeDetail(key, d.value, facts, d.source === 'profile' ? false : d.confirmed);
  }
  return out;
}
