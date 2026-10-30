# Botella Aura — Feature Documentation

The complete documentation set for Botella Aura, an AI marketing co-pilot. It covers the overall
architecture and application workflow, every feature with its details, a Mermaid architecture diagram and its
change history, the full changelog from the first commit, the internal and external API references, resources
and specifications, and every environment variable.

Development started on **23 July 2026**. As of 30 October 2026 the repository holds 204 commits across all
branches, 25 features, 181 API route files (250 operations), 61 data models and 49 migrations.

## Folder structure

```text
docs/feature-docs/
├── README.md                              ← you are here
├── 01-overall-architecture/
│   └── OVERALL-ARCHITECTURE.md            system context, layers, application workflow, navigation,
│                                          background jobs, deployment, data model, principles
├── 02-features/
│   └── NN-<feature>/                      one folder per feature (25), each with:
│       ├── 01-FEATURE-DETAILS.md          what it does, how it works, code map, data, APIs, security, tests
│       ├── 02-ARCHITECTURE.md             Mermaid diagrams: components, main flow, lifecycle, data model
│       └── 03-CHANGELOG.md                when it was developed: every commit that touched it
├── 03-changelog/
│   └── CHANGELOG.md                       every commit since day one: Commit ID · Status · Details · Committed by
├── 04-api/
│   ├── INTERNAL-API.md                    every Aura endpoint, grouped by feature, with auth and permissions
│   └── EXTERNAL-APIS.md                   every third-party API Aura calls, endpoints, auth, env vars
├── 05-resources/
│   ├── RESOURCES.md                       consoles, official docs, in-repo resources, handy commands
│   ├── DEPENDENCIES.md                    every npm package with version, purpose and usage; npm scripts
│   └── SPECIFICATIONS.md                  runtime, limits, media and content specs, AI budgets, security, quality gates
└── 06-environment/
    └── ENVIRONMENT-VARIABLES.md           every env var: purpose, required?, where used, where and how to get it
```

## Start here

