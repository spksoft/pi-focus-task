# Focus Task

## Status
No active task.

## Completed outcome
Implemented pi-focus-task 0.1.0: a saved task list in `.pi-focus-task/`, with one active Markdown brief in `FOCUS_TASK.md`.

## Delivered
- `/focus init` creates the active brief and idempotently adds its read instruction to `AGENTS.md`.
- Initialization preserves existing focus content, migrates legacy `CURRENT_TASK.md` context when needed, and leaves the original unchanged as a backup.
- `/focus add`, `/focus switch`, `/focus list`, `/focus edit`, `/focus done`, `/focus clear`, and `/focus help`.
- Creation and editing offer raw saves or optional AI polishing; `--raw` and `--polish` choose directly. Interactive polishing includes a review editor and cancellation.
- Safe focus switching, backups, ID-prefix/title lookup, interactive selection, and reopening completed tasks.
- Fresh, bounded task context on every model call, including after compaction.
- Installable Pi package with documentation and no runtime dependencies.
- Polished README with GitHub/SSH installation, a guided workflow, and clear privacy and non-interactive behavior.

## Decisions
- Git remote `origin` is `git@github.com:spksoft/pi-focus-task.git`; publish the current `main` branch.
- Only `/focus` is registered; no `/task` alias, so other extensions can own that command.
- `FOCUS_TASK.md` replaces `CURRENT_TASK.md` as the active handoff everywhere in the extension.
- Only explicit `/focus init` updates `AGENTS.md`; normal startup and task commands do not.
- Initialization replaces old filename references in `AGENTS.md` and adds the read instruction only if absent.
- Each saved task has a Markdown brief and first-line identity/title/status comment. The active file is authoritative; replacing it atomically commits a focus switch.
- No custom compaction, database, or autonomous task switching.
- Raw saves preserve the body exactly, including whitespace. Creation derives a bounded display title from the first nonblank line; editing never changes task identity.
- AI polishing uses only the supplied brief and the selected Pi model, not conversation history or other tasks. It is bounded, cancellable, and optional; failures offer the original draft in interactive mode. Explicit headless --polish saves without a preview.

## Validation
- Clean dependency installation and `npm run check` passed.
- All 17 tests passed on Node 26.8.1 and Node 22.21.1 with Pi 0.86.1.
- Initialization checks cover repeated runs, existing content, legacy migration, unsafe paths, oversized files, idle guards, and command completion.
- Real Pi CLI tests verify init, coexistence with another extension's `/task`, and task switching across processes.
- Real provider requests through a loopback-only stub verify focus context survives actual automatic compaction without duplicate persisted snapshots, and exercise both creation and editing with AI polishing.
- Authoring tests cover exact raw text, Unicode titles, review before save, failures, raw fallback, cancellation, timeouts, session shutdown, and stale-edit protection. Raw CLI saves make no model request.
- `npm pack --dry-run` includes only the runtime files, package manifest, and README.
- Initialized this repository and verified a repeated init changed neither file.

## Known limits
- Use one active writer per project; only extension commands participate in the lock.
- Briefs have a 16 KiB automatic context limit and a 256 KiB file limit. Initialization also bounds AGENTS.md to 256 KiB.
- AI polish input/output is limited to 16 KiB, with a 60-second request deadline. Polishing may incur model charges.
- Use `/reload` after initialization to refresh Pi's loaded project instructions.
- Use `/new` after switching unrelated features if a clean conversation is desired.

## Next step
None required. Follow README.md to install and initialize another project.

## Blockers
None.
