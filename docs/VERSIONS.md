# Edit & version management

Every state of a piece of generated work is kept as a numbered version. This
covers Content Studio drafts and outreach messages.

| Part                     | Where                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------- |
| The version model (pure) | `lib/versions.ts`                                                                       |
| On stored items          | `server/versions/version.service.ts` (in `aiMetadata.versions`)                         |
| List and restore         | `server/versions/version-api.service.ts`, `GET` / `POST /api/review/:kind/:id/versions` |
| Shown                    | the review screen's **Versions** panel                                                  |

## The model

A version records:

| Field     | Meaning                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `n`       | Version number. 1 is the original.                                                                                                  |
| `source`  | How it came about: `generated` (Aura), `edited` (a person), `regenerated`, `variation` (another version chosen), `undo`, `restored` |
| `by`      | The editor's user id. Null means Aura made it.                                                                                      |
| `at`      | When                                                                                                                                |
| `body`    | The full content: the draft's JSON, or the message text                                                                             |
| `basedOn` | For an undo or a restore: the version it came back to                                                                               |

The log also records:

- **`current`**: the version in use.
- **`approved`**: the version last approved, with who approved it and when.

## Rules

- **Version 1 is the original AI version**, and it stays recoverable.
- **Every change adds a version and makes it current.** A person's edit, a
  regeneration (including "fix what the review found"), switching to another
  variation, and an undo each get the next number, with the editor and the
  time. Saving content identical to the current version adds nothing.
- **Nothing is overwritten.** Making an older version current ("Make this
  current") adds a new version marked _restored from vN_. Every version in
  between stays.
- **The approved version is marked** when the item is approved, and stays
  identifiable after later edits.
- **Restoring a version on approved work does not silently overwrite it.**
  The item goes back for approval (see [APPROVAL-MODEL.md](APPROVAL-MODEL.md)),
  and the approved version stays marked.
- **50 versions are kept.** Beyond that, the oldest go first, but never the
  original, the approved version or the current one.
- **Items created before versions existed** get their history rebuilt from
  their undo list, oldest first, so earlier text is recoverable. If one was
  already approved, its content as it stands is marked as the approved
  version.

## Where versions are added

| Change                                   | Version source                               |
| ---------------------------------------- | -------------------------------------------- |
| Draft generated                          | `generated` (v1)                             |
| Edit (review screen, draft page, API)    | `edited`                                     |
| Regenerate / rewrite / fix review issues | `regenerated`                                |
| Switch variation                         | `variation`                                  |
| Undo                                     | `undo`, linked to the version it returned to |
| Make an older version current            | `restored`, linked to that version           |
| Outreach drafted / regenerated / edited  | `generated` / `regenerated` / `edited`       |

## The Versions panel

The panel is on the review screen and is rendered with the page. It shows:

- every version, newest first: number, how it came about, who, and when;
- **Original**, **Current** and **Approved** badges;
- the full text of any version, on request;
- **Make this current**. If the item is approved, it asks first, because
  this reopens the approval.

Only people who can edit can restore: members and above for content, owners
and admins for outreach.

## Checking it

```bash
pnpm test tests/versions.test.ts
VERIFY_BASE_URL=http://localhost:3001 pnpm verify:versions
```
