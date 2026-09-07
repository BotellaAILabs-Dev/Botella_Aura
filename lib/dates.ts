/**
 * Date formatting locale, pinned deliberately.
 *
 * `toLocaleDateString(undefined, …)` asks the *runtime* for its default
 * locale — and in a server-rendered React app there are two runtimes. Node
 * resolved to a day-first locale here while the browser used en-US, so the
 * server sent "7 September" and the client rendered "September 7". React
 * cannot reconcile differing text, so it discarded the server HTML for that
 * whole Suspense boundary and re-rendered it on the client:
 *
 *   Warning: Text content did not match.
 *     Server: "7 September"  Client: "September 7"
 *
 * That is a correctness bug (the date can visibly change after load) and a
 * performance one (the server's work for that subtree is thrown away). It
 * reproduces for any user whose browser locale differs from the server's,
 * which in production is most of them.
 *
 * Pinning a locale makes both runtimes agree. en-US matches the explicit
 * locale already used in server/memory/extraction.service.ts and the app's
 * English copy. Never pass `undefined` here — that is the bug this exists to
 * prevent.
 */
export const DATE_LOCALE = 'en-US';
