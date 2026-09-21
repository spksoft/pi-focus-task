import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import type { ContextEvent, ContextEventResult, ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { addTask, clearTask, editTask, findTask, focusTask, initProject, listTasks, MAX_CONTEXT_BYTES, MAX_FILE_BYTES, NO_TASK, taskContext } from "../store.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function project(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-focus-task-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function current(cwd: string) { return readFileSync(join(cwd, "FOCUS_TASK.md"), "utf8"); }
function saveCurrent(cwd: string, text: string) { writeFileSync(join(cwd, "FOCUS_TASK.md"), text); }
function contextText(messages: ContextEvent["messages"]) {
  const message = messages.at(-1);
  assert.ok(message?.role === "custom");
  return String(message.content);
}

function harness(cwd: string, hasUI = true) {
  const events = new Map<string, (...args: any[]) => any>();
  let command: Omit<RegisteredCommand, "name" | "sourceInfo">;
  const notices: string[] = [];
  let status: string | undefined;
  let idle = true;
  const ctx = {
    cwd, hasUI, mode: hasUI ? "tui" : "print", isIdle: () => idle,
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: (_key: string, text: string | undefined) => { status = text; },
      input: async () => undefined,
      select: async () => undefined,
      editor: async () => undefined,
    },
  } as unknown as ExtensionCommandContext;
  extension({
    on: (name: string, handler: (...args: any[]) => any) => { events.set(name, handler); },
    registerCommand: (name: string, options: typeof command) => { assert.equal(name, "focus"); command = options; },
  } as unknown as ExtensionAPI);
  return {
    ctx, notices, events,
    run: (args: string) => command.handler(args, ctx),
    completions: (prefix: string) => command.getArgumentCompletions?.(prefix),
    context: (messages: ContextEvent["messages"] = []) => events.get("context")!({ messages }, ctx) as ContextEventResult,
    status: () => status,
    busy: (value: boolean) => { idle = !value; },
  };
}

type Completion = Awaited<ReturnType<ExtensionCommandContext["modelRegistry"]["complete"]>>;
function completed(text: string, stopReason: Completion["stopReason"] = "stop"): Completion {
  return { content: [{ type: "text", text }], stopReason } as Completion;
}

