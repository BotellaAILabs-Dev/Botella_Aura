# Blockers, issues and regression testing

How the team records, prioritises and closes problems in Jira, and how the
core workflow is regression tested before each release. The current blocker
register is at the end.

## 1. Jira set-up

**Issue types**

| Type | Use for |
| --- | --- |
| Blocker | Stops a user or the team testing a core workflow (sign-in, connecting an account, generating or approving content, publishing). |
| Bug | Something works wrongly but there is a way round it. |
| Usability | Works, but people get stuck or confused. |
| Regression | Worked in an earlier release and no longer does. Always link the release it broke in. |

**Priority**

| Priority | Meaning | Response |
| --- | --- | --- |
| P0 — Critical | No one can test or use a core workflow | Fix or work round within 1 working day |
| P1 — High | A core workflow fails for some users or in some cases | This sprint |
| P2 — Medium | A secondary feature fails, or a core one is awkward | Next sprint |
| P3 — Low | Cosmetic | Backlog |

**Labels:** `auth`, `linkedin`, `meta`, `content-studio`, `approval`,
`onboarding`, `publishing`, `website`, `ai`, `config`, `external-dependency`
(waiting on LinkedIn, Meta, Google or Shopify, not on our code).

**Workflow:** To do → In progress → In review → Ready to test → Done.
A ticket reaches **Done** only after someone other than the developer has
re-run its reproduction steps on the release build.

**Every blocker and bug states:**

1. What happened, and what should have happened
2. Steps to reproduce, from a fresh login
3. Where: local, staging or production, plus the URL and the workspace
4. Evidence: screenshot, error text, or the failing line from `pnpm regression:core`
5. Owner and priority, set at the weekly meeting at the latest
6. For `external-dependency`: what we are waiting for, from whom, and since when

## 2. Regression testing

Run before every release, and after any change to sign-in, connections,
Content Studio or approval:

```
pnpm regression:core              # config, OAuth, migrations, unit tests, setup, Content Studio
pnpm regression:core --with-app   # with `pnpm dev` running: also approval, connections, Meta
```

Paste the summary it prints into the sprint's regression ticket. Every
`FAIL` gets a Blocker or Bug ticket, or a comment on its existing one.

| Step | What it proves |
| --- | --- |
| `env:check` | Every integration that should be on has its settings |
| `check:oauth` | LinkedIn, Google and Meta accept this deployment's redirect URLs, so sign-in and Connect will not fail with a provider error page |
| migrations | The database has every table the code reads |
| unit tests | ~2,400 tests across all features |
| `verify:onboarding` | What a user types in setup reaches the content prompts |
| `verify:content-studio` | Real AI drafts: platform limits, distinct versions, quality and compliance checks, rewrites, undo, approval blocked while a problem remains |
| `verify:approval` | Only owners and admins approve; an edit after approval reopens it |
| `verify:connections`, `verify:meta` | Connection records and the Facebook / Instagram flow |

**Manual pass, on a fresh account:** sign up → create a workspace →
fill About My Business (including Products) → connect LinkedIn → generate
a LinkedIn post from your own prompt → check it is about the prompt → make
two variations → edit a field → submit → approve as an admin → schedule.
Log anything that is wrong or confusing as Bug or Usability.

**Prompt relevance:** Content Studio now refuses to save a first draft that
shares none of the subject words of the person's prompt, and rewrites it
(`off-brief`). One that covers few of them is flagged for review.
Variations are held to the original draft (`topic-drift`). When testing, use
real prompts with a clear subject, e.g. *"Diwali offer on the gift box"* or
*"Announce our Hyderabad office opening"*, and check each caption, subtitle
and variation stays on it.

## 3. Blocker register — 30 October 2026

Found by checking against the providers and the running configuration, not by
reading the code alone.

| # | Priority | Blocker | Evidence | Fix | Owner |
| --- | --- | --- | --- | --- | --- |
| B-1 | P0 | **Content Studio text generation times out.** `.env` pins `GEMINI_MODEL="gemini-flash-latest"`. | That model gave no answer in 90 s to a two-caption request; the default `gemini-3.5-flash-lite` answered in 1.9 s. | **Code fixed:** a pinned model that times out or is not found now falls back to the default, and is skipped for 10 minutes. **Also do:** delete the `GEMINI_MODEL` line from `.env`. | |
| B-2 | P0 | **Sign in with LinkedIn and Connect LinkedIn fail** — locally and on the live site. | LinkedIn: "redirect_uri does not match the registered value" for both. The LinkedIn app only has `http://localhost:3000/api/linkedin/callback`; the app runs on 3001. | In LinkedIn Developers → the app → Auth → Authorized redirect URLs, add the four URLs `pnpm check:oauth` and `pnpm check:oauth https://botellaaura1.netlify.app` mark ✗. Re-run until ✓. | |
| B-3 | P1 | **Google Analytics / Search Console connection fails.** | Google: `redirect_uri_mismatch` for `/api/connectors/google/callback` (Google sign-in itself is fine). | Add the URL in Google Cloud Console → Credentials → the OAuth client → Authorised redirect URIs. | |
| B-4 | P0 | **Facebook / Instagram cannot be connected.** | `META_CLIENT_ID` / `META_CLIENT_SECRET` not set; Business Verification not started; App Review not submitted. | Create the Meta app, set the two values, add the redirect URL, run `pnpm check:oauth`, then `pnpm verify:meta`. Start Business Verification. `external-dependency` | |
| B-5 | P1 | **Local database is behind the code.** | `prisma migrate status`: `20261030090000_website_publishing` not applied. Pages that read the business context fail until it is. | `npx prisma migrate deploy` (deploys run it automatically). | |
| B-6 | P2 | **No Anthropic key.** | `ANTHROPIC_API_KEY` is empty, so Gemini writes everything (the code recommends Anthropic for anything a customer reads). Defaults updated to the current models in case one is added. | Decide whether to add a key. | |
| B-7 | P1 | **LinkedIn Company Page posting and analytics.** | Needs LinkedIn Community Management API approval (weeks). | Apply now. `external-dependency` | |

## 4. For later sprints

Known issues that do not block testing:

- **Scheduled posts are only sent once a day.** The Vercel cron runs daily; an
  external 5-minute caller is recommended (`docs/SCHEDULER.md`).
- **LinkedIn tokens cannot be refreshed** on self-serve apps; people must
  reconnect when one expires (comes with B-7).
- **Website publishing has not been run against a real site** — run
  `pnpm verify:websites` (`docs/WEBSITE-PUBLISHING.md`).
- **Leftover local files break `next build`** in the working copy
  (`app/api/sandbox/reset/route.ts`); not in the repository.
- **AI draft quality still needs a person:** score a week of Botella AI
  drafts as use / edit / reject and record the share usable with light edits.
