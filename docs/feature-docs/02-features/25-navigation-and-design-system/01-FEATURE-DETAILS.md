# Navigation, Dashboard Shell & Design System

> The frame every Aura screen sits in: the public home page, the root layout, the protected dashboard shell (sidebar, topbar with workspace switcher and account menu, mobile drawer), the six-group sidebar navigation driven by one config file, the shared loading and error boundaries, and the token-based design system with its `components/ui` primitives. It exists so that every feature looks and behaves the same, navigation stays small enough to scan, and a slow or failing page never leaves the user staring at a frozen or blank screen.

## 1. Overview

- **Root layout** (`app/layout.tsx`): Inter font as `--font-sans`, global CSS, title template `%s · Botella Aura`, and client `Providers` (TanStack Query + `Toaster`).
- **Public home** (`app/page.tsx`): marketing page with features and a pricing preview; signed-in users are redirected to `/dashboard`.
- **Dashboard layout** (`app/dashboard/layout.tsx`): requires a user, resolves the active workspace, redirects to `/onboarding` if there is none, renders `DashboardShell` and the background `JobIndicator`.
- **Navigation config** (`lib/nav.ts`): `NAV_GROUPS` (six groups) and `NAV_ITEMS` (20 pages), plus `navByGroup()`, `groupForPath()`, `findNavItem()`.
- **Design system**: HSL CSS variables in `app/globals.css` (light and `.dark`), mapped to Tailwind in `tailwind.config.ts`, documented in `DESIGN.md`; shadcn/ui-style primitives in `components/ui/`.

## 2. User-facing behaviour

| Surface | File | Behaviour | Who |
| --- | --- | --- | --- |
| Home page `/` | `app/page.tsx` | Header with "Log in" and "Start free"; hero; six feature cards; pricing preview for Starter / Growth / Agency from `PLAN_LIMITS` (Growth featured) | Public; signed-in users go to `/dashboard` |
| Desktop sidebar | `components/dashboard/dashboard-shell.tsx` | Fixed 16rem (`w-64`) sidebar from `lg` up: logo (links to `/dashboard`), `SidebarNav`, footer "Human-in-the-loop. Aura never acts without your approval." | Any member |
| Mobile drawer | same | Below `lg`, a menu button opens a modal drawer (`w-72`, max 85%) with the same nav; clicking a link or the backdrop closes it | Any member |
| Topbar | same | Sticky, opaque, 4rem high: menu button (mobile), `CompanySwitcher`, `UserMenu` | Any member |
| Sidebar navigation | `components/dashboard/sidebar-nav.tsx` | Six group links. Only the group you are in expands to show its pages. Group of one item links straight to that page. Hover shows the group or page `description` as a tooltip. The clicked link highlights immediately, before navigation completes. | Any member |
| Account menu | `components/dashboard/user-menu.tsx` | Avatar trigger; name and email; "Settings" and "Company profile" (both `/dashboard/settings`); "Log out" (`signOut`, back to `/login`) | Any member |
| Recommendation context bar | rendered by the shell inside `Suspense` | Shows the Aura recommendation being worked on (`?rec=`) across modules (owned by the recommendations feature) | Any member |
| Loading state | `app/dashboard/loading.tsx` | Skeleton page header, three skeleton cards, five skeleton rows while a dashboard route loads | Any member |
| Error state | `app/dashboard/error.tsx` | "This page didn't load" card inside the shell: error message, digest reference ("quote this if you report it"), "Try again", "Back to dashboard", "Check settings" | Any member |
| Placeholder page | `components/dashboard/coming-soon.tsx` | "Coming soon" page whose title, icon and description come from the nav config | Not currently used by any route |

### Navigation map (`lib/nav.ts`)

