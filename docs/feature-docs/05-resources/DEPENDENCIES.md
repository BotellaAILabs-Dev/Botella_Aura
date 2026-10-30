# Dependencies — Botella Aura

Every package in `package.json` with its version, purpose and how many source files import it. Lockfile: `pnpm-lock.yaml` (pnpm ≥ 9). Node >=20.

_Generated from the git history and source code on 30 Oct 2026._

## Runtime dependencies

| Package | Version | Purpose | Files importing it | Docs |
| --- | --- | --- | --- | --- |
| `@anthropic-ai/sdk` | `^0.112.5` | Official Anthropic SDK — Claude calls in `server/ai/claude.ts` | 1 | [npm](https://www.npmjs.com/package/@anthropic-ai/sdk) |
| `@hookform/resolvers` | `^3.9.1` | Connects Zod schemas to react-hook-form validation | 4 | [npm](https://www.npmjs.com/package/@hookform/resolvers) |
| `@next-auth/prisma-adapter` | `^1.0.7` | Stores NextAuth users/accounts/sessions in Prisma | 1 | [npm](https://www.npmjs.com/package/@next-auth/prisma-adapter) |
| `@prisma/client` | `^5.22.0` | Generated, typed database client | 154 | [npm](https://www.npmjs.com/package/@prisma/client) |
| `@radix-ui/react-avatar` | `^1.1.1` | Accessible avatar primitive (design system) | 1 | [npm](https://www.npmjs.com/package/@radix-ui/react-avatar) |
| `@radix-ui/react-dialog` | `^1.1.2` | Accessible dialog/modal primitive | 3 | [npm](https://www.npmjs.com/package/@radix-ui/react-dialog) |
| `@radix-ui/react-dropdown-menu` | `^2.1.2` | Accessible dropdown menu primitive | 1 | [npm](https://www.npmjs.com/package/@radix-ui/react-dropdown-menu) |
| `@radix-ui/react-label` | `^2.1.0` | Accessible form label primitive | 1 | [npm](https://www.npmjs.com/package/@radix-ui/react-label) |
| `@radix-ui/react-slot` | `^1.1.0` | `asChild` composition for Button and others | 1 | [npm](https://www.npmjs.com/package/@radix-ui/react-slot) |
| `@resvg/resvg-js` | `2.6.2` | Renders SVG to PNG for branded marketing creatives (native, kept external) | 2 | [npm](https://www.npmjs.com/package/@resvg/resvg-js) |
| `@tanstack/react-query` | `^5.59.20` | Client data fetching and caching | 1 | [npm](https://www.npmjs.com/package/@tanstack/react-query) |
| `@vercel/functions` | `3.9.9` | `waitUntil` to finish background work (WhatsApp queue drain) after a response | 1 | [npm](https://www.npmjs.com/package/@vercel/functions) |
| `bcryptjs` | `^2.4.3` | Password hashing (pure JS, no native build) | 39 | [npm](https://www.npmjs.com/package/bcryptjs) |
| `class-variance-authority` | `^0.7.0` | Typed component variants (Button, Badge) | 2 | [npm](https://www.npmjs.com/package/class-variance-authority) |
| `clsx` | `^2.1.1` | Conditional class names | 1 | [npm](https://www.npmjs.com/package/clsx) |
| `fast-xml-parser` | `^5.10.1` | Parses RSS/Atom feeds for trends, news and competitor signals | 5 | [npm](https://www.npmjs.com/package/fast-xml-parser) |
| `lucide-react` | `^0.454.0` | Icon set | 148 | [npm](https://www.npmjs.com/package/lucide-react) |
| `next` | `14.2.18` | Framework: App Router, API routes, middleware, SSR | 163 | [npm](https://www.npmjs.com/package/next) |
| `next-auth` | `^4.24.10` | Authentication: credentials, Google, LinkedIn (OIDC) | 10 | [npm](https://www.npmjs.com/package/next-auth) |
| `node-html-parser` | `^9.0.0` | HTML to text for website ingestion and competitor diffs | 2 | [npm](https://www.npmjs.com/package/node-html-parser) |
| `nodemailer` | `^9.0.5` | SMTP email transport | 0 | [npm](https://www.npmjs.com/package/nodemailer) |
| `react` | `^18.3.1` | UI library | 99 | [npm](https://www.npmjs.com/package/react) |
| `react-dom` | `^18.3.1` | React DOM renderer | 0 | [npm](https://www.npmjs.com/package/react-dom) |
| `react-hook-form` | `^7.53.2` | Form state and validation | 4 | [npm](https://www.npmjs.com/package/react-hook-form) |
| `robots-parser` | `^3.0.1` | Honours robots.txt before fetching any site | 1 | [npm](https://www.npmjs.com/package/robots-parser) |
| `satori` | `0.12.2` | Lays out creatives (text, fonts, layout) as SVG | 2 | [npm](https://www.npmjs.com/package/satori) |
| `sharp` | `0.34.4` | Image processing: JPEG re-encode for Instagram, logo overlay and tints | 4 | [npm](https://www.npmjs.com/package/sharp) |
| `sonner` | `^1.7.0` | Toast notifications | 2 | [npm](https://www.npmjs.com/package/sonner) |
| `stripe` | `^17.7.0` | Stripe billing: Checkout, Portal, webhooks | 2 | [npm](https://www.npmjs.com/package/stripe) |
| `tailwind-merge` | `^2.5.4` | Merges conflicting Tailwind classes (`cn()` helper) | 1 | [npm](https://www.npmjs.com/package/tailwind-merge) |
| `tailwindcss-animate` | `^1.0.7` | Tailwind animation utilities | 0 | [npm](https://www.npmjs.com/package/tailwindcss-animate) |
| `unpdf` | `^1.6.2` | Extracts text from uploaded PDFs | 1 | [npm](https://www.npmjs.com/package/unpdf) |
| `zod` | `^3.23.8` | Schema validation for every input, AI output and handoff contract | 114 | [npm](https://www.npmjs.com/package/zod) |

## Development dependencies

| Package | Version | Purpose | Files importing it | Docs |
| --- | --- | --- | --- | --- |
| `@testing-library/dom` | `^10.4.0` | DOM testing utilities (peer of react testing library) | 0 | [npm](https://www.npmjs.com/package/@testing-library/dom) |
| `@testing-library/jest-dom` | `^6.6.3` | Extra DOM matchers for tests | 0 | [npm](https://www.npmjs.com/package/@testing-library/jest-dom) |
| `@testing-library/react` | `^16.0.1` | Component tests | 0 | [npm](https://www.npmjs.com/package/@testing-library/react) |
| `@types/bcryptjs` | `^2.4.6` | Types | 0 | [npm](https://www.npmjs.com/package/@types/bcryptjs) |
| `@types/node` | `^20.17.6` | Types | 0 | [npm](https://www.npmjs.com/package/@types/node) |
| `@types/nodemailer` | `^8.0.1` | Types | 0 | [npm](https://www.npmjs.com/package/@types/nodemailer) |
| `@types/react` | `^18.3.12` | Types | 0 | [npm](https://www.npmjs.com/package/@types/react) |
| `@types/react-dom` | `^18.3.1` | Types | 0 | [npm](https://www.npmjs.com/package/@types/react-dom) |
| `@vitejs/plugin-react` | `^4.3.3` | React support for Vitest | 0 | [npm](https://www.npmjs.com/package/@vitejs/plugin-react) |
| `autoprefixer` | `^10.4.20` | CSS vendor prefixes (PostCSS) | 0 | [npm](https://www.npmjs.com/package/autoprefixer) |
| `eslint` | `^8.57.1` | Linting | 0 | [npm](https://www.npmjs.com/package/eslint) |
| `eslint-config-next` | `14.2.18` | Next.js lint rules | 0 | [npm](https://www.npmjs.com/package/eslint-config-next) |
| `eslint-config-prettier` | `^9.1.0` | Turns off rules that clash with Prettier | 0 | [npm](https://www.npmjs.com/package/eslint-config-prettier) |
| `jsdom` | `^25.0.1` | Browser-like environment for component tests | 0 | [npm](https://www.npmjs.com/package/jsdom) |
| `playwright-core` | `1.56.1` | Drives Chromium for `verify:responsive` screenshots | 2 | [npm](https://www.npmjs.com/package/playwright-core) |
| `postcss` | `^8.4.49` | CSS pipeline for Tailwind | 0 | [npm](https://www.npmjs.com/package/postcss) |
| `prettier` | `^3.3.3` | Formatting | 0 | [npm](https://www.npmjs.com/package/prettier) |
| `prettier-plugin-tailwindcss` | `^0.6.9` | Sorts Tailwind classes | 0 | [npm](https://www.npmjs.com/package/prettier-plugin-tailwindcss) |
| `prisma` | `^5.22.0` | Prisma CLI: migrate, generate, studio | 0 | [npm](https://www.npmjs.com/package/prisma) |
| `tailwindcss` | `^3.4.14` | Utility-first CSS | 0 | [npm](https://www.npmjs.com/package/tailwindcss) |
| `tsx` | `^4.19.2` | Runs TypeScript scripts (verify suites, seeds, tooling) | 0 | [npm](https://www.npmjs.com/package/tsx) |
| `typescript` | `^5.6.3` | Type checker (strict) | 0 | [npm](https://www.npmjs.com/package/typescript) |
| `vitest` | `^2.1.4` | Unit test runner | 0 | [npm](https://www.npmjs.com/package/vitest) |

## Native / build-approved packages

pnpm 10+ blocks install scripts unless approved. `package.json → pnpm.onlyBuiltDependencies`: `@prisma/client`, `@prisma/engines`, `prisma`, `esbuild`, `unrs-resolver`, `sharp`.

`@resvg/resvg-js` is kept out of the server bundle (`serverComponentsExternalPackages` in `next.config.mjs`); `sharp` is external by default in Next.js; the creative fonts in `assets/fonts` are traced into the bundle.

## npm scripts

| Script | Command |
| --- | --- |
| `dev` | `next dev` |
| `build` | `node scripts/package-extension.mjs && prisma generate && next build` |
| `vercel-build` | `node scripts/package-extension.mjs && prisma generate && DIRECT_URL="${DIRECT_URL:-$DATABASE_URL}" node scripts/migrate-deploy.mjs && next build` |
| `netlify:build` | `node scripts/package-extension.mjs && prisma generate && prisma migrate deploy && next build` |
| `start` | `next start` |
| `start:prod` | `prisma migrate deploy && next start` |
| `lint` | `next lint` |
| `format` | `prettier --write "**/*.{ts,tsx,js,jsx,json,md,css}"` |
| `format:check` | `prettier --check "**/*.{ts,tsx,js,jsx,json,md,css}"` |
| `typecheck` | `tsc --noEmit` |
| `test` | `vitest run` |
| `test:watch` | `vitest` |
| `verify:graphics` | `tsx scripts/verify-graphics.ts` |
| `verify:briefing` | `tsx scripts/verify-briefing.ts` |
| `verify:pages` | `tsx scripts/verify-pages.ts` |
| `verify:onboarding` | `tsx scripts/verify-onboarding.ts` |
| `verify:materials` | `tsx scripts/verify-materials.ts` |
| `verify:sipn` | `tsx scripts/verify-sipn.ts` |
| `verify:publishing` | `tsx scripts/verify-publishing.ts` |
| `verify:context-sources` | `tsx scripts/verify-context-sources.ts` |
| `verify:opportunities` | `tsx scripts/verify-opportunities.ts` |
| `verify:signals` | `tsx scripts/verify-signals.ts` |
| `verify:detection` | `tsx scripts/verify-detection.ts` |
| `verify:ai-detection` | `tsx scripts/verify-ai-detection.ts` |
| `verify:recommendation-handoff` | `tsx scripts/verify-recommendation-handoff.ts` |
| `verify:access` | `tsx scripts/verify-access.ts` |
| `verify:flow` | `tsx scripts/verify-flow.ts` |
| `verify:recommendations` | `tsx scripts/verify-recommendations.ts` |
| `verify:engine` | `tsx scripts/verify-engine.ts` |
| `verify:guardrails` | `tsx scripts/verify-guardrails.ts` |
| `verify:prioritization` | `tsx scripts/verify-prioritization.ts` |
| `verify:lifecycle` | `tsx scripts/verify-lifecycle.ts` |
| `verify:suggestions` | `tsx scripts/verify-suggestions.ts` |
| `verify:home` | `tsx scripts/verify-home.ts` |
| `verify:what-matters` | `tsx scripts/verify-what-matters.ts` |
| `verify:modules` | `tsx scripts/verify-modules.ts` |
| `verify:context-handoff` | `tsx scripts/verify-context-handoff.ts` |
| `verify:autosuggest` | `tsx scripts/verify-autosuggest.ts` |
| `verify:history` | `tsx scripts/verify-history.ts` |
| `verify:quality` | `tsx scripts/verify-quality.ts` |
| `verify:readiness` | `tsx scripts/verify-readiness.ts` |
| `verify:recommendation-security` | `tsx scripts/verify-recommendation-security.ts` |
| `verify:sprint8` | `tsx scripts/verify-sprint8.ts` |
| `verify:planner` | `tsx scripts/verify-planner.ts` |
| `verify:creation` | `tsx scripts/verify-creation.ts` |
| `verify:content-brief` | `tsx scripts/verify-content-brief.ts` |
| `verify:generation-context` | `tsx scripts/verify-generation-context.ts` |
| `verify:contextual-generation` | `tsx scripts/verify-contextual-generation.ts` |
| `verify:visual-context` | `tsx scripts/verify-visual-context.ts` |
| `verify:variations` | `tsx scripts/verify-variations.ts` |
| `verify:review` | `tsx scripts/verify-review.ts` |
| `verify:compliance` | `tsx scripts/verify-compliance.ts` |
| `verify:unified-review` | `tsx scripts/verify-unified-review.ts` |
| `verify:creative` | `tsx scripts/verify-creative.ts` |
| `verify:approval` | `tsx scripts/verify-approval.ts` |
| `verify:versions` | `tsx scripts/verify-versions.ts` |
| `verify:trace` | `tsx scripts/verify-trace.ts` |
| `verify:whatsapp` | `tsx scripts/verify-whatsapp.ts` |
| `verify:whatsapp-link` | `tsx scripts/verify-whatsapp-link.ts` |
| `verify:whatsapp-agent` | `tsx scripts/verify-whatsapp-agent.ts` |
| `verify:meta` | `tsx scripts/verify-meta.ts` |
| `verify:multi-publish` | `tsx scripts/verify-multi-publish.ts` |
| `verify:whatsapp-social` | `tsx scripts/verify-whatsapp-social.ts` |
| `verify:instagram-api` | `tsx scripts/verify-instagram-api.ts` |
| `verify:permissions` | `tsx scripts/verify-permissions.ts` |
| `verify:sprint9` | `tsx scripts/verify-sprint9.ts` |
| `verify:failure-recovery` | `tsx scripts/verify-failure-recovery.ts` |
| `verify:responsive` | `tsx scripts/verify-responsive.ts` |
| `verify:connections` | `tsx scripts/verify-connections.ts` |
| `verify:execution` | `tsx scripts/verify-execution.ts` |
| `verify:scheduler` | `tsx scripts/verify-scheduler.ts` |
| `verify:one-click` | `tsx scripts/verify-one-click.ts` |
| `verify:content-control` | `tsx scripts/verify-content-control.ts` |
| `verify:image-preview` | `tsx scripts/verify-image-preview.ts` |
| `whatsapp:check` | `tsx scripts/whatsapp-check.ts` |
| `demo:whatsapp` | `tsx scripts/demo-whatsapp.ts` |
| `whatsapp:local` | `node scripts/sandbox.mjs` |
| `sandbox` | `node scripts/sandbox.mjs` |
| `verify:sandbox` | `tsx scripts/verify-sandbox.ts` |
| `env:check` | `tsx scripts/env-check.ts` |
| `auth:endpoints` | `tsx scripts/auth-endpoints.ts` |
| `verify:sprint9:all` | `tsx scripts/verify-sprint9-all.ts` |
| `load:meta-stub` | `tsx scripts/load/meta-stub.ts` |
| `load:whatsapp` | `tsx scripts/load/whatsapp-load.ts` |
| `verify:fact-check` | `tsx scripts/verify-fact-check.ts` |
| `verify:content-studio` | `tsx scripts/verify-content-studio.ts` |
| `db:generate` | `prisma generate` |
| `db:migrate` | `prisma migrate dev` |
| `db:migrate:deploy` | `prisma migrate deploy` |
| `db:push` | `prisma db push` |
| `db:rehearse` | `tsx scripts/migration-rehearsal.ts` |
| `db:seed` | `tsx prisma/seed.ts` |
| `db:seed:demo` | `tsx prisma/seed.ts && tsx prisma/seed-demo.ts` |
| `seed:sipn` | `tsx prisma/seed-sipn.ts` |
| `db:studio` | `prisma studio` |
| `ext:package` | `node scripts/package-extension.mjs` |
| `postinstall` | `prisma generate` |