| If you want to… | Read |
| --- | --- |
| Understand how the whole product works | [01-overall-architecture/OVERALL-ARCHITECTURE.md](01-overall-architecture/OVERALL-ARCHITECTURE.md) |
| Understand one feature | its folder in [02-features/](#features) |
| See what changed and when | [03-changelog/CHANGELOG.md](03-changelog/CHANGELOG.md) |
| Call or change an endpoint | [04-api/INTERNAL-API.md](04-api/INTERNAL-API.md) |
| Set up a provider account | [04-api/EXTERNAL-APIS.md](04-api/EXTERNAL-APIS.md) and [06-environment/ENVIRONMENT-VARIABLES.md](06-environment/ENVIRONMENT-VARIABLES.md) |
| Run it locally or deploy | [06-environment/ENVIRONMENT-VARIABLES.md](06-environment/ENVIRONMENT-VARIABLES.md), [05-resources/RESOURCES.md](05-resources/RESOURCES.md) |
| Check a limit or spec | [05-resources/SPECIFICATIONS.md](05-resources/SPECIFICATIONS.md) |

## Features

| # | Feature | Details | Architecture | Changelog |
| --- | --- | --- | --- | --- |
| 01 | Authentication & Accounts | [Details](02-features/01-authentication-and-accounts/01-FEATURE-DETAILS.md) | [Diagrams](02-features/01-authentication-and-accounts/02-ARCHITECTURE.md) | [Changelog](02-features/01-authentication-and-accounts/03-CHANGELOG.md) |
| 02 | Workspaces, Team & Roles (RBAC) | [Details](02-features/02-workspaces-team-and-roles/01-FEATURE-DETAILS.md) | [Diagrams](02-features/02-workspaces-team-and-roles/02-ARCHITECTURE.md) | [Changelog](02-features/02-workspaces-team-and-roles/03-CHANGELOG.md) |
| 03 | Onboarding & Guided Setup | [Details](02-features/03-onboarding-and-guided-setup/01-FEATURE-DETAILS.md) | [Diagrams](02-features/03-onboarding-and-guided-setup/02-ARCHITECTURE.md) | [Changelog](02-features/03-onboarding-and-guided-setup/03-CHANGELOG.md) |
| 04 | Knowledge Base & Brand Voice | [Details](02-features/04-knowledge-base-and-brand-voice/01-FEATURE-DETAILS.md) | [Diagrams](02-features/04-knowledge-base-and-brand-voice/02-ARCHITECTURE.md) | [Changelog](02-features/04-knowledge-base-and-brand-voice/03-CHANGELOG.md) |
| 05 | Business Context & About My Business | [Details](02-features/05-business-context/01-FEATURE-DETAILS.md) | [Diagrams](02-features/05-business-context/02-ARCHITECTURE.md) | [Changelog](02-features/05-business-context/03-CHANGELOG.md) |
| 06 | Trend Insights | [Details](02-features/06-trend-insights/01-FEATURE-DETAILS.md) | [Diagrams](02-features/06-trend-insights/02-ARCHITECTURE.md) | [Changelog](02-features/06-trend-insights/03-CHANGELOG.md) |
| 07 | Competitor Intelligence | [Details](02-features/07-competitor-intelligence/01-FEATURE-DETAILS.md) | [Diagrams](02-features/07-competitor-intelligence/02-ARCHITECTURE.md) | [Changelog](02-features/07-competitor-intelligence/03-CHANGELOG.md) |
| 08 | Signals & Opportunity Detection | [Details](02-features/08-signals-and-opportunities/01-FEATURE-DETAILS.md) | [Diagrams](02-features/08-signals-and-opportunities/02-ARCHITECTURE.md) | [Changelog](02-features/08-signals-and-opportunities/03-CHANGELOG.md) |
| 09 | Recommendations & Aura Suggests | [Details](02-features/09-recommendations-and-aura-suggests/01-FEATURE-DETAILS.md) | [Diagrams](02-features/09-recommendations-and-aura-suggests/02-ARCHITECTURE.md) | [Changelog](02-features/09-recommendations-and-aura-suggests/03-CHANGELOG.md) |
| 10 | Aura Home, What Matters Now & Weekly Briefing | [Details](02-features/10-aura-home-and-briefing/01-FEATURE-DETAILS.md) | [Diagrams](02-features/10-aura-home-and-briefing/02-ARCHITECTURE.md) | [Changelog](02-features/10-aura-home-and-briefing/03-CHANGELOG.md) |
| 11 | Content Studio | [Details](02-features/11-content-studio/01-FEATURE-DETAILS.md) | [Diagrams](02-features/11-content-studio/02-ARCHITECTURE.md) | [Changelog](02-features/11-content-studio/03-CHANGELOG.md) |
| 12 | Media, Graphics & Marketing Creatives | [Details](02-features/12-media-graphics-and-creatives/01-FEATURE-DETAILS.md) | [Diagrams](02-features/12-media-graphics-and-creatives/02-ARCHITECTURE.md) | [Changelog](02-features/12-media-graphics-and-creatives/03-CHANGELOG.md) |
| 13 | Review, Approval, Versions & Traceability | [Details](02-features/13-review-approval-versions-and-trace/01-FEATURE-DETAILS.md) | [Diagrams](02-features/13-review-approval-versions-and-trace/02-ARCHITECTURE.md) | [Changelog](02-features/13-review-approval-versions-and-trace/03-CHANGELOG.md) |
| 14 | Campaigns & Content Planner | [Details](02-features/14-campaigns-and-content-planner/01-FEATURE-DETAILS.md) | [Diagrams](02-features/14-campaigns-and-content-planner/02-ARCHITECTURE.md) | [Changelog](02-features/14-campaigns-and-content-planner/03-CHANGELOG.md) |
| 15 | Lead Discovery & Outreach Intelligence | [Details](02-features/15-leads-and-outreach/01-FEATURE-DETAILS.md) | [Diagrams](02-features/15-leads-and-outreach/02-ARCHITECTURE.md) | [Changelog](02-features/15-leads-and-outreach/03-CHANGELOG.md) |
| 16 | Engagement Copilot | [Details](02-features/16-engagement-copilot/01-FEATURE-DETAILS.md) | [Diagrams](02-features/16-engagement-copilot/02-ARCHITECTURE.md) | [Changelog](02-features/16-engagement-copilot/03-CHANGELOG.md) |
| 17 | Chrome Extension | [Details](02-features/17-chrome-extension/01-FEATURE-DETAILS.md) | [Diagrams](02-features/17-chrome-extension/02-ARCHITECTURE.md) | [Changelog](02-features/17-chrome-extension/03-CHANGELOG.md) |
| 18 | Marketing Memory & Analytics | [Details](02-features/18-marketing-memory-and-analytics/01-FEATURE-DETAILS.md) | [Diagrams](02-features/18-marketing-memory-and-analytics/02-ARCHITECTURE.md) | [Changelog](02-features/18-marketing-memory-and-analytics/03-CHANGELOG.md) |
| 19 | Connections, Connectors & OAuth | [Details](02-features/19-connections-and-connectors/01-FEATURE-DETAILS.md) | [Diagrams](02-features/19-connections-and-connectors/02-ARCHITECTURE.md) | [Changelog](02-features/19-connections-and-connectors/03-CHANGELOG.md) |
| 20 | Publishing, Execution Engine & Scheduling | [Details](02-features/20-publishing-execution-and-scheduling/01-FEATURE-DETAILS.md) | [Diagrams](02-features/20-publishing-execution-and-scheduling/02-ARCHITECTURE.md) | [Changelog](02-features/20-publishing-execution-and-scheduling/03-CHANGELOG.md) |
| 21 | WhatsApp AI Assistant | [Details](02-features/21-whatsapp-assistant/01-FEATURE-DETAILS.md) | [Diagrams](02-features/21-whatsapp-assistant/02-ARCHITECTURE.md) | [Changelog](02-features/21-whatsapp-assistant/03-CHANGELOG.md) |
| 22 | Billing, Plans & Entitlements | [Details](02-features/22-billing-and-plans/01-FEATURE-DETAILS.md) | [Diagrams](02-features/22-billing-and-plans/02-ARCHITECTURE.md) | [Changelog](02-features/22-billing-and-plans/03-CHANGELOG.md) |
| 23 | AI Layer (Claude / Gemini Client) | [Details](02-features/23-ai-layer/01-FEATURE-DETAILS.md) | [Diagrams](02-features/23-ai-layer/02-ARCHITECTURE.md) | [Changelog](02-features/23-ai-layer/03-CHANGELOG.md) |
| 24 | Platform: Jobs, Cron, Security & Deployment | [Details](02-features/24-platform-jobs-and-deployment/01-FEATURE-DETAILS.md) | [Diagrams](02-features/24-platform-jobs-and-deployment/02-ARCHITECTURE.md) | [Changelog](02-features/24-platform-jobs-and-deployment/03-CHANGELOG.md) |
| 25 | Navigation, Dashboard Shell & Design System | [Details](02-features/25-navigation-and-design-system/01-FEATURE-DETAILS.md) | [Diagrams](02-features/25-navigation-and-design-system/02-ARCHITECTURE.md) | [Changelog](02-features/25-navigation-and-design-system/03-CHANGELOG.md) |

## How these documents were produced and kept true

- **Generated from the source of truth:** the changelogs (global and per feature), the internal API reference,
  the environment-variable usage tables and the dependency list are generated from `git log` and the code. A commit
  counts toward a feature when it changed one of that feature's files, so one commit can appear under several
  features.
- **Written from the code:** feature details, architecture diagrams, external APIs, specifications and resources
  were written by reading the code and the existing per-feature documents in [`docs/`](../).
- **Diagrams:** every Mermaid block was rendered with Mermaid 11 in headless Chrome before publishing, so each one
  renders on GitHub, GitLab and VS Code's Markdown preview.
- **Changelog status values:** Fresh addition · Change · Fix · Update · Revoke — defined in
  [03-changelog/CHANGELOG.md](03-changelog/CHANGELOG.md#status-legend).

The original per-feature technical documents (81 files) remain in [`docs/`](../) and are linked from each feature's
"Related documents" section.
