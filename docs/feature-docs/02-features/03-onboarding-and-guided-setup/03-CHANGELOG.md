# Onboarding & Guided Setup — Changelog / Work log

Every commit that changed this feature's code, oldest first. _Generated from the git history and source code on 30 Oct 2026._

## At a glance

| Measure | Value |
| --- | --- |
| First developed | 23 Jul 2026 (`5666a10` — feat(onboarding): 3-step company onboarding wizard) |
| Last changed | 26 Oct 2026 (`30757de`) |
| Commits | 10 |
| Days with changes | 10 |
| Lines in this feature's files | +1,588 / −159 |
| By status | Fresh addition 8, Change 1, Fix 1 |
| Committed by | dspraneeth07 (6), srbaggari (4) |

## Development timeline

| Sprint / phase | Commits | Dates |
| --- | --- | --- |
| Sprint 1 – Foundation | 1 | 23 Jul |
| Client feedback & UX review | 4 | 31 Jul – 27 Aug |
| AI graphics, autonomy & guided setup | 1 | 03 Sep |
| Client requests, image providers & performance | 1 | 17 Sep |
| Sprint 7 – Business Context & Opportunities | 1 | 01 Oct |
| Sprint 10 – Connections & Execution | 1 | 17 Oct |
| Post-review hardening | 1 | 26 Oct |

## Commits

| # | Commit ID | Status | Details | Committed by | Date | Files changed here |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `5666a10` | Fresh addition | **feat(onboarding): 3-step company onboarding wizard**<br/>Company details -&gt; brand voice -&gt; confirmation, persisting to Company (with an extensible preferences JSON field). Creation runs in a transaction that adds the user as OWNER and writes COMPANY_CREATED + ONBOARDING_COMPLETED audit entries. Confirmation step sets the human-in-the-loop expectation up front. | dspraneeth07 | 23-Jul-2026 | 2 |
| 2 | `d996c48` | Change | **polish(ui): remove internal "Sprint N" labels + working overview + more trends**<br/>strip all customer-facing "Sprint N" wording from the UI (overview, sidebar chips, onboarding, coming-soon, settings, leads, LinkedIn card, reset page).; rewrite the dashboard overview: the empty-state cards were disabled teasers (the "Connect" button did nothing) — now every card is a real link to its live feature (Co… | dspraneeth07 | 31-Jul-2026 | 1 |
| 3 | `0176507` | Fresh addition | **feat(dashboard): rename Overview→Dashboard; fix Create Workspace**<br/>'Create Workspace' now works for existing users: it routes to /onboarding?new=1 (the page previously bounced anyone with a company back to /dashboard, so the button appeared dead). The new workspace is set active on creation. | dspraneeth07 | 07-Aug-2026 | 2 |
| 4 | `2daaf1e` | Fresh addition | **feat(onboarding): validation, industry autocomplete, tone chips, live voice preview**<br/>Step 1: inline website-format validation on blur (catches typos immediately) and industry autocomplete (datalist of common industries) with a helper hint. | dspraneeth07 | 11-Aug-2026 | 2 |
| 5 | `ac4d45e` | Fix | **fix: screens review — P0 generation failures, OAuth, first-run, lead scoring**<br/>Three separate "AI is broken" reports shared one root cause. Extended thinking draws from the same output-token budget as the reply, so a small max_tokens could be spent entirely on thinking and return a well-formed response containing a thinking block and no text. | dspraneeth07 | 27-Aug-2026 | 2 |
| 6 | `94e3926` | Fresh addition | **feat(onboarding): guide setup as a sequence, derived from real data**<br/>Setup was a three-step wizard followed by a loose list of four suggestions. The wizard ended with "You're all set", which was not true — Aura knew the company name and nothing else — and the four suggestions had no order, no sense of whether you had done them, and no statement of what any of them would buy you. | srbaggari | 03-Sep-2026 | 4 |
| 7 | `b090ef2` | Fresh addition | **feat(onboarding): capture the business and its audience**<br/>The content engine already handles consumer and business audiences properly (audienceToPrompt, contentRulesFor). Onboarding collected neither, so every new workspace fell through to the fallback path -- "has not described its buyers yet" -- and got a generic business reader with B2B writing rules. | srbaggari | 17-Sep-2026 | 3 |
| 8 | `4015d13` | Fresh addition | **feat(business): turn About My Business into the view of the Business Context**<br/>A new About my business page (/dashboard/business) is the user-facing representation of the trusted Business Context: what Aura knows about the business, where each detail came from, how current it is, and what is missing — editable in place. | srbaggari | 01-Oct-2026 | 1 |
| 9 | `73b0ad3` | Fresh addition | **feat(connections): Connection Manager, connection flow, capabilities, token lifecycle, health**<br/>Connection Manager data model: provider, channels, provider account id, granted scopes, credential reference, setup stage, health, execution history, capabilities; ConnectedAccount table for provider -&gt; account -&gt; page relationships; LinkedIn mirrored without its token; REVOKED status. | srbaggari | 17-Oct-2026 | 1 |
| 10 | `30757de` | Fresh addition | **feat(nav, trends, onboarding): six-group navigation, localized trend sources**<br/>Addresses the product review's navigation, trends and onboarding findings. | dspraneeth07 | 26-Oct-2026 | 2 |

Status legend and the full project changelog: [../../03-changelog/CHANGELOG.md](../../03-changelog/CHANGELOG.md).