function authoring(cwd: string) {
  const h = harness(cwd);
  const calls: { content: unknown; options: unknown }[] = [];
  h.ctx.model = { provider: "test", id: "polisher" } as NonNullable<typeof h.ctx.model>;
  h.ctx.modelRegistry = {
    complete: async (_model: unknown, context: { messages: unknown }, options: unknown) => {
      calls.push({ content: context.messages, options });
      return completed("# Polished brief\nKeep the agreed scope.\n");
    },
  } as unknown as typeof h.ctx.modelRegistry;
  h.ctx.ui.select = async (title, _choices, options) => {
    if (title === "Polishing task…") return new Promise(resolve => {
      if (options?.signal?.aborted) resolve(undefined);
      else options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    return title === "Save task brief" ? "Polish with AI" : "Cancel";
  };
  h.ctx.ui.editor = async (_title, prefill) => prefill;
  return { ...h, calls };
}

test("create and edit preserve raw input exactly without a model call", async t => {
  const cwd = project(t);
  const h = authoring(cwd);
  const raw = "  # งานใหม่\r\n\r\n  keep  spaces and line endings  \r\n";
  await h.run(`add --raw ${raw}`);
  const task = listTasks(cwd).tasks[0];
  assert.equal(task.title, "งานใหม่");
  assert.equal(task.body, raw);
  assert.equal(h.calls.length, 0);
  focusTask(cwd, task.id);
  h.ctx.ui.editor = async () => "  Edited raw text\n\n";
  h.ctx.ui.select = async () => "Save raw input";
  await h.run("edit");
  assert.equal(listTasks(cwd).active?.body, "  Edited raw text\n\n");
  assert.equal(h.calls.length, 0);
  await h.run("edit --raw Inline edit\n  unchanged  \n");
  assert.equal(listTasks(cwd).active?.body, "Inline edit\n  unchanged  \n");
  await h.run("add --raw -- --polish is literal task text  ");
  assert.ok(listTasks(cwd).tasks.some(task => task.body === "--polish is literal task text  "));
  await h.run("add --polish --raw Bad flags");
  assert.match(h.notices.at(-1)!, /one of --raw or --polish/);
  assert.equal(h.calls.length, 0);
  h.ctx.ui.editor = async () => "Created in the editor\n  raw body  \n";
  await h.run("add");
  assert.equal(listTasks(cwd).tasks.find(task => task.title === "Created in the editor")?.body, "Created in the editor\n  raw body  \n");
  const unicode = "🦦".repeat(201);
  await h.run(`add --raw ${unicode}`);
  assert.equal(listTasks(cwd).tasks.find(task => task.body === unicode)?.title, "🦦".repeat(200));
  assert.throws(() => addTask(cwd, "Too large", "x".repeat(MAX_FILE_BYTES)), /256 KiB/);
});

test("create and edit offer AI polish and save only the reviewed result", async t => {
  const cwd = project(t);
  const h = authoring(cwd);
  const raw = "Authentication\nKeep existing accounts; no new provider.";
  h.ctx.ui.editor = async (title, prefill) => {
    assert.match(title, /Review polished task/);
    assert.match(prefill!, /Polished brief/);
    assert.equal(listTasks(cwd).tasks.length, 0);
    return "# User-reviewed authentication\nKeep existing accounts.\n";
  };
  await h.run(`add ${raw}`); // No flag: explicit UI choice selects polish.
  const task = listTasks(cwd).tasks[0];
  assert.equal(task.title, "Authentication");
  assert.equal(task.body, "# User-reviewed authentication\nKeep existing accounts.\n");
  assert.equal(h.calls.length, 1);
  assert.equal((h.calls[0].content as { content: string }[])[0].content, raw);
  focusTask(cwd, task.id);
  const before = current(cwd);
  h.ctx.ui.editor = async (title, prefill) => {
    assert.equal(current(cwd), before);
    return title.startsWith("Review") ? `${prefill}Reviewed edit.\n` : "Rough edit.\n";
  };
  await h.run("edit --polish");
  assert.equal(h.calls.length, 2);
  assert.equal(listTasks(cwd).active?.id, task.id);
  assert.match(listTasks(cwd).active!.body, /Reviewed edit/);
});

test("cancelled choices, reviews and model calls leave task files unchanged", async t => {
  const cwd = project(t);
  const h = authoring(cwd);
  h.ctx.ui.select = async () => undefined;
  await h.run("add Cancel at choice");
  assert.equal(h.calls.length, 0);
  assert.equal(listTasks(cwd).tasks.length, 0);
  const reviewed = authoring(cwd);
  reviewed.ctx.ui.editor = async () => undefined;
  await reviewed.run("add --polish Cancel at review");
  assert.equal(listTasks(cwd).tasks.length, 0);
  const waiting = authoring(cwd);
  let signal: AbortSignal | undefined;
  waiting.ctx.modelRegistry.complete = (_model, _context, options) => {
    signal = options?.signal;
    return new Promise(() => {}); // Simulate a provider ignoring abort; the UI must still return.
  };
  waiting.ctx.ui.select = async () => "Cancel";
  await waiting.run("add --polish Cancel inference");
  assert.equal(signal?.aborted, true);
  assert.equal(listTasks(cwd).tasks.length, 0);
  const shuttingDown = authoring(cwd);
  shuttingDown.ctx.modelRegistry.complete = async () => {
    shuttingDown.events.get("session_shutdown")!({}, shuttingDown.ctx);
    return completed("Must not be saved");
  };
  await shuttingDown.run("add --polish Shutdown");
  assert.equal(listTasks(cwd).tasks.length, 0);
});

test("polish failures offer the untouched draft, and stale edits never overwrite newer work", async t => {
  const cwd = project(t);
  const task = addTask(cwd, "Existing", "Original body");
  focusTask(cwd, task.id);
  for (const result of [completed("", "stop"), completed("Incomplete", "length"), completed("", "error"), completed("x".repeat(MAX_CONTEXT_BYTES + 1))]) {
    const h = authoring(cwd);
    h.ctx.modelRegistry.complete = async () => result;
    const select = h.ctx.ui.select;
    h.ctx.ui.select = async (title, options, config) => title.startsWith("Polishing failed") ? "Save raw input" : select(title, options, config);
    const raw = "  Keep my edited draft\n";
    await h.run(`edit --polish ${raw}`);
    assert.equal(listTasks(cwd).active?.body, raw);
  }
  const noModel = authoring(cwd);
  noModel.ctx.model = undefined;
  await noModel.run("add --polish Needs a model");
  assert.equal(listTasks(cwd).tasks.length, 1);
  assert.equal(noModel.calls.length, 0);
  const oversized = authoring(cwd);
  await oversized.run(`add --polish ${"x".repeat(MAX_CONTEXT_BYTES + 1)}`);
  assert.equal(oversized.calls.length, 0);
  const stale = authoring(cwd);
  stale.ctx.ui.editor = async (_title, prefill) => {
    saveCurrent(cwd, current(cwd) + "\nNew work from another editor.\n");
    return prefill;
  };
  await stale.run("edit --polish A rough change");
  assert.match(stale.notices.at(-1)!, /changed while editing/);
  assert.match(current(cwd), /New work from another editor/);
  assert.doesNotMatch(listTasks(cwd).active!.body, /Polished brief/);
});

test("timed-out polishing can save the original draft without waiting for a stuck provider", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cwd = project(t);
  const h = authoring(cwd);
  h.ctx.modelRegistry.complete = () => new Promise(() => {});
  const select = h.ctx.ui.select;
  h.ctx.ui.select = async (title, choices, options) => title.startsWith("Polishing failed") ? "Save raw input" : select(title, choices, options);
  const run = h.run("add --polish Keep original text  \n");
  t.mock.timers.tick(60_000);
  await run;
  assert.ok(h.notices.some(message => message.includes("timed out")));
  assert.equal(listTasks(cwd).tasks[0].body, "Keep original text  \n");
});

test("init creates focus guidance once and preserves existing project instructions and briefs", t => {
  const cwd = project(t);
  assert.deepEqual(initProject(cwd), { created: true, migrated: false, agentsUpdated: true });
  assert.equal(current(cwd), NO_TASK);
  const agentsPath = join(cwd, "AGENTS.md");
  const instructions = readFileSync(agentsPath, "utf8");
  assert.match(instructions, /Before starting work, read FOCUS_TASK.md for the active scope and constraints\./);
  assert.deepEqual(initProject(cwd), { created: false, migrated: false, agentsUpdated: false });
  assert.equal(readFileSync(agentsPath, "utf8"), instructions);
  assert.equal(current(cwd), NO_TASK);
  assert.equal(existsSync(join(cwd, "CURRENT_TASK.md")), false);

  const original = "# Project rules\r\n\r\nKeep tests passing.  \r\n";
  writeFileSync(agentsPath, original);
  saveCurrent(cwd, "# Existing focus\nDo not overwrite this.\n");
  writeFileSync(join(cwd, "CURRENT_TASK.md"), "Old context must not replace the new focus.");
  initProject(cwd);
  assert.ok(readFileSync(agentsPath, "utf8").startsWith(original));
  assert.equal(current(cwd), "# Existing focus\nDo not overwrite this.\n");
  const updated = readFileSync(agentsPath, "utf8");
  initProject(cwd);
  assert.equal(readFileSync(agentsPath, "utf8"), updated);
  assert.equal((updated.match(/Before starting work/g) ?? []).length, 1);
});

test("init migrates legacy context and guidance without discarding unsaved task progress", t => {
  const cwd = project(t);
  const a = addTask(cwd, "Legacy focus");
  const b = addTask(cwd, "Other focus");
  focusTask(cwd, a.id);
  saveCurrent(cwd, current(cwd) + "\nUnsaved legacy checkpoint.\n");
  const original = current(cwd);
  const legacy = join(cwd, "CURRENT_TASK.md");
  renameSync(join(cwd, "FOCUS_TASK.md"), legacy);
  const guidance = "# Project rules\nBefore starting work, read CURRENT_TASK.md for the active scope and constraints.\n";
  writeFileSync(join(cwd, "AGENTS.md"), guidance);
  assert.throws(() => taskContext(cwd), /Run \/focus init/);
  assert.throws(() => focusTask(cwd, b.id), /Run \/focus init/);
  assert.equal(initProject(cwd).migrated, true);
  assert.equal(current(cwd), original);
  assert.equal(readFileSync(legacy, "utf8"), original);
  assert.equal(listTasks(cwd).active?.id, a.id);
  assert.equal(readFileSync(join(cwd, "AGENTS.md"), "utf8"), guidance.replaceAll("CURRENT_TASK.md", "FOCUS_TASK.md"));
  saveCurrent(cwd, current(cwd) + "New checkpoint.\n");
  initProject(cwd);
  assert.match(current(cwd), /New checkpoint/);
  focusTask(cwd, b.id);
  focusTask(cwd, a.id);
  assert.match(current(cwd), /Unsaved legacy checkpoint/);
  assert.match(current(cwd), /New checkpoint/);
  assert.equal(readFileSync(legacy, "utf8"), original);

  const empty = project(t);
  writeFileSync(join(empty, "CURRENT_TASK.md"), "# Current Task\n\nNo active task.\n");
  initProject(empty);
  assert.deepEqual(taskContext(empty), {});
});

test("init migrates old metadata out of FOCUS_TASK.md", t => {
  const cwd = project(t);
  const task = addTask(cwd, "Old active", "# Old active\n\nKeep this exact brief.\n");
  saveCurrent(cwd, readFileSync(join(cwd, ".pi-focus-task", `${task.id}.md`), "utf8"));
  initProject(cwd);
  assert.equal(current(cwd), task.body);
  assert.doesNotMatch(current(cwd), /^<!-- pi-focus-task/);
  assert.equal(listTasks(cwd).active?.id, task.id);
  assert.match(readFileSync(join(cwd, ".pi-focus-task", ".active"), "utf8"), new RegExp(task.id));
});

test("init rejects unsafe or oversized files without overwriting other setup targets", t => {
  const outside = join(project(t), "outside.md");
  writeFileSync(outside, "Keep this file.");
  for (const target of ["AGENTS.md", "FOCUS_TASK.md", "CURRENT_TASK.md"]) {
    const cwd = project(t);
    symlinkSync(outside, join(cwd, target));
    assert.throws(() => initProject(cwd), /regular file/);
    assert.equal(readFileSync(outside, "utf8"), "Keep this file.");
    if (target !== "FOCUS_TASK.md") assert.equal(existsSync(join(cwd, "FOCUS_TASK.md")), false);
    if (target !== "AGENTS.md") assert.equal(existsSync(join(cwd, "AGENTS.md")), false);
    assert.equal(existsSync(join(cwd, ".pi-focus-task", ".lock")), false);
  }
  const cwd = project(t);
  const original = "x".repeat(MAX_FILE_BYTES);
  writeFileSync(join(cwd, "AGENTS.md"), original);
  assert.throws(() => initProject(cwd), /AGENTS.md would exceed/);
  assert.equal(readFileSync(join(cwd, "AGENTS.md"), "utf8"), original);
  assert.equal(existsSync(join(cwd, "FOCUS_TASK.md")), false);
});

test("empty projects stay untouched; titles and selectors are validated", t => {
  const cwd = project(t);
  assert.deepEqual(listTasks(cwd), { tasks: [], active: undefined });
  assert.deepEqual(taskContext(cwd), {});
  assert.equal(existsSync(join(cwd, ".pi-focus-task")), false);
  for (const title of ["", " ", "first\nsecond", "\x1b[31mred", "x".repeat(201)]) assert.throws(() => addTask(cwd, title), /title/);
  const a = addTask(cwd, "เพิ่มฟีเจอร์ A");
  const b = addTask(cwd, "Feature B");
  assert.equal(existsSync(join(cwd, "FOCUS_TASK.md")), false);
  assert.equal(existsSync(join(cwd, "AGENTS.md")), false); // Only explicit init edits project guidance.
  assert.equal(listTasks(cwd).tasks.length, 2);
  assert.equal(findTask([a, b], a.id.slice(0, 8)).id, a.id);
  assert.equal(findTask([a, b], "feature b").id, b.id);
  assert.throws(() => findTask([a, b], ""), /Specify/);
  assert.throws(() => findTask([a, b], "../outside"), /not found/);
  assert.throws(() => focusTask(cwd, "../outside"), /Invalid task ID/);
  assert.throws(() => findTask([a, { ...b, title: a.title }], a.title), /Ambiguous/);
});

test("switch, edit, restart, complete, reopen and clear preserve Markdown", t => {
  const cwd = project(t);
  const a = addTask(cwd, "Feature A");
  const b = addTask(cwd, "Feature B");
  focusTask(cwd, a.id);
  assert.equal(current(cwd), a.body);
  assert.doesNotMatch(current(cwd), /^<!-- pi-focus-task/);
  saveCurrent(cwd, current(cwd) + "\nDecision: use SQLite.\nNext: test the migration.\n");
  const aText = current(cwd);
  focusTask(cwd, a.id); // A same-task focus must not discard unsaved edits.
  assert.equal(current(cwd), aText);
  focusTask(cwd, b.id);
  const archivedA = readFileSync(join(cwd, ".pi-focus-task", `${a.id}.md`), "utf8");
  assert.match(archivedA, /^<!-- pi-focus-task: /);
  assert.ok(archivedA.endsWith(aText));
  assert.doesNotMatch(current(cwd), /SQLite/);
  focusTask(cwd, a.id);
  assert.equal(current(cwd), aText);
  assert.equal(listTasks(cwd).active?.id, a.id);
  const snapshot = listTasks(cwd).active!;
  editTask(cwd, snapshot, "# Updated brief\nNext: implement validation.\n");
  assert.match(current(cwd), /Updated brief/);
  assert.throws(() => editTask(cwd, snapshot, "stale"), /changed while editing/);
  clearTask(cwd, true);
  assert.equal(current(cwd), NO_TASK);
  assert.equal(listTasks(cwd).tasks.find(task => task.id === a.id)?.status, "done");
  focusTask(cwd, a.id);
  assert.equal(listTasks(cwd).active?.status, "open");
  assert.match(current(cwd), /Updated brief/);
  clearTask(cwd);
  assert.equal(listTasks(cwd).tasks.find(task => task.id === a.id)?.status, "open");
  assert.equal(listTasks(cwd).active, undefined);
  assert.equal(clearTask(cwd), undefined);
  assert.throws(() => clearTask(cwd, true), /No managed/);
});

test("an empty FOCUS_TASK.md means no active focus", t => {
  const cwd = project(t);
  const task = addTask(cwd, "Keep saved", "# Keep saved\n");
  focusTask(cwd, task.id);
  saveCurrent(cwd, "");
  assert.deepEqual(taskContext(cwd), {});
  assert.equal(listTasks(cwd).active, undefined);
  assert.ok(listTasks(cwd).tasks.some(saved => saved.id === task.id));
});

test("existing hand-written context is readable and backed up, not destroyed", t => {
  const cwd = project(t);
  const original = "# Important work\nPreserve this exact brief.\n";
  saveCurrent(cwd, original);
  assert.equal(taskContext(cwd).body, original);
  assert.equal(clearTask(cwd), undefined);
  assert.equal(current(cwd), original);
  const a = addTask(cwd, "New work");
  assert.equal(current(cwd), original);
  const result = focusTask(cwd, a.id);
  assert.ok(result.backup);
  assert.equal(readFileSync(result.backup, "utf8"), original);
  const other = project(t);
  assert.deepEqual(listTasks(other).tasks, []);
  assert.equal(existsSync(join(other, ".pi-focus-task")), false);
});

test("invalid metadata, symlinks, locks and failed saves do not replace active context", t => {
  const cwd = project(t);
  const a = addTask(cwd, "A");
  const b = addTask(cwd, "B");
  focusTask(cwd, a.id);
  const before = current(cwd);
  const archived = join(cwd, ".pi-focus-task", `${a.id}.md`);
  rmSync(archived);
  mkdirSync(archived);
  assert.throws(() => focusTask(cwd, b.id), /non-regular/);
  assert.equal(current(cwd), before);
  assert.equal(existsSync(join(cwd, ".pi-focus-task", ".lock")), false);
  rmSync(archived, { recursive: true });
  const outside = join(project(t), "outside.md");
  writeFileSync(outside, "untouched");
  symlinkSync(outside, archived);
  assert.throws(() => focusTask(cwd, b.id), /non-regular/);
  assert.equal(readFileSync(outside, "utf8"), "untouched");
  assert.equal(current(cwd), before);
  rmSync(archived);
  mkdirSync(join(cwd, ".pi-focus-task", ".lock"));
  assert.throws(() => addTask(cwd, "Locked"), /Another task operation/);
  assert.throws(() => taskContext(cwd), /in progress/);
  rmSync(join(cwd, ".pi-focus-task", ".lock"), { recursive: true });
  saveCurrent(cwd, "<!-- pi-focus-task: broken -->\nMust not lose this.\n");
  assert.throws(() => focusTask(cwd, b.id), /old task metadata/);
  assert.match(current(cwd), /Must not lose/);
  saveCurrent(cwd, before);
  writeFileSync(join(cwd, ".pi-focus-task", ".active"), '{"id":"../../escape"}\n');
  assert.throws(() => clearTask(cwd), /Invalid active-task marker/);
  const other = project(t);
  symlinkSync(join(cwd, ".pi-focus-task"), join(other, ".pi-focus-task"));
  assert.throws(() => addTask(other, "Cross-project"), /real directory/);
  const linked = project(t);
  symlinkSync(outside, join(linked, "FOCUS_TASK.md"));
  assert.throws(() => taskContext(linked), /regular file/);
});

test("size limits are byte-based and never truncate or overwrite task files", t => {
  const cwd = project(t);
  saveCurrent(cwd, "x".repeat(MAX_CONTEXT_BYTES));
  assert.equal(taskContext(cwd).body?.length, MAX_CONTEXT_BYTES);
  saveCurrent(cwd, "ก".repeat(Math.ceil(MAX_CONTEXT_BYTES / 3)));
  assert.throws(() => taskContext(cwd), /16 KiB/);
  assert.ok(current(cwd).length > 0);
  saveCurrent(cwd, "x".repeat(MAX_FILE_BYTES + 1));
  assert.throws(() => taskContext(cwd), /256 KiB/);
  const a = addTask(cwd, "New");
  assert.throws(() => focusTask(cwd, a.id), /256 KiB/);
  assert.equal(current(cwd).length, MAX_FILE_BYTES + 1);
  saveCurrent(cwd, NO_TASK);
  focusTask(cwd, a.id);
  const before = current(cwd);
  assert.throws(() => editTask(cwd, listTasks(cwd).active!, "x".repeat(MAX_FILE_BYTES + 1)), /256 KiB/);
  assert.equal(current(cwd), before);
  editTask(cwd, listTasks(cwd).active!, "");
  assert.deepEqual(taskContext(cwd), {});
  assert.equal(listTasks(cwd).active, undefined);
  assert.ok(listTasks(cwd).tasks.some(task => task.id === a.id));
});

test("commands support pickers, cancel, editing, errors, completion and busy guards", async t => {
  const cwd = project(t);
  const h = harness(cwd);
  assert.deepEqual(h.completions("in"), [{ value: "init", label: "init" }]);
  h.busy(true);
  await h.run("init");
  assert.match(h.notices.at(-1)!, /Wait for Pi/);
  assert.equal(existsSync(join(cwd, "AGENTS.md")), false);
  h.busy(false);
  await h.run("init extra");
  assert.match(h.notices.at(-1)!, /does not accept/);
  await h.run("init");
  assert.match(h.notices.at(-1)!, /Created FOCUS_TASK.md/);
  assert.match(h.notices.at(-1)!, /Updated AGENTS.md/);
  await h.run("add --raw First task");
  await h.run("add --raw Second task");
  assert.equal(listTasks(cwd).tasks.length, 2);
  await h.run("switch First task");
  assert.equal(h.status(), "Focus: First task");
  const before = current(cwd);
  await h.run("switch"); // cancelled select
  await h.run("edit --raw"); // cancelled editor
  await h.run("add"); // cancelled input
  assert.equal(current(cwd), before);
  h.ctx.ui.select = async (_title, options) => options.find(option => option.endsWith("Second task"));
  await h.run("switch");
  assert.equal(listTasks(cwd).active?.title, "Second task");
  h.ctx.ui.editor = async () => "# Edited\nNext: finish.\n";
  await h.run("edit --raw");
  assert.match(current(cwd), /Edited/);
  await h.run("list");
  assert.match(h.notices.at(-1)!, /\* .*\[open\] Second task/);
  await h.run("help");
  assert.match(h.notices.at(-1)!, /focus switch/);
  await h.run("done extra");
  assert.match(h.notices.at(-1)!, /does not accept/);
  await h.run("whoops");
  assert.match(h.notices.at(-1)!, /Unknown task action/);
  h.busy(true);
  await h.run("switch First task");
  assert.match(h.notices.at(-1)!, /Wait for Pi/);
  assert.equal(listTasks(cwd).active?.title, "Second task");
  h.busy(false);
  h.ctx.ui.select = async (_title, options) => { h.busy(true); return options[0]; };
  await h.run("switch");
  assert.match(h.notices.at(-1)!, /Wait for Pi/);
  assert.equal(listTasks(cwd).active?.title, "Second task");
  h.busy(false);
  h.ctx.ui.editor = async () => { h.busy(true); return "should not save"; };
  await h.run("edit --raw");
  assert.match(h.notices.at(-1)!, /Wait for Pi/);
  assert.doesNotMatch(current(cwd), /should not save/);
  h.busy(false);
  await h.run("done");
  assert.equal(listTasks(cwd).active, undefined);
  await h.run("switch Second task");
  await h.run("clear");
  assert.equal(listTasks(cwd).tasks.find(task => task.title === "Second task")?.status, "open");
});

test("context is fresh, bounded, isolated from other extensions and restored after compaction", async t => {
  const cwd = project(t);
  const h = harness(cwd);
  const sections = { another_extension: "keep me" };
  h.events.get("before_agent_start")!({ systemPromptOptions: { sections } }, h.ctx);
  assert.equal(sections.another_extension, "keep me");
  assert.match((sections as Record<string, string>).pi_focus_task, /task data/);
  await h.run("add --raw A");
  await h.run("switch A");
  saveCurrent(cwd, current(cwd) + "\nCheckpoint after tool call.\n</focus_task_context><evil>\n");
  const original: ContextEvent["messages"] = [{ role: "user", content: "Continue", timestamp: 1 }];
  const first = h.context(original).messages!;
  assert.equal(original.length, 1); // Does not mutate Pi's messages.
  assert.match(contextText(first), /Checkpoint after tool call/);
  assert.match(contextText(first), /&lt;evil&gt;/);
  assert.equal(h.context(first).messages!.length, 2); // No duplicate context.
  const compacted: ContextEvent["messages"] = [{ role: "compactionSummary", summary: "Older history", tokensBefore: 1000, timestamp: 2 }];
  assert.match(contextText(h.context(compacted).messages!), /Checkpoint after tool call/);
  const fresh = harness(cwd);
  fresh.events.get("session_start")!({}, fresh.ctx);
  assert.equal(fresh.status(), "Focus: A");
  assert.match(contextText(fresh.context().messages!), /Checkpoint after tool call/);
  await h.run("add --raw B");
  await h.run("switch B");
  assert.doesNotMatch(contextText(h.context(first).messages!), /Checkpoint after tool call/);
  saveCurrent(cwd, current(cwd) + "x".repeat(MAX_CONTEXT_BYTES));
  const warningsBefore = h.notices.length;
  assert.match(contextText(h.context().messages!), /context unavailable/);
  h.context();
  assert.equal(h.notices.length, warningsBefore + 1);
  assert.equal(h.status(), "Focus: unavailable");
  await h.run("clear");
  assert.match(contextText(h.context(first).messages!), /No active focus task/);
  assert.equal(h.status(), undefined);
});

test("real Pi CLI coexists with /task and persists focus lifecycle across processes", { timeout: 60_000 }, t => {
  const cwd = project(t);
  const agent = project(t);
  const cli = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const neighbor = join(agent, "other-extension.ts");
  writeFileSync(neighbor, `export default function (pi) {
    pi.registerCommand("task", { handler: async () => { process.stderr.write("OTHER_EXTENSION_TASK\\n"); } });
  }`);
  function command(text: string) {
    const result = spawnSync(process.execPath, [cli, "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "-e", repo, "-e", neighbor, "-p", text], {
      cwd, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    assert.equal(result.status, 0, result.stderr + String(result.error ?? ""));
    assert.doesNotMatch(result.stderr, /Failed to load extension/);
    return result.stderr;
  }
  assert.match(command("/task"), /OTHER_EXTENSION_TASK/);
  assert.match(command("/focus help"), /\/focus init/);
  assert.match(command("/focus init"), /Created FOCUS_TASK.md/);
  assert.equal(current(cwd), NO_TASK);
  const instructions = readFileSync(join(cwd, "AGENTS.md"), "utf8");
  assert.match(instructions, /read FOCUS_TASK.md/);
  assert.match(command("/focus init"), /Kept existing AGENTS.md/);
  assert.equal(readFileSync(join(cwd, "AGENTS.md"), "utf8"), instructions);
  assert.equal(existsSync(join(cwd, "CURRENT_TASK.md")), false);
  assert.match(command("/focus add Feature A"), /Added/);
  assert.match(command("/focus add เพิ่มฟีเจอร์ B"), /Added/);
  assert.equal(readdirSync(join(cwd, ".pi-focus-task")).filter(name => name.endsWith(".md")).length, 2);
  assert.match(command("/focus switch Feature A"), /Focused/);
  saveCurrent(cwd, current(cwd) + "\nRuntime handoff checkpoint.\n");
  assert.match(command("/focus switch เพิ่มฟีเจอร์ B"), /Focused/);
  assert.doesNotMatch(current(cwd), /Runtime handoff/);
  command("/focus switch Feature A");
  assert.match(current(cwd), /Runtime handoff checkpoint/);
  assert.match(command("/focus list"), /\* .*Feature A/);
  assert.match(command("/focus done"), /Completed/);
  assert.match(command("/focus list"), /\[done\] Feature A/);
  command("/focus switch Feature A");
  assert.match(command("/focus clear"), /Saved/);
  assert.equal(current(cwd), NO_TASK);
  assert.match(command("/focus switch"), /Usage: \/focus switch/);
  assert.match(command("/focus edit"), /Edit FOCUS_TASK.md directly/);
});

test("real provider requests retain focus after automatic compaction", { timeout: 30_000 }, async t => {
  const cwd = project(t);
  const agent = project(t);
  const task = addTask(cwd, "Runtime context");
  focusTask(cwd, task.id);
  saveCurrent(cwd, current(cwd) + "\nUnique handoff: verify purple otters.\n");
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) => ({
        id: `test-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "Test response." }, null))}\n\n`);
      response.write(`data: ${JSON.stringify({ ...chunk({}, "stop"), usage: { prompt_tokens: requests.length === 1 ? 3000 : 100, completion_tokens: 3, total_tokens: requests.length === 1 ? 3003 : 103 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: {
    "focus-test": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-test-only", models: [{ id: "test-model", contextWindow: 2048, maxTokens: 256 }] },
  } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({
    compaction: { enabled: true, reserveTokens: 256, keepRecentTokens: 0 },
    retry: { enabled: false },
  }));
  const cli = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const run = promisify(execFile)(process.execPath, [
    cli, "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools",
    "--session-dir", join(cwd, "sessions"), "-e", repo, "--provider", "focus-test", "--model", "test-model", "--mode", "json",
    "Old detail. ".repeat(600) + "Begin.", "Continue the focus task.",
  ], {
    cwd, timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
  });
  run.child.stdin?.end(); // Print/JSON mode waits for piped stdin to reach EOF.
  const { stdout, stderr } = await run;
  assert.doesNotMatch(stderr, /Failed to load extension/);
  const events = stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(events.some(event => event.type === "compaction_end" && event.result && !event.aborted), JSON.stringify({
    types: events.map(event => event.type), requests: requests.length, stderr,
    responses: events.filter(event => event.type === "message_end" && event.message.role === "assistant").map(event => event.message),
  }));
  assert.ok(requests.length >= 3, `Expected a normal call, compaction, and continuation, got ${requests.length}`);
  assert.match(requests[0], /verify purple otters/);
  assert.match(requests.at(-1)!, /verify purple otters/);
  assert.equal((requests.at(-1)!.match(/verify purple otters/g) ?? []).length, 1);
  assert.match(requests.at(-1)!, /pi_focus_task/);
  assert.equal(listTasks(cwd).active?.id, task.id);
  const transcript = readdirSync(join(cwd, "sessions")).map(name => readFileSync(join(cwd, "sessions", name), "utf8")).join("\n");
  assert.match(transcript, /"type":"compaction"/);
  assert.doesNotMatch(transcript, /verify purple otters/); // Ephemeral snapshots don't bloat saved history.

  async function author(text: string) {
    const command = promisify(execFile)(process.execPath, [
      cli, "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session",
      "-e", repo, "--provider", "focus-test", "--model", "test-model", "-p", text,
    ], { cwd, timeout: 10_000, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" } });
    command.child.stdin?.end();
    return (await command).stderr;
  }
  const callsBeforeRaw = requests.length;
  assert.match(await author("/focus add --raw Raw CLI task\n  exact spacing  \n"), /Added/);
  assert.equal(requests.length, callsBeforeRaw);
  assert.equal(listTasks(cwd).tasks.find(task => task.title === "Raw CLI task")?.body, "Raw CLI task\n  exact spacing  \n");
  assert.match(await author("/focus add --polish Rough CLI task"), /Added/);
  assert.equal(requests.length, callsBeforeRaw + 1);
  assert.equal(listTasks(cwd).tasks.find(task => task.title === "Rough CLI task")?.body, "Test response.");
  assert.match(requests.at(-1)!, /Rough CLI task/);
  assert.doesNotMatch(requests.at(-1)!, /purple otters|Old detail/); // No unrelated history sent to the polisher.
  assert.match(requests.at(-1)!, /Do not invent requirements/);
  assert.match(await author("/focus edit --polish"), /Updated FOCUS_TASK.md/);
  assert.equal(listTasks(cwd).active?.id, task.id);
  assert.equal(listTasks(cwd).active?.body, "Test response.");
});
