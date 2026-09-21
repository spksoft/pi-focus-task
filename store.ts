import { randomUUID } from "node:crypto";
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_CONTEXT_BYTES = 16 * 1024;
export const NO_TASK = "# Focus Task\n\nNo active task.\n";
const LEGACY_NO_TASK = "# Current Task\n\nNo active task.\n";
const AGENTS_RULE = "Before starting work, read FOCUS_TASK.md for the active scope and constraints.";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREFIX = "<!-- pi-focus-task: ";

export type Task = { id: string; title: string; status: "open" | "done"; body: string };

function paths(cwd: string) {
  const root = realpathSync(cwd);
  return { dir: join(root, ".pi-focus-task"), current: join(root, "FOCUS_TASK.md") };
}

function stat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function directory(path: string, create = false) {
  if (create && !stat(path)) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const info = stat(path);
  if (info && !info.isDirectory()) throw new Error(`Expected a real directory (not a symlink): ${path}`);
  return !!info;
}

function read(path: string): string | undefined {
  const info = stat(path);
  if (!info) return undefined;
  if (!info.isFile()) throw new Error(`Expected a regular file (not a symlink): ${path}`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`Task file exceeds 256 KiB: ${path}`);
  return readFileSync(path, "utf8");
}

function atomicWrite(path: string, text: string) {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error("Task file exceeds 256 KiB.");
  const info = stat(path);
  if (info && !info.isFile()) throw new Error(`Refusing to replace a non-regular file: ${path}`);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: info ? info.mode & 0o777 : 0o600 });
    renameSync(temp, path);
  } finally {
    if (stat(temp)) unlinkSync(temp);
  }
}

export function validateTitle(title: string) {
  const trimmed = title.trim();
  if (!trimmed || [...trimmed].length > 200 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trimmed)) {
    throw new Error("Use a one-line task title of 1–200 characters without control characters.");
  }
  return trimmed;
}

function encode(task: Task) {
  const { id, title, status } = task;
  return `${PREFIX}${JSON.stringify({ id, title, status })} -->\n${task.body}`;
}

function decode(text: string, path: string): Task | undefined {
  if (!text.startsWith("<!-- pi-focus-task")) return undefined;
  const newline = text.indexOf("\n");
  const header = (newline < 0 ? text : text.slice(0, newline)).trimEnd();
  try {
    if (!header.startsWith(PREFIX) || !header.endsWith(" -->")) throw new Error();
    const data = JSON.parse(header.slice(PREFIX.length, -4));
    if (!data || typeof data.id !== "string" || !ID.test(data.id) ||
        typeof data.title !== "string" || validateTitle(data.title) !== data.title ||
        !["open", "done"].includes(data.status)) throw new Error();
    return { id: data.id, title: data.title, status: data.status, body: newline < 0 ? "" : text.slice(newline + 1) };
  } catch {
    throw new Error(`Invalid pi-focus-task metadata; restore the first-line comment in ${path}`);
  }
}

function taskPath(dir: string, id: string) {
  if (!ID.test(id)) throw new Error("Invalid task ID.");
  return join(dir, `${id}.md`);
}

function readCurrent(current: string) {
  const text = read(current);
  if (text === undefined && stat(join(dirname(current), "CURRENT_TASK.md"))) {
    throw new Error("Found CURRENT_TASK.md. Run /focus init to migrate its context to FOCUS_TASK.md first.");
  }
  const task = text === undefined ? undefined : decode(text, current);
  if (task?.status === "done") throw new Error("FOCUS_TASK.md is marked done. Restore its status to open before switching.");
  return { text, task };
}

function locked<T>(cwd: string, action: (dir: string, current: string) => T): T {
  const { dir, current } = paths(cwd);
  directory(dir, true);
  const lock = join(dir, ".lock");
  try { mkdirSync(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Another task operation is running. If it crashed, remove ${lock} after all Pi sessions are idle.`);
    }
    throw error;
  }
  try { return action(dir, current); }
  finally { rmdirSync(lock); }
}

export function initProject(cwd: string) {
  return locked(cwd, (_dir, current) => {
    const agentsPath = join(dirname(current), "AGENTS.md");
    const agents = read(agentsPath);
    let instructions = (agents ?? "").replaceAll("CURRENT_TASK.md", "FOCUS_TASK.md");
    if (!instructions.includes(AGENTS_RULE)) {
      const separator = instructions ? (instructions.endsWith("\n") ? "\n" : "\n\n") : "";
      instructions += `${separator}## Focus task context\n\n${AGENTS_RULE}\n`;
    }
    const existing = read(current);
    const legacy = existing === undefined ? read(join(dirname(current), "CURRENT_TASK.md")) : undefined;
    // Validate both targets before writing; rerunning init can finish an interrupted setup.
    if (Buffer.byteLength(instructions) > MAX_FILE_BYTES) throw new Error("AGENTS.md would exceed 256 KiB; shorten it before initialization.");
    if (existing === undefined) atomicWrite(current, legacy ?? NO_TASK);
    if (instructions !== agents) atomicWrite(agentsPath, instructions);
    return { migrated: legacy !== undefined, created: existing === undefined, agentsUpdated: instructions !== agents };
  });
}

