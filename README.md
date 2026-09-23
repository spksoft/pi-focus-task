# pi-focus-task

Keep one project task in focus across Pi sessions and compaction without committing personal notes.

## Install

Requires Node.js 22.19+ and Pi 0.86.1+.

```sh
pi install git:github.com/spksoft/pi-focus-task
```

Restart Pi or run `/reload`, then work in the project directory. For local development: `pi -e /absolute/path/to/pi-focus-task/index.ts`.

## Workflow

```text
/focus init
/focus add --raw Implement authentication
/focus switch Implement authentication
/focus edit
/new
```

`/focus init` adds `.pi-focus-task/` to the project's `.gitignore` and migrates an existing `FOCUS_TASK.md` or `CURRENT_TASK.md` brief if present. It never creates or edits `AGENTS.md` or a root-level task file. `/focus add` also updates `.gitignore`, so init is optional for new projects.

| Command | Action |
| --- | --- |
| `/focus` or `/focus list` | Show saved tasks and focused task (`*`). |
| `/focus init` | Configure private storage; migrate an old brief when no task is focused. |
| `/focus add [--raw\|--polish] [brief]` | Save a new task; first line becomes its title. |
| `/focus switch [id-or-title]` | Focus a saved task; use `/new` for a clean conversation. |
| `/focus edit [--raw\|--polish] [brief]` | Update the focused brief. |
| `/focus clear` | Remove focus without deleting the saved task. |
| `/focus delete <id-or-title>` | Permanently delete a task. |

With no input, interactive add/edit opens an editor; with no mode flag it offers raw or AI polish. In non-interactive mode, raw is the default. Raw input is stored exactly, without a model call. AI polish sends only the supplied draft to the selected model, then offers review in UI mode; in non-interactive mode the completed output saves without preview. Requests time out after 60 seconds; input and output are limited to 16 KiB. Select a task by UUID, unique prefix, or exact title. Only explicit commands change focus.

## Private storage and prompt behavior

```text
project/.pi-focus-task/
├── .active           # selected task identity
└── <task-uuid>.md   # editable Markdown brief (metadata comment on first line)
```

Edit the focused task file directly, or use `/focus edit`. Briefs should contain scope, constraints, decisions, progress, and the next step. There is no required Markdown schema. The brief is read from disk at the start of each agent run and appended **after `AGENTS.md` in Pi's project-context system-prompt section**; it is not sent as a separate user message on every model call. Compaction and fresh sessions retain that section. Switching focus mid-conversation does not remove earlier conversation references to the old task: use `/new` when switching unrelated work. No focus means no added prompt section.

The extension creates or preserves the project's `.gitignore`, adding `.pi-focus-task/` once. It never reads or writes `.git/info/exclude`. This `.gitignore` change can be committed; task files remain ignored. It does **not** untrack files already in Git: if you previously committed `FOCUS_TASK.md`, `.pi-focus-task/` files, or a focus instruction in `AGENTS.md`, remove them from Git yourself. Migration leaves legacy files unchanged to prevent data loss. Other VCS tools may require their own ignore rules. Do not store secrets in briefs: they enter model requests and may appear in Pi session history.

Files over 256 KiB, unsafe paths, and malformed markers are rejected. Focus prompts over 16 KiB are skipped with a warning rather than truncated. Task commands use a short-lived `.pi-focus-task/.lock` and atomic writes; use one active writer per project. Only focused task edits are checked against the previous body before saving.

## Development

```sh
npm ci
npm run check
npm test
```

`index.ts` implements Pi commands and prompt integration; `store.ts` implements task persistence. Tests use Node's built-in runner and a local model stub.
