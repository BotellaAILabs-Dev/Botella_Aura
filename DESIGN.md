# Botella Aura — Design System

The visual foundation every future sprint builds on. Aesthetic target: the calm,
confident, high-signal feel of Linear / Vercel / Notion — generous whitespace,
subtle layered shadows, one confident accent, clean sans-serif type. No generic
Bootstrap/default-Tailwind look.

## Where tokens live

All tokens are **HSL CSS variables** defined in
[`app/globals.css`](app/globals.css) (light + `.dark`) and surfaced to Tailwind
in [`tailwind.config.ts`](tailwind.config.ts). Always theme through these
variables — never hard-code hex values in components — so a single edit
re-themes the whole product and dark mode comes for free.

## Color

Neutral **slate** surfaces + one **indigo-violet** accent ("Aura").

| Token                      | Light           | Role                                          |
| -------------------------- | --------------- | --------------------------------------------- |
| `--background`             | `0 0% 100%`     | App background                                |
| `--foreground`             | `222 47% 11%`   | Primary text                                  |
| `--primary`                | `250 84% 60%`   | Accent — CTAs, active nav, focus rings        |
| `--muted` / `-foreground`  | `210 40% 96%` / `215 16% 47%` | Secondary surfaces & text       |
| `--border` / `--input`     | `214 32% 91%`   | Hairlines, field borders                      |
| `--card`                   | `0 0% 100%`     | Card/popover surfaces                         |
| `--destructive`            | `0 72% 51%`     | Errors, destructive actions                   |
| `--success`                | `142 71% 45%`   | Approved / published states                   |
| `--warning`                | `38 92% 50%`    | Pending-approval states                       |

Semantic status colors map to the `ContentStatus` lifecycle used from Sprint 3:
`DRAFT → muted`, `PENDING_APPROVAL → warning`, `APPROVED → primary`,
`REJECTED → destructive`, `PUBLISHED → success` (see
`statusBadgeVariant` in [`components/ui/badge.tsx`](components/ui/badge.tsx)).

Usage guidance: **one accent, used sparingly.** Primary is for the single most
important action on a screen and for active state — not for decoration.

## Typography

**Inter** (via `next/font`), exposed as `--font-sans`. Scale leans on Tailwind
defaults with tight tracking on headings (`tracking-tight`). Page titles are
`text-2xl font-semibold`; section titles `text-lg font-semibold`; body
`text-sm`; helper/muted text `text-xs text-muted-foreground`.

## Spacing, radius & elevation

- **Spacing:** Tailwind's 4px scale. Cards use `p-6`; form fields stack at
  `space-y-1.5`; page sections at `space-y-6`.
- **Radius:** driven by `--radius: 0.75rem` → `rounded-lg` (cards/dialogs),
  `rounded-md` (buttons/inputs), `rounded-full` (avatars/badges).
- **Elevation:** four custom shadows (`shadow-xs → shadow-lg`) tuned soft and
  cool. Cards rest at `shadow-sm`; dialogs/menus at `shadow-md`/`shadow-lg`.
  Elevation communicates layering, never decoration.

## Accessibility baseline

- Semantic HTML (`<nav>`, `<main>`, `<header>`, `<ol>` for the stepper).
- Every input has an associated `<Label htmlFor>`; errors use `aria-invalid`
  and are announced via `role="alert"`.
- Visible focus rings everywhere via a global `:focus-visible` ring — never
  removed without a replacement.
- Dialogs (Radix) are keyboard-navigable and focus-trapped by default.
- Color is never the sole signal — status badges pair color with text.

## Component library

Primitives in [`components/ui/`](components/ui/) follow the shadcn/ui pattern
(Radix + `class-variance-authority` + the `cn()` merge helper). Built in
Sprint 1 and reused everywhere after:

`Button` · `Card` · `Input` · `Textarea` · `Label` · `Badge` (+ status mapping)
· `Dialog` · `DropdownMenu` · `Avatar` · `EmptyState` · `Toaster` (sonner) ·
`Logo`.

**Convention:** build new shared primitives here with a `variant`/`size` API via
`cva`, forward refs, and accept `className`. Feature-specific composition lives
under `components/<feature>/`.
