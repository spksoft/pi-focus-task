# pi-focus-task

**Keep the task. Start a fresh session.**

A small [Pi](https://pi.dev/) extension for long-running work. Save multiple task briefs, keep **one task in focus**, and resume it after a restart, a new session, or context compaction.

Your task lives in plain Markdown—not just the conversation:

| File | Purpose |
| --- | --- |
| `AGENTS.md` | Durable project knowledge and instructions. |
| `FOCUS_TASK.md` | Only the active task description: scope, decisions, progress, and next step. An empty file means no active task. |
| `.pi-focus-task/` | Saved tasks and the small internal marker for the selected task. |

No database, background service, build step, or additional runtime dependency. AI polishing is optional; raw saves never call a model.

## Install

Requires **Node.js 22.19+** and **Pi 0.86.1+** (`@earendil-works/pi-coding-agent`). Tested with Pi 0.86.1.

```sh
pi install git:github.com/spksoft/pi-focus-task
```

Prefer SSH?

```sh
pi install git:git@github.com:spksoft/pi-focus-task.git
```

Restart Pi or run `/reload`, then open Pi in the **project folder** whose tasks you want to manage. Task paths are relative to Pi's working directory; the extension does not search parent repositories.

For local development, install the checkout or try it for one session:

```sh
pi install /absolute/path/to/pi-focus-task
# Or, without installing:
pi -e /absolute/path/to/pi-focus-task/index.ts
```

## Quick start

In your project, run:

```text
/focus init
/reload
/focus add --raw Implement authentication
/focus switch Implement authentication
/focus edit
```

Write the objective, scope, constraints, and next step. Choose **Save raw input** or **Polish with AI**, then work normally. You or the agent can also edit `FOCUS_TASK.md` directly.

To work on something else:

```text
/focus add --raw Improve search
/focus switch Improve search
/new
```

Switching saves the outgoing brief and restores the selected one. It does **not** clear the conversation; `/new` is recommended for unrelated work.

When you return, your saved progress comes with you:

```text
/focus switch Implement authentication
```

Use `/focus done` when finished, or `/focus clear` to pause without marking the task complete. Both save the brief and clear focus.

## Commands

Only `/focus` is registered; `/task` remains available to other extensions.

| Command | What it does |
| --- | --- |
| `/focus init` | Set up `AGENTS.md` and `FOCUS_TASK.md` without replacing existing briefs. Safe to repeat. |
| `/focus` or `/focus list` | List saved tasks; `*` marks the active one. Shows up to 50 entries. |
| `/focus add [--raw\|--polish] [brief]` | Create a task without changing focus. Omit the brief to open an editor. |
| `/focus switch [id-or-title]` | Save the outgoing brief and switch tasks. Omit the selector for a picker. |
| `/focus edit [--raw\|--polish] [brief]` | Edit the active brief, or replace it with supplied text. |
| `/focus done` | Save the active task as completed and clear focus. |
| `/focus clear` | Save the active task, leave it open, and clear focus. |
| `/focus help` | Show command help. |

- Select tasks by full UUID, unique ID prefix, or exact title (case-insensitive). Use an ID when titles are duplicated.
- Creation derives the title from the first nonblank input line, removing a Markdown heading marker and keeping at most 200 Unicode characters. The body is not truncated.
- Editing or polishing changes the body, not its title or identity. Switching to a completed task reopens it.
- Task-changing commands require Pi to be idle. Canceling a dialog leaves files unchanged. The extension never switches or completes tasks on its own.

## Raw input or AI polish

Creation and editing offer two choices:

| Mode | Behavior |
| --- | --- |
| **Save raw input** | Preserve the supplied body exactly, including whitespace and line endings. No template, reformatting, or model call. |
| **Polish with AI** | Ask the selected Pi model to clarify and organize the brief, then review and edit the draft before saving. |

Use a flag to choose directly:

```text
/focus add --raw Implement authentication
/focus add --polish Fix login timeout; keep existing sessions compatible
/focus edit --raw
/focus edit --polish
```

Both commands accept multiline input. Without input, interactive creation opens a blank editor and editing opens the active brief. The first whitespace character after the command or flag is a separator; the remaining body is preserved in raw mode. For text beginning with `--`, use a separator: `/focus add --raw -- --polish is literal task text`.

**Polishing is opt-in and may incur model charges.** Only the supplied brief is sent—not conversation history, other tasks, or project files. The prompt asks the model to preserve language, intent, constraints, and known facts without inventing scope or completed work. Review the result; these instructions are not a correctness guarantee.

Polishing accepts up to **16 KiB UTF-8** of input and output, with a **60-second** request deadline. Cancel the in-progress dialog to abort. Failures leave files unchanged and, in interactive mode, offer to save the original draft instead. Closing or switching the Pi session cancels an in-flight request.

## Project setup and migration

`/focus init` creates an empty `FOCUS_TASK.md` (no active task), unless it already exists, and adds this instruction to `AGENTS.md`:

> Before starting work, read FOCUS_TASK.md for the active scope and constraints.

Existing project instructions and briefs are preserved. Repeated initialization does not duplicate the instruction. Only explicit initialization edits `AGENTS.md`; startup and ordinary task commands do not. Run `/reload` afterward to refresh Pi's loaded instructions.

Migrating from `CURRENT_TASK.md`:

- If the new file is absent, initialization copies the legacy brief to `FOCUS_TASK.md`, moves any old identity metadata into `.pi-focus-task/.active`, and updates filename references in `AGENTS.md`.
- The original stays untouched as a backup. If both files exist, `FOCUS_TASK.md` wins and neither brief is overwritten.
- Until migration, listing and switching ask you to run `/focus init` rather than ignore legacy progress. Saved tasks in `.pi-focus-task/` need no migration.

After checking the migration, archive or remove the old file yourself. Only `FOCUS_TASK.md` is used going forward.

## Storage and direct editing

```text
project/
├── AGENTS.md
├── FOCUS_TASK.md                    # active task description only; empty = no focus
└── .pi-focus-task/
    ├── .active                       # selected saved task identity (internal)
    ├── <task-uuid>.md               # saved task briefs
    └── backups/<backup-uuid>.md     # previous unmanaged focus files
```

`FOCUS_TASK.md` contains ordinary Markdown only—no identity comment, status heading, template, or required schema:

```markdown
# Authentication

## Objective
Allow users to sign in.

## Next step
Test expired tokens.
```

While a task is active, edit `FOCUS_TASK.md`, not its saved copy. The extension keeps the selected saved-task identity in `.pi-focus-task/.active` and updates its saved copy when switching, clearing, or completing. The body has no required headings; keep only what is needed to resume work.

A completely empty `FOCUS_TASK.md` means no active focus. A hand-written nonempty file also works without importing it. The first explicit switch backs it up under `backups/` and reports the path. Clear/done never erase an unmanaged brief. To restore a backup, clear any managed focus first, then copy the backup to `FOCUS_TASK.md`.

### Privacy and version control

Choose whether task files belong in Git. For private local notes, add these entries to your project's `.gitignore`:

```gitignore
.pi-focus-task/
FOCUS_TASK.md
```

**Do not store secrets in briefs.** An agent following `AGENTS.md` may read the brief, and AI polishing sends the supplied draft to the selected model. Markdown remains readable by humans and other coding harnesses without the extension.

## Safety

- The extension never injects model messages or prompt sections. `AGENTS.md` tells the agent to read `FOCUS_TASK.md` when starting work; `/focus init` adds that instruction once.
- Rejects files over **256 KiB**, malformed saved-task metadata or active markers, unsafe IDs, and symlinked task paths. Initialization also bounds `AGENTS.md` to 256 KiB.
- Allows ordinary Pi use without an active task; file-operation errors are reported without replacing files.

**Use one active writer per project.** Commands use a short-lived `.pi-focus-task/.lock` directory and atomic replacement, but external editors do not honor that lock. Edits are checked against the original brief before saving to avoid overwriting newer work.

If a process crashes while holding the lock, stop all writers, inspect the task files, then remove the empty lock directory. Inspect leftover `.tmp` files before deleting them. Atomic renames prevent partial replacements, not data loss from hardware or power failures.

## Non-interactive use

Print and JSON modes support commands with explicit arguments:

```sh
pi -p '/focus init'
pi -p '/focus add --raw Investigate timeout'
pi -p '/focus switch Investigate timeout'
pi -p '/focus edit --raw Check the retry deadline and preserve existing behavior.'
pi -p '/focus list'
```

Without a mode flag, non-interactive creation/editing defaults to raw input. You can also edit `FOCUS_TASK.md` with normal file tools.

**Explicit `--polish` saves without a preview in non-interactive modes.** `/focus edit --polish` polishes the existing active brief when no replacement text is supplied. A failed model request saves nothing.

Command results go to stderr, leaving stdout's Pi output format intact. RPC clients can use standard select/editor dialogs if they implement Pi's extension UI protocol.

## Development

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

- `index.ts` — commands and authoring dialogs.
- `store.ts` — initialization, Markdown persistence, transitions, and validation.
- `test/focus-task.test.ts` — storage, authoring, command, and integration checks.

Tests use Node's built-in runner, temporary projects, an isolated real Pi CLI, and a loopback-only model stub. They check command behavior and AI-polish requests without provider credentials or changes to your Pi settings.
