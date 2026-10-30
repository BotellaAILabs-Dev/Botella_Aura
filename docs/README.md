# Botella Aura — Documentation

All project documentation for Botella Aura, the AI marketing co-pilot. Start with the five core documents, then go
to the feature documentation for depth.

## Core documents

| # | Document | What it answers | Audience |
| --- | --- | --- | --- |
| 01 | [Product Brief](01-PRODUCT-BRIEF.md) | What Aura is, who it is for, why it is different, scope and roadmap | Everyone |
| 02 | [Software Requirements Specification (SRS)](02-SRS.md) | Every functional and non-functional requirement, its status and how it is verified | Product, engineering, QA |
| 03 | [Application Architecture](03-ARCHITECTURE.md) | How the system is built: master diagram, C4 views, pipeline, security, data, deployment | Engineering |
| 04 | [Changelog](04-CHANGELOG.md) | Every change since 23 July 2026, grouped by release | Engineering |
| 05 | [Release Notes](05-RELEASE-NOTES.md) | What each release delivered, upgrade notes, known issues, tagging | Product, engineering, support |

## Feature documentation — [`feature-docs/`](feature-docs/README.md)

| Section | Contents |
| --- | --- |
| [Overall architecture](feature-docs/01-overall-architecture/OVERALL-ARCHITECTURE.md) | Application workflow, navigation map, background jobs, data model |
| [Features](feature-docs/README.md#features) | 25 feature folders: details · architecture (Mermaid) · changelog |
| [Commit changelog](feature-docs/03-changelog/CHANGELOG.md) | Every commit: Commit ID · Status · Details · Committed by |
| [Internal API](feature-docs/04-api/INTERNAL-API.md) · [External APIs](feature-docs/04-api/EXTERNAL-APIS.md) | Every Aura endpoint; every third-party API |
| [Resources](feature-docs/05-resources/RESOURCES.md) · [Dependencies](feature-docs/05-resources/DEPENDENCIES.md) · [Specifications](feature-docs/05-resources/SPECIFICATIONS.md) | Consoles, docs, packages, limits and specs |
| [Environment variables](feature-docs/06-environment/ENVIRONMENT-VARIABLES.md) | Every variable: purpose, where used, where and how to get it |

## Technical reference documents

Detailed design notes written as each feature was built. Feature folders link to the relevant ones.

| Area | Documents |
| --- | --- |
| Whole product | [PRODUCT-DOCUMENTATION](PRODUCT-DOCUMENTATION.md) · [PROJECT-STATUS](PROJECT-STATUS.md) · [V2-FEATURES-FEASIBILITY](V2-FEATURES-FEASIBILITY.md) |
| Sprints 1–6 | [SPRINT-1](SPRINT-1-TECHNICAL.md) · [SPRINT-2](SPRINT-2-TECHNICAL.md) · [SPRINT-3](SPRINT-3-TECHNICAL.md) · [SPRINT-4](SPRINT-4-TECHNICAL.md) · [SPRINT-5](SPRINT-5-TECHNICAL.md) · [SPRINT-6](SPRINT-6-TECHNICAL.md) |
| Client reviews | [CLIENT-REVIEW-STATUS](CLIENT-REVIEW-STATUS.md) · [SCREENS-REVIEW-STATUS](SCREENS-REVIEW-STATUS.md) · [REMEDIATION-REPORT](REMEDIATION-REPORT.md) · [CONTENT-QUALITY-REVIEW](CONTENT-QUALITY-REVIEW.md) |
| Business Context and opportunities | [BUSINESS-CONTEXT-MODEL](BUSINESS-CONTEXT-MODEL.md) · [BUSINESS-CONTEXT-SOURCES-AUDIT](BUSINESS-CONTEXT-SOURCES-AUDIT.md) · [SIGNAL-AGGREGATION](SIGNAL-AGGREGATION.md) · [OPPORTUNITY-MODEL](OPPORTUNITY-MODEL.md) · [OPPORTUNITY-DETECTION-RULES](OPPORTUNITY-DETECTION-RULES.md) · [AI-OPPORTUNITY-DETECTION](AI-OPPORTUNITY-DETECTION.md) · [OPPORTUNITY-RECOMMENDATION](OPPORTUNITY-RECOMMENDATION.md) |
| Recommendations | [RECOMMENDATION-MODEL](RECOMMENDATION-MODEL.md) · [ENGINE](RECOMMENDATION-ENGINE.md) · [RULES](RECOMMENDATION-RULES.md) · [PRIORITIZATION](RECOMMENDATION-PRIORITIZATION.md) · [LIFECYCLE](RECOMMENDATION-LIFECYCLE.md) · [HISTORY](RECOMMENDATION-HISTORY.md) · [QUALITY](RECOMMENDATION-QUALITY.md) · [CREATION](RECOMMENDATION-CREATION.md) · [CONTEXT-HANDOFF](RECOMMENDATION-CONTEXT-HANDOFF.md) · [AURA-SUGGESTS](AURA-SUGGESTS.md) · [AURA-HOME](AURA-HOME.md) · [WHAT-MATTERS-NOW](WHAT-MATTERS-NOW.md) · [AURA-MODULES](AURA-MODULES.md) · [EMPTY-STATES](EMPTY-STATES.md) |
| Content and media | [CONTENT-BRIEF](CONTENT-BRIEF.md) · [GENERATION-CONTEXT](GENERATION-CONTEXT.md) · [CONTENT-FORMATS](CONTENT-FORMATS.md) · [CONTENT-VARIATIONS](CONTENT-VARIATIONS.md) · [FACT-CHECK](FACT-CHECK.md) · [CONTENT-REVIEW](CONTENT-REVIEW.md) · [CONTENT-COMPLIANCE](CONTENT-COMPLIANCE.md) · [CONTENT-PLAN-PERFORMANCE](CONTENT-PLAN-PERFORMANCE.md) · [VISUAL-BRIEF](VISUAL-BRIEF.md) · [MARKETING-CREATIVES](MARKETING-CREATIVES.md) · [MEDIA-STORAGE](MEDIA-STORAGE.md) · [GRAPHIC-GENERATION-TECHNICAL](GRAPHIC-GENERATION-TECHNICAL.md) · [GRAPHIC-GENERATION-REPORT](GRAPHIC-GENERATION-REPORT.md) |
| Review and approval | [UNIFIED-REVIEW](UNIFIED-REVIEW.md) · [APPROVAL-MODEL](APPROVAL-MODEL.md) · [VERSIONS](VERSIONS.md) · [TRACEABILITY](TRACEABILITY.md) |
| Connections and execution | [CONNECTION-MANAGER](CONNECTION-MANAGER.md) · [EXECUTION-HANDOFF](EXECUTION-HANDOFF.md) · [EXECUTION-ENGINE](EXECUTION-ENGINE.md) · [SCHEDULER](SCHEDULER.md) · [CAMPAIGN-OUTREACH-CREATION](CAMPAIGN-OUTREACH-CREATION.md) · [FAILURE-RECOVERY](FAILURE-RECOVERY.md) · [PERMISSIONS-SECURITY](PERMISSIONS-SECURITY.md) |
| Meta and WhatsApp | [META-INTEGRATION](META-INTEGRATION.md) · [META-APP-SETUP](META-APP-SETUP.md) · [META-APP-REVIEW-CHECKLIST](META-APP-REVIEW-CHECKLIST.md) · [META-APP-REVIEW-SUBMISSION](META-APP-REVIEW-SUBMISSION.md) · [WHATSAPP-ASSISTANT](WHATSAPP-ASSISTANT.md) · [WHATSAPP-DEMO](WHATSAPP-DEMO.md) · [WHATSAPP-PRODUCTION](WHATSAPP-PRODUCTION.md) · [WHATSAPP-SCALABILITY](WHATSAPP-SCALABILITY.md) · [WHATSAPP-TEMPLATES](WHATSAPP-TEMPLATES.md) · [WHATSAPP-TEST-SETUP](WHATSAPP-TEST-SETUP.md) · [SANDBOX](SANDBOX.md) |
| Security, auth and deployment | [DATA-ACCESS-SECURITY](DATA-ACCESS-SECURITY.md) · [AUTH-SETUP](AUTH-SETUP.md) · [DEPLOYMENT-CHECKLIST](DEPLOYMENT-CHECKLIST.md) · [DEPLOYMENT-ENV](DEPLOYMENT-ENV.md) · [VERCEL-DEPLOYMENT](VERCEL-DEPLOYMENT.md) · [PRODUCTION-MIGRATION](PRODUCTION-MIGRATION.md) |
| Test reports | [SPRINT-7-TEST-REPORT](SPRINT-7-TEST-REPORT.md) · [SPRINT-8-TEST-REPORT](SPRINT-8-TEST-REPORT.md) · [SPRINT-9-TEST-REPORT](SPRINT-9-TEST-REPORT.md) |
| Work logs | [2026-09-03](WORK-LOG-2026-09-03.md) · [2026-09-07](WORK-LOG-2026-09-07.md) · [2026-09-29](WORK-LOG-2026-09-29.md) |

Some older technical documents predate later changes; where they differ from the code, the feature documentation
and the code are authoritative (each feature's "Known limitations" section lists the differences found).
