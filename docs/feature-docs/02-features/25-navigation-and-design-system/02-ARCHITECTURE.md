# Navigation, Dashboard Shell & Design System — Architecture

The dashboard is one server layout that guards access and hands the user and workspace list to a client shell. Navigation is data: `lib/nav.ts` declares groups and pages once, and `SidebarNav` renders whatever group the current path belongs to. Styling flows from CSS variables through Tailwind into the `components/ui` primitives.

## Component architecture

```mermaid
flowchart TD
  Root["app/layout.tsx<br/>Inter, metadata"]
  Prov["app/providers.tsx<br/>QueryClient, Toaster"]
  Home["app/page.tsx<br/>public home"]
  DashLayout["app/dashboard/layout.tsx"]
  Loading["app/dashboard/loading.tsx"]
  ErrorB["app/dashboard/error.tsx"]
  subgraph Shell["Client shell"]
    ShellC["dashboard-shell.tsx"]
    Nav["sidebar-nav.tsx"]
    Switcher["company-switcher.tsx"]
    UserM["user-menu.tsx"]
  end
  NavCfg["lib/nav.ts<br/>NAV_GROUPS, NAV_ITEMS"]
  Helpers["auth-helpers.ts and active-company.ts"]
  Pages["feature pages"]
  subgraph DS["Design system"]
    Tokens["app/globals.css tokens"]
    TW["tailwind.config.ts"]
    UI["components/ui primitives"]
  end
  DB[("PostgreSQL<br/>memberships")]

  Root --> Prov
  Root --> Home
  Root --> DashLayout
  DashLayout --> Helpers
  Helpers --> DB
  DashLayout --> ShellC
  ShellC --> Nav
  ShellC --> Switcher
  ShellC --> UserM
  Nav --> NavCfg
  ShellC --> Pages
  DashLayout --> Loading
  DashLayout --> ErrorB
  Tokens --> TW
  TW --> UI
  UI --> Pages
  UI --> ShellC
```

The root layout wraps everything with fonts and providers. The dashboard layout is the only place that loads data for the shell (session and memberships); the shell's children are the feature pages, with `loading.tsx` and `error.tsx` as the shared fallbacks. The design-system stack on the right is pure styling with no runtime data.

## Main flow

```mermaid
sequenceDiagram
  participant B as Browser
  participant MW as middleware.ts
  participant L as dashboard/layout.tsx
  participant H as auth-helpers and active-company
  participant DB as PostgreSQL
  participant S as DashboardShell
  participant N as SidebarNav
  B->>MW: GET /dashboard/trends
  MW->>MW: check JWT cookie
  alt no session
    MW-->>B: redirect /login with callbackUrl
  else session
    MW->>L: continue
    L-->>B: stream loading.tsx skeleton
    L->>H: requireUser and resolveActiveCompany
    H->>DB: memberships for user
    alt no workspace
      L-->>B: redirect /onboarding
    else workspace
      L->>S: user, companies, activeCompanyId
      S->>N: render
      N->>N: groupForPath gives market, expand its pages
      S-->>B: shell and page content
    end
  end
  B->>N: hover a link
  N->>N: router.prefetch
  B->>N: click
  N->>N: set pending, highlight target before route commits
```

Middleware does the cheap session check, the layout does the workspace check, and the loading boundary is streamed while data loads so navigation feels instant. On the client, hover prefetch and the pending highlight make the sidebar respond before the next server render arrives.

## Design decisions

- **Six groups, pages shown only in context.** The sidebar used to list twenty-one links; it now shows six, expanding only the group you are in. No URL changed, so links and bookmarks keep working.
- **Navigation as data in one file.** Labels, routes, icons, groups and hover descriptions live in `lib/nav.ts`; `tests/nav-clarity.test.ts` enforces that labels describe outcomes, not internal machinery.
- **Longest-match group detection** because `/dashboard` prefixes every route.
- **Pending highlight and intent prefetch** because dashboard routes are `force-dynamic` and otherwise feel unresponsive on click.
- **Shared `loading.tsx` and `error.tsx`** so a slow page shows a skeleton immediately and a failing page keeps the shell, offers retry and shows a digest to quote.
- **Opaque sticky topbar** instead of backdrop blur, to avoid per-frame re-compositing while scrolling.
- **Tokens as HSL variables** so Tailwind opacity modifiers work and one edit re-themes the product; one accent colour, used sparingly.
- **shadcn/ui pattern** (Radix + `cva` + `cn`) for primitives, with feature-specific composition outside `components/ui`.
- **No `SessionProvider`**; the shell receives user details as props from the server.