export function listTasks(cwd: string): { tasks: Task[]; active?: Task } {
  const { dir, current } = paths(cwd);
  const exists = directory(dir);
  if (exists && stat(join(dir, ".lock"))) throw new Error("A task operation is in progress; try again shortly.");
  const { task: active } = readCurrent(current);
  // ponytail: scan small local task lists; add an index only if thousands of tasks make this slow.
  const tasks = exists ? readdirSync(dir).filter(name => ID.test(name.slice(0, -3)) && name.endsWith(".md")).map(name => {
    const path = join(dir, name);
    const task = decode(read(path) ?? "", path);
    if (!task || `${task.id}.md` !== name) throw new Error(`Invalid task file: ${path}`);
    return task;
  }) : [];
  if (active) {
    const index = tasks.findIndex(task => task.id === active.id);
    if (index < 0) tasks.push(active);
    else tasks[index] = active; // FOCUS_TASK.md is authoritative while focused.
  }
  tasks.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return { tasks, active };
}

export function addTask(cwd: string, title: string, body?: string): Task {
  title = validateTitle(title);
  return locked(cwd, dir => {
    const task: Task = {
      id: randomUUID(), title, status: "open",
      body: body ?? `# ${title}\n\n## Objective\n${title}\n\n## Scope and constraints\n\n## Decisions\n\n## Progress and validation\n\n## Blockers\n\n## Next step\n`,
    };
    const text = encode(task);
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error("Task file exceeds 256 KiB.");
    writeFileSync(taskPath(dir, task.id), text, { flag: "wx", mode: 0o600 });
    return task;
  });
}

export function findTask(tasks: Task[], query: string): Task {
  query = query.trim();
  if (!query) throw new Error("Specify a task ID, unique ID prefix, or exact title.");
  const matches = tasks.filter(task => task.id.startsWith(query.toLowerCase()) || task.title.toLowerCase() === query.toLowerCase());
  if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous task; use a longer ID prefix." : "Task not found. Use /focus list to see task IDs.");
  return matches[0];
}

function preserve(dir: string, text: string | undefined, task: Task | undefined) {
  if (task) atomicWrite(taskPath(dir, task.id), encode(task));
  else if (text?.trim() && text !== NO_TASK) {
    const backups = join(dir, "backups");
    directory(backups, true);
    const path = join(backups, `${randomUUID()}.md`);
    writeFileSync(path, text, { flag: "wx", mode: 0o600 });
    return path;
  }
  return undefined;
}

export function focusTask(cwd: string, id: string): { task: Task; backup?: string } {
  return locked(cwd, (dir, current) => {
    const { text, task: previous } = readCurrent(current);
    if (previous?.id === id) return { task: previous };
    const path = taskPath(dir, id);
    const task = decode(read(path) ?? "", path);
    if (!task || task.id !== id) throw new Error(`Task not found or invalid: ${id}`);
    task.status = "open"; // Explicitly focusing a completed task reopens it.
    const backup = preserve(dir, text, previous);
    // Saving outgoing context first makes this single atomic replacement the focus commit.
    atomicWrite(current, encode(task));
    return { task, backup };
  });
}

export function clearTask(cwd: string, done = false): Task | undefined {
  return locked(cwd, (dir, current) => {
    const { task } = readCurrent(current);
    if (!task) {
      if (done) throw new Error("No managed focus task. Use /focus switch first.");
      return undefined; // Never clear an unowned FOCUS_TASK.md.
    }
    preserve(dir, undefined, { ...task, status: done ? "done" : "open" });
    atomicWrite(current, NO_TASK);
    return task;
  });
}

export function editTask(cwd: string, expected: Task, body: string) {
  return locked(cwd, (_dir, current) => {
    const { task } = readCurrent(current);
    if (!task || encode(task) !== encode(expected)) throw new Error("Focus or task contents changed while editing. Reopen /focus edit; no changes were overwritten.");
    atomicWrite(current, encode({ ...task, body }));
  });
}

export function taskContext(cwd: string): { task?: Task; body?: string } {
  const { dir, current } = paths(cwd);
  if (directory(dir) && stat(join(dir, ".lock"))) throw new Error("A task operation is in progress; context was not loaded.");
  const { text, task } = readCurrent(current);
  // Also support the original hand-written FOCUS_TASK.md workflow without importing it.
  const body = task?.body ?? text;
  if (!task && (!body?.trim() || body === NO_TASK || body === LEGACY_NO_TASK || /^## Status\s*\r?\nNo active task\.\s*$/m.test(body))) return {};
  if (body === undefined) return {};
  if (Buffer.byteLength(body) > MAX_CONTEXT_BYTES) throw new Error("FOCUS_TASK.md exceeds the 16 KiB context limit. Shorten it; the file has not been changed.");
  return { task, body };
}
