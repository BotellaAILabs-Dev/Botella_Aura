/**
 * Which Meta the app under test is talking to.
 *
 * There are two modes and they are mutually exclusive by nature:
 *
 *   a plain dev server   Graph calls go to Meta. A fake token is refused, so
 *                        the suites that check "Aura never claims a publish
 *                        that did not happen" can run.
 *   `npm run sandbox`    Graph calls go to scripts/load/meta-stub.ts, which
 *                        accepts. The publishing paths can run instead
 *                        (`npm run sandbox check`).
 *
 * A suite written for the first mode, run against the second, reports failures
 * that look like broken refusal handling and are only the wrong mode. So it
 * asks, and says so, rather than reporting those.
 *
 * The app's own answer is what matters: these suites drive Meta through the
 * app's routes, so the override that counts is the server's, not this
 * process's. This process is checked too, for the suites that publish
 * in-process.
 */
import { usingGraphStub } from '@/lib/graph-base';

/** Ask the app whether it is pointed at a stand-in. Needs a signed-in cookie. */
export async function appUsesGraphStub(
  base: string,
  cookie: string,
): Promise<boolean | null> {
  try {
    const res = await fetch(`${base}/api/connectors/preflight`, {
      headers: { cookie },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { graphStub?: boolean } } & {
      graphStub?: boolean;
    };
    return body.data?.graphStub ?? body.graphStub ?? null;
  } catch {
    return null;
  }
}

/**
 * Stop with an explanation when the app, or this process, is sandboxed.
 * Exit code 2 — "could not run", the same code the suites use when an
 * external dependency is unavailable, never a pass.
 */
export async function requireRealMeta(args: {
  suite: string;
  /** Omitted by a suite that publishes in-process: only its own env matters. */
  base?: string;
  cookie?: string;
}): Promise<void> {
  const local = usingGraphStub();
  const app =
    args.base && args.cookie
      ? await appUsesGraphStub(args.base, args.cookie)
      : null;
  if (!local && app !== true) return;

  const which = [local && 'this process', app === true && 'the app'].filter(Boolean);
  const verb = which.length > 1 ? 'talk' : 'talks';
  console.log(
    `\nBLOCKED: ${which.join(' and ')} ${verb} to the local stand-in for Meta, not Meta.\n` +
      `\n${args.suite} checks what Aura does when Meta REFUSES a credential, which a\n` +
      `stand-in that accepts cannot show. Run it against a plain dev server:\n` +
      `\n    npm run dev\n` +
      `\nFor the sandbox instead, which checks the publishing paths:\n` +
      `\n    npm run sandbox check\n` +
      `\nBoth are real; they are different halves. See docs/SANDBOX.md.\n`,
  );
  process.exit(2);
}