| Group | Group link | Pages (label -> route) |
| --- | --- | --- |
| Home | `/dashboard` | Home `/dashboard`; Aura Suggests `/dashboard/suggestions`; Review & approve `/dashboard/review` |
| Your market | `/dashboard/intelligence` | Marketing health `/dashboard/intelligence`; Market trends `/dashboard/trends`; Opportunities `/dashboard/opportunities`; Competitors `/dashboard/competitors` |
| Create | `/dashboard/content` | Content plan `/dashboard/planner`; Content Studio `/dashboard/content`; Publishing `/dashboard/executions`; Campaigns `/dashboard/campaigns` |
| Customers | `/dashboard/leads` | Leads `/dashboard/leads`; Outreach `/dashboard/outreach`; Comments & replies `/dashboard/engagement` |
| Results | `/dashboard/analytics` | Results `/dashboard/analytics`; What works for you `/dashboard/memory` |
| Setup | `/dashboard/settings` | About my business `/dashboard/business`; Your tools `/dashboard/connectors`; WhatsApp assistant `/dashboard/whatsapp-assistant`; Settings `/dashboard/settings` |

All 20 items have `ready: true`; an item with `ready: false` would show a "Soon" pill in the sidebar.

## 3. How it works

### Which group is open (`groupForPath`)
1. For every nav item, a path matches if it equals the item's `href` or starts with `href + '/'`; `/dashboard` itself matches only exactly.
2. The **longest** matching `href` wins, so `/dashboard` (a prefix of everything) does not swallow every route.
3. If no item matches (e.g. a detail route), the path is assigned to the group whose own `href` it sits under (`startsWith(group.href + '/')`).
4. Fallback: `home`.

### Sidebar rendering (`SidebarNav`)
- `current = pending ?? pathname`. `pending` is set on click and cleared when `usePathname()` changes, so the target lights up immediately.
- A group link is "active" (primary tint) when its group is open and either it has a single item or none of its child pages is the current one.
- A page link is current on an exact match or a sub-route (`/dashboard` exact only), and gets `aria-current="page"`.
- Links call `router.prefetch(href)` on mouse enter, focus and touch start, because dashboard routes are `force-dynamic` and Next's automatic prefetch only fetches the loading skeleton.

### Dashboard guard and shell
- `app/dashboard/layout.tsx`: `requireUser()` -> `resolveActiveCompany(user.id)` -> redirect `/onboarding` if no active company -> `DashboardShell` with user name/email/image, the company list and the active id.
- The main column is `max-w-6xl` with responsive padding; the topbar is opaque (`bg-card`) rather than translucent with backdrop blur, to avoid per-frame re-blur on scroll.

### Providers (`app/providers.tsx`)
- `QueryClient` defaults: `staleTime: 30_000`, `refetchOnWindowFocus: false`, `retry: 1`.
- `Toaster` (sonner) mounted once; `toast` is re-exported from `components/ui/toaster.tsx`.
- No NextAuth `SessionProvider` (the session is read on the server).

