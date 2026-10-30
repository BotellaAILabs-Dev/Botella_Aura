# WhatsApp AI Assistant — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 14 Oct 2026 (`f6b35db` — feat(whatsapp): WhatsApp AI assistant + Facebook/Instagram/LinkedIn one-click publishing) |
| Last changed | 27 Oct 2026 (`0572bf2`) |
| Commits | 6 |
| Days with changes | 4 |
| Lines in this feature's files | +6,806 / −201 |
| By status | Fresh addition 3, Fix 3 |
| Committed by | srbaggari (3), dspraneeth07 (3) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 9 – Recommendation to Content | 2 | 14 Oct |
| Sprint 10 – Connections & Execution | 1 | 22 Oct |
| Post-review hardening | 3 | 26 Oct – 27 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `f6b35db` | Fresh addition | **feat(whatsapp): WhatsApp AI assistant + Facebook/Instagram/LinkedIn one-click publishing**<br/>WhatsApp assistant on Meta's official Cloud API (one central number):; Signed webhook (X-Hub-Signature-256), wamid dedupe, delivery statuses, retries, 24-hour window, STOP/START, rate limiting.; | srbaggari | 14-Oct-2026 | 36 |
| 2 | `aeaf1c8` | Fix | **fix(whatsapp,publishing): post-implementation audit fixes; JPEG for Instagram**<br/>Found in the post-implementation audit and fixed:; A pending approve/publish now lapses on any account command too ("menu", "switch", logout, workspace), so a later "ok" cannot run it.; | srbaggari | 14-Oct-2026 | 7 |
| 3 | `183a772` | Fresh addition | **feat(content, meta, launch): Content Studio control, image refinement and preview, Meta review prep, production readiness**<br/>Content Studio; Recommendations workspace: compare versions, use one (others kept), edit, refine, regenerate or revert ONE version, add 1-3 more recommendations; Per-version CTA, website, address, phone and email (post details), never written by the AI; typed details must be confirmed before approval; | srbaggari | 22-Oct-2026 | 3 |
| 4 | `38083a5` | Fix | **fix(ai): honour the model tier on the Gemini path; local WhatsApp loop**<br/>THE BUG | dspraneeth07 | 26-Oct-2026 | 2 |
| 5 | `6cff62e` | Fix | **fix(whatsapp, content, media): four defects the full verifier sweep found**<br/>Running all 65 verify scripts turned up five failures. One was a dev-server artifact (two `next dev` instances sharing .next corrupt the webpack graph; the same request succeeds on retry) and four were real. | dspraneeth07 | 27-Oct-2026 | 1 |
| 6 | `0572bf2` | Fresh addition | **feat(sandbox): Facebook and Instagram join the local stand-in for Meta**<br/>WhatsApp could already be exercised without a Meta account. Facebook and Instagram could not be exercised at all: between them they need a Meta app, a Page, an Instagram professional account linked to it, and a token that expires in about a day, so the publishers — including Instagram's container-and-poll cycle, the lo… | dspraneeth07 | 27-Oct-2026 | 3 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
