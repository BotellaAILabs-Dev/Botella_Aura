# Unified review experience

All generated Aura work is reviewed in one screen with one set of actions,
whichever module made it.

| Part                              | Where                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------- |
| The shape every item takes (pure) | `lib/review-item.ts`                                                            |
| Each module's item, and the queue | `server/review/review-item.service.ts`                                          |
| The actions                       | `server/review/review-actions.service.ts`                                       |
| API                               | `GET` / `POST /api/review/:kind/:id` (kind: `content` or `outreach`)            |
| Screen                            | `/dashboard/review/:kind/:id` — `components/dashboard/review/review-screen.tsx` |
| Queue                             | `/dashboard/review` — **Review & approve** in the sidebar                       |

## What it covers

Two modules have an approval step: **Content Studio drafts** and
**outreach messages**. Campaigns, the content plan, Autopilot and Aura's
suggestions all produce Content Studio drafts, so their work comes into the
same review too.

Entry points:

- **Sidebar:** **Review & approve**, the queue of everything waiting.
- **Content Studio draft page:** a **Review & approve** link in the header.
- **Outreach board:** a **Review** button on each message.

## The screen

The screen has three areas.

**Main column**

- **The content**, field by field and labelled for the format: hook,
  paragraphs, caption, slides, subject line, call to action, hashtags, and so
  on.
- **The image or asset**:
  - the attached images;
  - whether the format needs one (required, recommended, or not used);
  - a link to add or change it.
- **Quality warnings**, most serious first:
  - **Must fix**: blocks approval;
  - **Check**: a person must look;
  - **Note**: worth knowing.

  They come from the AI reviewer, the compliance rules, the fact check,
  Aura's format rules, the image requirement, and a previous rejection.

- **Reviewer feedback**: the reviewer's verdict, score, summary, and issues
  with suggestions. The score is hidden when the AI reviewer did not run,
  because it would then reflect the rules alone.

**Side panel: "What it's for"**

- the recommendation and why it was made;
- goal, audience, channel and key message;
- what it was written from;
- the expected outcome, campaign, or lead details;
- the **evidence** behind it.

**Action bar** (fixed at the bottom)

**Back · Edit · Save · Regenerate · Submit for approval · Reject · Schedule ·
Approve.** Every item has the same actions. When one cannot be used, the
screen says why, for example "Only owners and admins can approve" or
"Outreach is sent from the browser extension, not scheduled".

A content piece whose review is missing or out of date is reviewed as soon as
the screen opens, so its warnings are there before anyone decides.

## Actions

| Action      | Content Studio                                                                                                                                                                                                                       | Outreach                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Edit / Save | Field by field; the body is validated for its format and re-checked. Editing an approved piece sends it back for approval.                                                                                                           | The message text; it returns to draft.                                                                                                                                         |
| Regenerate  | A fresh take, "fix what the review found", or your own instructions. The previous version stays in the draft's history (Undo on the full page). It is reviewed again.                                                                | A fresh draft of the same message, for the same lead and signal, replaced in place. The old text is kept in its history.                                                       |
| Submit      | For people who can create but not approve.                                                                                                                                                                                           | Owners and admins.                                                                                                                                                             |
| Approve     | Owners and admins. An approver can approve a draft directly: it is submitted and approved in one step. All the existing gates apply (AI review, compliance, fact check), plus the approver's confirmation when something is flagged. | Owners and admins. LinkedIn's 300-character note limit, placeholders and the workspace's compliance rules are enforced. The same check now also applies on the Outreach board. |
| Reject      | With an optional reason, shown on the item afterwards.                                                                                                                                                                               | Same.                                                                                                                                                                          |
| Schedule    | Approved posts only; not email or ad copy.                                                                                                                                                                                           | Not applicable: approved outreach is sent from the extension.                                                                                                                  |

## Edits are preserved

- **Unsaved edits are kept in the browser** for that item and version. A
  reload or navigating away and back restores them, with a notice, and leaving
  the page with unsaved edits asks first.
- **Approve and Regenerate wait until the edits are saved or discarded.**
- **Older edits never overwrite newer work.** A save carries the version it was
  made on. If the item changed in the meantime (a rewrite, or someone else's
  edit), the save is refused (409) and the edits stay on screen.
- **Rewrites can be undone.** Every regeneration keeps the previous version.

## Checking it

```bash
pnpm test tests/review-item.test.ts
VERIFY_BASE_URL=http://localhost:3001 pnpm verify:unified-review
```