### Design tokens (`app/globals.css`, `tailwind.config.ts`)

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--background` | `0 0% 100%` | `229 27% 7%` | App background |
| `--foreground` | `222 47% 11%` | `210 40% 98%` | Primary text |
| `--primary` | `250 84% 60%` | `250 84% 67%` | Accent: CTAs, active nav, focus ring |
| `--muted` / `--muted-foreground` | `210 40% 96%` / `215 16% 47%` | `223 24% 14%` / `215 20% 65%` | Secondary surfaces and text |
| `--accent` / `--accent-foreground` | `250 60% 96%` / `250 84% 42%` | `250 30% 20%` / `250 84% 85%` | Tinted surfaces |
| `--destructive` | `0 72% 51%` | `0 63% 55%` | Errors |
| `--success` | `142 71% 45%` | `142 60% 48%` | Approved / published |
| `--warning` | `38 92% 50%` | `38 92% 55%` | Pending approval |
| `--border` / `--input` | `214 32% 91%` | `223 20% 18%` / `223 20% 20%` | Hairlines, fields |
| `--ring` | `250 84% 60%` | `250 84% 67%` | Focus ring |
| `--radius` | `0.75rem` | — | `rounded-lg`; `md` = radius - 2px; `sm` = radius - 4px |

Also: `--card`, `--popover`, `--secondary` and their foregrounds. Tailwind adds four soft shadows (`xs`, `sm`, `md`, `lg`), keyframes `accordion-down`, `accordion-up`, `fade-in` (0.3 s), and `darkMode: ['class']`. A global `:focus-visible` rule applies `ring-2 ring-ring ring-offset-2`. `.aura-gradient` is the radial primary-tinted wash used on auth, onboarding and the home page.

### Primitives (`components/ui/`)

| Component | Notes |
| --- | --- |
| `button.tsx` | `cva` variants `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`; sizes `default` (h-10), `sm` (h-9), `lg` (h-11), `icon`; `asChild` (Radix Slot) and `loading` |
| `badge.tsx` | Variants `default`, `secondary`, `outline`, `success`, `warning`, `destructive`, `muted`; `statusBadgeVariant()` maps `DRAFT` -> muted, `PENDING_APPROVAL` -> warning, `APPROVED` -> default, `REJECTED` -> destructive, `PUBLISHED` -> success |
| `card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, and footer |
| `dialog.tsx` | Radix Dialog wrapper (focus trap, Escape) |
| `dropdown-menu.tsx` | Radix DropdownMenu wrapper |
| `avatar.tsx` | Radix Avatar with image and initials fallback |
| `input.tsx`, `textarea.tsx`, `label.tsx` | Form primitives (`label` on Radix Label) |
| `empty-state.tsx` | Icon, title, description block for zero-data screens |
| `skeleton.tsx` | `Skeleton`, `SkeletonPageHeader`, `SkeletonCard`, `SkeletonRows` (shape-only, no spinner) |
| `toaster.tsx` | Themed sonner `Toaster` and `toast` |
| `tag-input.tsx` | Chip input: Enter or comma commits, Backspace on empty removes last |
| `local-time.tsx` | Timestamp in the viewer's time zone without hydration mismatch |
| `retrying-image.tsx` | Plain `<img>` that retries a failed load twice before showing a "didn't load" state with retry |
| `image-lightbox.tsx` | Full-screen image preview on Radix Dialog; previous/next and arrow keys |

The `cn()` helper (`lib/utils.ts`) is `twMerge(clsx(...))`. `Logo` lives in `components/brand/logo.tsx`.

## 4. Code map

| Layer | File | Responsibility |
| --- | --- | --- |
| Layout | `app/layout.tsx` | Root HTML, Inter font, metadata, `Providers` |
| Layout | `app/providers.tsx` | QueryClient + Toaster |
| Page | `app/page.tsx` | Public marketing home and pricing preview |
| Layout | `app/dashboard/layout.tsx` | Auth + workspace guard, shell, `JobIndicator` |
| Boundary | `app/dashboard/loading.tsx` | Shared skeleton loading UI |
| Boundary | `app/dashboard/error.tsx` | Dashboard error boundary |
| Component | `components/dashboard/dashboard-shell.tsx` | Sidebar, mobile drawer, topbar, main column |
| Component | `components/dashboard/sidebar-nav.tsx` | Six-group navigation with pending highlight and prefetch |
| Component | `components/dashboard/user-menu.tsx` | Account dropdown and log out |
| Component | `components/dashboard/page-header.tsx` | `PageHeader` (title `text-2xl font-semibold`, description, actions) |
| Component | `components/dashboard/coming-soon.tsx` | Placeholder page from nav config |
| Component | `components/dashboard/company-switcher.tsx` | Topbar workspace switcher (feature 02) |
| Component | `components/ui/*` | Design-system primitives (section 3) |
| Lib | `lib/nav.ts` | `NAV_GROUPS`, `NAV_ITEMS`, `navByGroup`, `groupForPath`, `findNavItem` |
| Lib | `lib/utils.ts` | `cn`, `getInitials`, `slugify` |
| Styles | `app/globals.css` | Tokens (light + dark), base styles, focus ring, `.aura-gradient` |
| Config | `tailwind.config.ts` | Token mapping, radius, shadows, animations |
| Docs | `DESIGN.md` | Design rationale and conventions |
| Tests | `tests/nav-clarity.test.ts`, `tests/image-lightbox.test.tsx` | See section 10 |

## 5. Data model

Not applicable. The shell reads the user from the session and the workspace list via `getCompaniesForUser` (feature 02); it owns no models.

