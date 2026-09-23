# pi-focus-task — Project Guide

## Mission

`pi-focus-task` is a Pi extension that keeps one long-running task coherent across sessions and context compaction.

It turns a simple context-engineering practice into a reliable workflow:

- `AGENTS.md` contains durable project knowledge and rules.
- `.pi-focus-task/<task-uuid>.md` contains each private task brief; `.active` selects one.
- The Pi session is disposable working memory.

A new or compacted session should recover the focused brief from private storage without replaying the old conversation.

## Problem

Coding sessions work best when they stay focused on one feature or problem. Long tasks eventually accumulate irrelevant context, enter a low-quality “dumb zone,” trigger automatic compaction, or require a fresh session. Starting over restores context quality but can lose the task's decisions, progress, constraints, and next step.

This project preserves that continuity outside the conversation while keeping unrelated tasks separate.

## Core product model

### One active focus

A project can save multiple tasks in `.pi-focus-task/`, but has at most one active focus task. Switching selects a different saved brief; unrelated task briefs must never be merged.

### Plain Markdown is the persistence layer

Each private task Markdown file is the human-readable handoff. It must remain useful when:

- Pi is restarted;
- a new session is created;
- conversation history is compacted;
- the extension is temporarily unavailable; or
- another coding harness opens the project.

Do not make session JSONL, extension-only state, a database, or a proprietary format the sole source of truth.

### The user owns task scope

The extension may help read, create, update, switch, or explicitly delete tasks, but it must not silently replace or delete a task or invent decisions. Explicit user instructions take precedence.

### Context must stay small and actionable

The task file is a brief, not a transcript. Preserve facts needed to resume work: objective, scope, constraints, decisions, progress, blockers, validation, and the next concrete step.

## MVP responsibilities

The first useful version should:

1. Keep task briefs in `.pi-focus-task/`, excluded through the project's `.gitignore`; never modify `AGENTS.md` for task guidance.
2. Append the focused brief after `AGENTS.md` within Pi's project-context system-prompt section at agent-run start, not as a separate message per call.
3. Provide commands to add, inspect, edit, switch, clear, or delete a focus task. Clearing does not delete it or assign completion state.
4. Preserve briefs across new sessions and Pi compaction, and keep files directly editable.
5. Fail clearly on missing, unreadable, or oversized task context without blocking unrelated Pi usage.

Exact command names and richer UI are secondary to this lifecycle working end to end.

## Task brief contract

The file should answer, as briefly as possible:

- What is the current objective?
- What is in and out of scope?
- Which constraints and decisions must be preserved?
- What has been completed and validated?
- What is blocked or unresolved?
- What exact action should happen next?

Task files have a short identity header followed by plain Markdown, with no required status template or transcript. Keep briefs tolerant of direct editing. Never store secrets in them. No `.active` marker means no active task; do not force every small request into a persistent task.

## Technical direction

- Implement the product as a TypeScript Pi extension and distributable Pi package.
- Use the official `@earendil-works/pi-coding-agent` extension API.
- Prefer Node.js built-ins and Pi's bundled packages; add runtime dependencies only when they remove more complexity than they add.
- Append only a bounded focused brief to Pi's project-context files at agent-run start. Do not add extra user messages or modify project instructions.
- Use extension commands for user-driven lifecycle actions. Add a model-callable tool only when the agent genuinely needs to perform an action autonomously.
- Read from disk when fresh state matters. Avoid watchers, daemons, caches, and background resources until measured need exists.
- Let Pi own sessions and compaction. The extension preserves task continuity; it is not a replacement compaction engine.
- Keep the basic workflow deterministic. Creation and editing offer raw input or opt-in AI polishing with the selected Pi model; raw saves must preserve the supplied body exactly and never call a model. Review polished output interactively before saving, and never alter task identity or invent task facts.
- Bound focused prompt content and model calls used for optional polishing.
- Support non-interactive Pi modes where practical; never assume TUI-only UI is available without checking the runtime context.

## Non-goals

Unless explicitly requested, this project is not:

- a general todo list or project-management system;
- a full backlog system with scheduling, priorities, dependencies, or issue-tracker integrations;
- a vector-memory or conversation-archive system;
- a custom session manager;
- a replacement for Pi's built-in compaction;
- a multi-agent orchestrator; or
- a mechanism for automatically mixing context from different features.

## Product principles

- **Focus over recall:** retain only what helps finish the active task.
- **Files over hidden state:** continuity must be inspectable and portable.
- **Explicit over magical:** users should understand when task state changes.
- **Fresh sessions are normal:** restarting should be cheap, not disruptive.
- **Compaction is lossy:** critical task state must exist outside conversation history.
- **Portable core, Pi-native UX:** keep the task-file convention harness-agnostic while using Pi's extension APIs for integration.
- **Smallest useful implementation:** no speculative storage layers, schemas, services, or UI frameworks.

## Definition of success

The project succeeds when a user can work on one feature for days, start a fresh Pi session at any time, and immediately recover:

- the goal;
- the agreed boundaries;
- important decisions;
- current progress and validation state; and
- the next action.

It should require less effort than manually reconstructing context and add little noise to ordinary short tasks.

## Development guidance

- Consult the installed Pi documentation and extension examples before using or changing Pi APIs.
- Keep file I/O safe: validate paths, avoid destructive overwrites, and preserve user-authored content whenever possible.
- Test task-state transitions, prompt injection only when focused, raw saves, and AI-polish approval/cancellation/failure paths with the smallest meaningful automated checks.
- Keep extension output concise and avoid exposing full task contents in logs or UI notifications.
- Package Pi-provided imports as peer dependencies and place actual runtime libraries in `dependencies`.

## Repository layout and checks

- `index.ts`: `/focus` file-operation commands and optional authoring dialogs.
- `store.ts`: private Markdown persistence, focus transitions, migration, and validation.
- `test/focus-task.test.ts`: storage, command, and real Pi CLI checks.
- `README.md`: installation, workflow, storage contract, and limitations.
- Run `npm ci`, `npm run check`, and `npm test` before handing off code changes.

## Current development task

Use the user's current request as scope when no task is focused. Do not turn task briefs into transcripts or duplicate durable project guidance.
