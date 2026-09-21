# pi-focus-task — Project Guide

## Mission

`pi-focus-task` is a Pi extension that keeps one long-running task coherent across sessions and context compaction.

It turns a simple context-engineering practice into a reliable workflow:

- `AGENTS.md` contains durable project knowledge and rules.
- `FOCUS_TASK.md` contains the active task's temporary context.
- The Pi session is disposable working memory.

A new or compacted session should be able to continue the task from `FOCUS_TASK.md` without replaying the old conversation.

## Problem

Coding sessions work best when they stay focused on one feature or problem. Long tasks eventually accumulate irrelevant context, enter a low-quality “dumb zone,” trigger automatic compaction, or require a fresh session. Starting over restores context quality but can lose the task's decisions, progress, constraints, and next step.

This project preserves that continuity outside the conversation while keeping unrelated tasks separate.

## Core product model

### One active focus

A project can save multiple tasks in `.pi-focus-task/`, but has at most one active focus task. Switching saves the outgoing brief and restores the selected task to `FOCUS_TASK.md`; unrelated task briefs must never be merged.

### Plain Markdown is the persistence layer

`FOCUS_TASK.md` is the canonical, human-readable handoff. It must remain useful when:

- Pi is restarted;
- a new session is created;
- conversation history is compacted;
- the extension is temporarily unavailable; or
- another coding harness opens the project.

Do not make session JSONL, extension-only state, a database, or a proprietary format the sole source of truth.

### The user owns task scope

The extension may help read, create, update, or close the active task, but it must not silently replace an unfinished task or invent decisions. Explicit user instructions take precedence.

### Context must stay small and actionable

The task file is a brief, not a transcript. Preserve facts needed to resume work: objective, scope, constraints, decisions, progress, blockers, validation, and the next concrete step.

## MVP responsibilities

The first useful version should:

1. Provide `/focus init` to create `FOCUS_TASK.md` and idempotently add its read instruction to `AGENTS.md`, preserving existing content. Read the project-local `FOCUS_TASK.md`.
2. Make an active task available to the agent before work begins.
3. Provide a small, explicit workflow to start, inspect, update, complete, or switch the focus task.
4. Preserve the task across new sessions and Pi compaction.
5. Keep the file directly editable and understandable without the extension.
6. Fail clearly on missing, unreadable, or oversized task context without blocking unrelated Pi usage.

Exact command names and richer UI are secondary to this lifecycle working end to end.

## `FOCUS_TASK.md` contract

The file should answer, as briefly as possible:

- What is the current objective?
- What is in and out of scope?
- Which constraints and decisions must be preserved?
- What has been completed and validated?
- What is blocked or unresolved?
- What exact action should happen next?

Use ordinary Markdown headings and lists. Prefer a tolerant format over a strict parser so users and other agents can edit it safely. Never store secrets in it.

“No active task” is a valid state. Do not force every small request into a persistent task.

## Technical direction

- Implement the product as a TypeScript Pi extension and distributable Pi package.
- Use the official `@earendil-works/pi-coding-agent` extension API.
- Prefer Node.js built-ins and Pi's bundled packages; add runtime dependencies only when they remove more complexity than they add.
- Use `before_agent_start` for a dedicated guidance section, and the `context` event for a bounded, fresh task snapshot before every model call, including after compaction. Do not replace the full system prompt.
- Use extension commands for user-driven lifecycle actions. Add a model-callable tool only when the agent genuinely needs to perform an action autonomously.
- Read from disk when fresh state matters. Avoid watchers, daemons, caches, and background resources until measured need exists.
- Let Pi own sessions and compaction. The extension preserves task continuity; it is not a replacement compaction engine.
- Keep the basic workflow deterministic. Creation and editing offer raw input or opt-in AI polishing with the selected Pi model; raw saves must preserve the supplied body exactly and never call a model. Review polished output interactively before saving, and never alter task identity or invent task facts.
- Bound injected content and clearly delimit it from extension instructions.
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
- Test task-state transitions, prompt injection, raw saves, and AI-polish approval/cancellation/failure paths with the smallest meaningful automated checks.
- Keep extension output concise and avoid exposing full task contents in logs or UI notifications.
- Package Pi-provided imports as peer dependencies and place actual runtime libraries in `dependencies`.

## Repository layout and checks

- `index.ts`: `/focus` commands, focus status, and Pi context hooks.
- `store.ts`: project initialization, Markdown persistence, focus transitions, backups, and validation.
- `test/focus-task.test.ts`: storage, command, context, and real Pi CLI checks.
- `README.md`: installation, workflow, storage contract, and limitations.
- Run `npm ci`, `npm run check`, and `npm test` before handing off code changes.

## Current development task

Before making repository changes, read `FOCUS_TASK.md` for the active development scope and constraints.

- If it says there is no active task, use the user's current request as the scope.
- If it describes an active task, keep work within that boundary.
- Update it after material progress or decisions and before handing off unfinished work.
- Do not turn it into a chat transcript or duplicate the durable project guidance in this file.

## Focus task context

Before starting work, read FOCUS_TASK.md for the active scope and constraints.