## 6. API endpoints

Not applicable. The feature has no API routes of its own; see [../../04-api/INTERNAL-API.md](../../04-api/INTERNAL-API.md) for the routes the shell's components call (e.g. NextAuth sign-out).

## 7. External services

| Service | Used for | Env vars |
| --- | --- | --- |
| Google Fonts via `next/font/google` | Inter, self-hosted at build time | none |

See [../../06-environment/ENVIRONMENT-VARIABLES.md](../../06-environment/ENVIRONMENT-VARIABLES.md).

## 8. Background jobs & cron

Not applicable. (The shell mounts `JobIndicator`, which shows progress of generation jobs owned by another feature.)

## 9. Security & permissions

- `/dashboard/*` is protected by `middleware.ts`; the dashboard layout calls `requireUser()` again and requires an active workspace from the user's own memberships.
- The navigation is the same for every role; pages and API routes enforce RBAC themselves (feature 02).
- The error boundary shows `error.message` and the digest; server-side errors reach the client with Next's redacted message plus digest.
- The public home and root layout read no workspace data.

## 10. Testing

| File | Covers |
| --- | --- |
| `tests/nav-clarity.test.ts` | Labels name outcomes not machinery, do not lead with technology, are short and distinct; every page has a one-line outcome description; at most a handful of groups, every page in a real group, no empty group, every group link exists |
| `tests/image-lightbox.test.tsx` | `ImageLightbox` behaviour and Content Studio opening the preview |
| `tests/about-my-business.test.tsx`, `tests/context-questions.test.tsx`, `tests/graphic-studio.test.tsx` | Render feature components built on the `components/ui` primitives |

End-to-end: `pnpm verify:responsive` (app running) loads pages in Chromium at phone, tablet and desktop widths and checks for a 200 without an error boundary, no horizontal scroll, and a visible page header; screenshots go to `RESPONSIVE_SHOTS_DIR` (default `./.responsive-shots`).

## 11. Configuration & limits

| Setting | Value | Source |
| --- | --- | --- |
| Sidebar width | `w-64` desktop, `w-72` (max 85%) mobile drawer | `dashboard-shell.tsx` |
| Desktop breakpoint | `lg` | `dashboard-shell.tsx` |
| Content width | `max-w-6xl` | `dashboard-shell.tsx` |
| Container max | `1400px` at `2xl`, padding `2rem` | `tailwind.config.ts` |
| Query defaults | stale 30 s, no refetch on focus, 1 retry | `app/providers.tsx` |
| Nav size | 6 groups, 20 pages | `lib/nav.ts` |

## 12. Known limitations & future work

- Dark-mode tokens exist (`.dark`, `darkMode: ['class']`) but nothing in the app sets the `dark` class, so there is no theme switch.
- `ComingSoon` and the `ready` / `sprint` fields remain from earlier sprints; every item is `ready: true` and no route renders `ComingSoon`.
- "Settings" and "Company profile" in the account menu go to the same page.
- The sidebar has no per-role filtering; a VIEWER sees links to pages where they cannot act.
- `DESIGN.md` lists `Logo` among the `components/ui/` primitives, but the component lives in `components/brand/logo.tsx`.

## 13. Related documents

- [DESIGN.md](../../../../DESIGN.md) — design system rationale
- [EMPTY-STATES.md](../../../EMPTY-STATES.md), [SCREENS-REVIEW-STATUS.md](../../../SCREENS-REVIEW-STATUS.md), [AURA-MODULES.md](../../../AURA-MODULES.md)
- [SPRINT-1-TECHNICAL.md](../../../SPRINT-1-TECHNICAL.md) — original shell and component library
- [01-authentication-and-accounts](../01-authentication-and-accounts/01-FEATURE-DETAILS.md)
- [02-workspaces-team-and-roles](../02-workspaces-team-and-roles/01-FEATURE-DETAILS.md)
- [03-onboarding-and-guided-setup](../03-onboarding-and-guided-setup/01-FEATURE-DETAILS.md)
- [22-billing-and-plans](../22-billing-and-plans/01-FEATURE-DETAILS.md)
