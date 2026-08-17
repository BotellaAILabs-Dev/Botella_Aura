# Botella Aura — Client Review: Status, Remaining Work & Blockers

> Tracks every item from the product-feedback review: what's **done**, what's
> **remaining** (and why it isn't done yet), what's **blocked** (and by what), and
> the **action** + **owner** for each. Grounded in what's actually shipped and
> deployed.
>
> **Owner** = who has to act: **Us** (engineering) · **You** (client — accounts,
> approvals, keys, decisions) · **Both**.
> **Status:** ✅ done · 🟡 partial · ⬜ not started · 🔴 blocked.
> **Effort:** S ≤1 day · M 2–4 days · L 1–2 weeks.

**Guiding principle (yours):** fix broken flows → make the workflow visible → polish.

---

## 📌 Latest update (this batch)

Shipped and deployed since the last review — moving many items from ⬜/🟡 to ✅:

- **Dashboard — actionable items first** ✅ (live "Action needed" panel).
- **Demo data** ✅ (connected, labeled sample story; `pnpm db:seed:demo`).
- **Outreach status progression** ✅ (visible Draft→Pending→Approved→Queued→Sent stepper).
- **Outreach sequence labels** ✅ (connection note first, numbered follow-ups, order shown).
- **Marketing Memory correction** ✅ (edit wording or dismiss any insight).
- **Content CTA/hashtags** ✅ (hashtags shown as a separate labeled block; publishing note present).
- **Trend enhancements** ✅ AI summary + weekly recommendations, trending hashtags, seasonal/event moments, competitor mentions. (Forecasting still data-gated; save/monitor optional.)
- **P2/P3 polish** ✅ LinkedIn URL validation (person vs company), discovery "what to expect" + next auto-run date, "Signals · Msgs" clarified, Crunchbase key guidance, engagement-target examples, role tooltips, trend refresh/zero-result copy.

**Still open:** trend forecasting (needs accumulated history), save & monitor trends (optional, no-migration path available), real connector OAuth, and the three external blockers below (Chrome Web Store, LinkedIn API approval, live analytics/Crunchbase key).

---

## 1. ✅ Already shipped (live on the deploy)

| Area | Item | Notes |
|------|------|-------|
| Dashboard | Rename Overview → **Dashboard** | ✅ |
| Dashboard | **Create Workspace** now works | Was routing existing users back to the app; fixed with a real "new workspace" flow. |
| Team | **Invite teammates + roles** (Owner/Admin/Member/**Viewer**) | Email invite, accept flow, role change, remove, last-owner guard. |
| Team | **Invitation status + Resend** | Pending/Expired badges + Resend with confirmation. |
| Connectors | **Connectors module** + 24 integrations listed | Available (LinkedIn) vs Coming-soon shown clearly. |
| Trends | Rename → **AI Trend Insights** | ✅ |
| Trends | **Geo filters** (country/region/city/language/time range) | Live-verified US vs GB return different results. |
| Content | **Campaign selector** fixed | No dead "— none —"; empty-state + disable when none. |
| Content | Speed + accuracy | Lower effort for short posts; live-fetch a URL in the brief; retrieve more grounding. |
| Leads | **Fit score X/100 + "why"** | Grounded in the lead's real rationale. |
| Leads | **Company vs Contact** separated | Company-only leads clearly marked. |
| Onboarding | Website validation, industry autocomplete, **tone chips**, **live brand-voice preview** | ✅ |
| Extension | **Internal/Beta** label | Honest framing until store submission. |
| Email | **SMTP + Resend** transports | Auto-activates when a key is set. |
| KB | PDF upload hardened | Clear errors, size guard, Node runtime. |
| Copy | Removed internal "Sprint" terms | ✅ |

---

## 2. ⬜ Remaining — doable now, no external blocker (Owner: Us)

These need **engineering time only** — no keys, no approvals.

| # | Item (from review) | Status | Effort | Why not done yet / what to do |
|---|--------------------|--------|--------|-------------------------------|
| R1 | **Demo/sample data** (Trend→Content→Campaign→Leads→Outreach→Analytics, labeled) | ⬜ | M | Needs a decision on scope (below) then a seed script that creates connected, clearly-labeled "Sample" records without touching real workspaces. **Highest first-impression value.** |
| R2 | **Dashboard: actionable items first** (leads found, drafts awaiting approval, pending outreach) | ⬜ | M | Overview page currently shows generic cards. Build a real "what needs you now" panel from our own data. |
| R3 | **Outreach status progression** (Draft→Pending→Approved→Queued→Sent) | 🟡 | M | We have Draft/Pending/Approved/Sent; add a visible "Queued" (extension queue) state + a progress stepper on each message. |
| R4 | **Outreach sequence** — label connection notes vs follow-ups + order | ⬜ | S–M | Message `type` exists; surface "Connection note" vs "Follow-up #n" + ordering in the UI. |
| R5 | **Content output** — separate CTA / hashtags; clarify publishing limits | 🟡 | S | Schemas already separate `hashtags`; display them distinctly and add a one-line "what auto-publishes vs copy-paste" note. |
| R6 | **Marketing Memory** — correct/edit individual learned insights | ⬜ | M | Add edit/dismiss on `MarketingMemory` rows + a small UI. Trust feature. |
| R7 | **"Show what Aura learned"** after brand-voice analysis | ⬜ | S | Surface the stored Brand Voice Profile in a readable card post-onboarding. |
| R8 | **Trend refresh frequency** + zero-result explanation | ⬜ | S | Copy: explain daily refresh + "no results" behavior on the Trends page. |
| R9 | **Lead Discovery** — expected results/time/usage before "Run now" | ⬜ | S | Copy + a pre-run note. |
| R10 | **Auto-run weekly** — show next scheduled date | ⬜ | S | Compute + display next run. |
| R11 | **"Signals: 0 · 0 msg"** — clarify empty vs broken | ⬜ | S | Copy/empty-state fix. |
| R12 | **LinkedIn URL validation** + person vs company page distinction | ⬜ | S–M | Validate format; detect `/in/` (person) vs `/company/` (page). |
| R13 | **Engagement target examples** | ⬜ | S | Add example placeholders/help. |
| R14 | **Role tooltips** (Owner/Admin/Member/Viewer) | ⬜ | S | Hover explanations in the team UI. |
| R15 | **Connectors: Available vs Coming Soon** alignment | ✅/🟡 | S | Already shown; keep sales messaging aligned. Add the "future: status/reconnect/sync history" as labeled roadmap. |
| R16 | **Campaign Orchestrator** — populate + test one full campaign E2E | 🟡 | M | Engine exists; needs demo data (R1) + a QA pass to prove goal→calendar→content→leads→outreach→analytics. |

### Trend "Additional Enhancements" (Owner: Us; a few are large)
| # | Item | Status | Effort | Notes |
|---|------|--------|--------|-------|
| T1 | Industry-specific trending topics | 🟡 | S | Bias queries by industry (we have it) — small tuning. |
| T2 | Trending **hashtags** | ⬜ | M | Derive from trend items + Claude; no API. |
| T3 | **Seasonal / event-based** trends | ⬜ | M | Needs the curated **awareness-days dataset** (we build it, no API). |
| T4 | AI trend **summary + recommendations** | 🟡 | S | Digest already has per-item "why + angle"; add a top-level summary. |
| T5 | **Competitor trend comparison** | ⬜ | M | Uses our competitor tracking + Claude. |
| T6 | **Save & monitor** trends for later | ⬜ | M | New "saved trends" model + UI. |
| T7 | **Trend forecasting** (emerging trends) | 🔴* | L | *Not blocked by an API, but blocked by **time-series data we don't have yet** — forecasting needs weeks of accumulated trend history. Build the collector now; forecasting becomes meaningful once data accrues. |

---

## 3. 🔴 Blocked — needs external accounts / approvals / keys (Owner: You or Both)

None of these are code problems. They need procurement or a third party.

| # | Item | Blocker | Owner | What to do |
|---|------|---------|-------|------------|
| B1 | **Chrome extension on the Web Store** | Needs **your Google developer account** (+ one-time $5 fee) and Google's review (days). We can't submit it. | **You** | Create/confirm the Chrome Web Store developer account; we prepare the listing + package and hand it over, or you submit. Until then it stays labeled Internal/Beta. |
| B2 | **Real post performance** (Analytics "Performance" tiles, Coach data-mode) | Needs published-post metrics: **GA4 / LinkedIn / Meta APIs**, or the extension, or manual entry. | **Both** | Fix the extension (free metrics) and/or connect GA4 (easy). LinkedIn/Meta need apps + review. Manual entry works today. |
| B3 | **LinkedIn publishing + company-page reads** | **LinkedIn Marketing / Community Management API approval** (weeks). | **You** | Start the LinkedIn app review **now** (long lead time). Until approved → "copy for manual posting" (already honest). |
| B4 | **Real connector OAuth** (the 24 integrations) | Each integration = its own app registration + secrets (+ some need review). | **Both** | Pick **1–2 to build first** (GA4 + Meta Ad Library are easiest/free). We build them; you approve app registrations. |
| B5 | **Crunchbase lead enrichment** | Needs a **Crunchbase API key** (paid). | **You** | Decide: buy a key, or we keep enrichment on the keyless/manual path and just add "key required" guidance (R-item). |
| B6 | **Emails actually sending in production** | `RESEND_API_KEY`+`EMAIL_FROM` **or** `SMTP_*` not set in Vercel. | **You** | Set the email env vars in Vercel (5 min). Code is done; invites/resets log to console until then. |
| B7 | **Semantic search / richer AI quality** | Optional embeddings service (pgvector + a small Python service). | **Us** | Not urgent; keyword retrieval works. Future upgrade. |

---

## 4. ❓ Decisions we need from you (unblocks the most)

1. **Demo data (R1):** build it? Should it auto-load **only** for a dedicated demo workspace (keeping real/new workspaces genuinely empty)? — *This is the single biggest "first impression" win.*
2. **Chrome extension (B1):** do you submit to the Web Store, or hand us the developer account?
3. **First connectors (B4):** which 1–2 matter most for the demo? (Recommend **GA4** + **Meta Ad Library** — free, easy.)
4. **Crunchbase (B5):** buy a key, or keep keyless + guidance?
5. **LinkedIn approval (B3):** can you start the Marketing API review now? (Long lead time — earlier is better.)

---

## 5. Recommended next order (fits "visible workflow → polish")

**Next batch (Us, no blockers) — highest visible value:**
1. **R1 Demo data** (pending your decision) — makes everything non-empty.
2. **R2 Dashboard actionable items** — "what needs you now."
3. **R3/R4 Outreach status progression + sequence labels** — makes the outreach flow legible.
4. **R7 "What Aura learned" + R5 CTA/hashtag separation** — quick, visible.

**Then polish batch (Us):** R8–R14 (mostly copy/validation/tooltips — fast, high-trust).

**Trend enhancements (Us):** T3 seasonal (awareness dataset) + T4 summary + T2 hashtags + T6 save/monitor. Forecasting (T7) after data accrues.

**In parallel (You):** B6 email env vars (5 min), B3 LinkedIn approval (start now), B1 Chrome dev account, B5 Crunchbase decision.

---

_Everything in §2 we can build with no external dependency. Everything in §3 needs
your accounts/approvals/keys. Tell us the §4 decisions and we'll take the next
batch straight through._
