import { randomUUID } from "node:crypto";
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_CONTEXT_BYTES = 16 * 1024;
const OLD_NO_TASK = "# Focus Task\n\nNo active task.\n";
const LEGACY_NO_TASK = "# Current Task\n\nNo active task.\n";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREFIX = "<!-- pi-focus-task: ";
const ACTIVE = ".active";

export type Task = { id: string; title: string; body: string };
type TaskInfo = Omit<Task, "body">;
type LegacyTask = Task & { status?: "open" | "done" };

function paths(cwd: string) {
  const root = realpathSync(cwd);
  const dir = join(root, ".pi-focus-task");
  return { dir, active: join(dir, ACTIVE) };
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

function taskInfo(data: unknown): TaskInfo {
  if (!data || typeof data !== "object") throw new Error();
  const { id, title, status } = data as Partial<LegacyTask>;
  if (typeof id !== "string" || !ID.test(id) || typeof title !== "string" ||
      validateTitle(title) !== title || (status !== undefined && status !== "open" && status !== "done")) throw new Error();
  return { id, title };
}

function encode(task: Task) {
  const { id, title } = task;
  return `${PREFIX}${JSON.stringify({ id, title })} -->\n${task.body}`;
}

function decode(text: string, path: string): LegacyTask | undefined {
  if (!text.startsWith("<!-- pi-focus-task")) return undefined;
  const newline = text.indexOf("\n");
  const header = (newline < 0 ? text : text.slice(0, newline)).trimEnd();
  try {
    if (!header.startsWith(PREFIX) || !header.endsWith(" -->")) throw new Error();
    const data = JSON.parse(header.slice(PREFIX.length, -4));
    return { ...taskInfo(data), body: newline < 0 ? "" : text.slice(newline + 1), status: data.status };
  } catch {
    throw new Error(`Invalid pi-focus-task metadata: ${path}`);
  }
}

function taskPath(dir: string, id: string) {
  if (!ID.test(id)) throw new Error("Invalid task ID.");
  return join(dir, `${id}.md`);
}

function readActive(path: string): TaskInfo | undefined {
  const text = read(path);
  if (text === undefined) return undefined;
  try { return taskInfo(JSON.parse(text)); }
  catch { throw new Error(`Invalid active-task marker: ${path}`); }
}

function writeActive(path: string, task: Task) {
  atomicWrite(path, `${JSON.stringify(taskInfo(task))}\n`);
}

function clearActive(path: string) {
  const info = stat(path);
  if (!info) return;
  if (!info.isFile()) throw new Error(`Expected a regular file (not a symlink): ${path}`);
  unlinkSync(path);
}

function noTask(text: string | undefined) {
  return text === undefined || !text.trim() || text === OLD_NO_TASK || text === LEGACY_NO_TASK;
}

function readFocused(dir: string, activePath: string): Task | undefined {
  const active = readActive(activePath);
  if (!active) return undefined;
  const path = taskPath(dir, active.id);
  const saved = decode(read(path) ?? "", path);
  if (!saved || saved.id !== active.id || saved.title !== active.title) throw new Error(`Invalid focused task: ${path}`);
  return { id: saved.id, title: saved.title, body: saved.body };
}

export function focusedBrief(cwd: string): { path: string; content: string } | undefined {
  const { dir, active } = paths(cwd);
  if (!directory(dir)) return undefined;
  requireMigration(dir);
  const task = readFocused(dir, active);
  if (!task?.body.trim()) return undefined;
  if (Buffer.byteLength(task.body) > MAX_CONTEXT_BYTES) throw new Error("Focused brief exceeds 16 KiB; shorten it before using it as model context.");
  return { path: taskPath(dir, task.id), content: task.body };
}

function locked<T>(cwd: string, action: (dir: string, active: string) => T): T {
  const { dir, active } = paths(cwd);
  directory(dir, true);
  const lock = join(dir, ".lock");
  try { mkdirSync(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Another task operation is running. If it crashed, remove ${lock} after all Pi sessions are idle.`);
    }
    throw error;
  }
  try { return action(dir, active); }
  finally { rmdirSync(lock); }
}

function ignoreTasks(root: string) {
  const path = join(root, ".gitignore");
  const contents = read(path) ?? "";
  if (contents.split(/\r?\n/).some(line => line === ".pi-focus-task/" || line === "/.pi-focus-task/")) return;
  atomicWrite(path, `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}.pi-focus-task/\n`);
}

export function initProject(cwd: string) {
  return locked(cwd, (dir, active) => {
    const root = dirname(dir);
    ignoreTasks(root);
    const old = join(root, "FOCUS_TASK.md");
    const source = read(old) ?? read(join(root, "CURRENT_TASK.md"));
    const activeTask = readFocused(dir, active);
    if (noTask(source) || read(join(dir, ".migrated")) !== undefined) return { migrated: false, legacy: !!source?.trim() };
    const legacy = decode(source!, read(old) !== undefined ? old : join(root, "CURRENT_TASK.md"));
    if (activeTask && legacy?.id && legacy.id !== activeTask.id) throw new Error("Legacy brief belongs to another task; resolve it manually before migrating.");
    const task = activeTask ? { ...activeTask, body: legacy?.body ?? source! }
      : legacy && legacy.status !== "done" ? { id: legacy.id, title: legacy.title, body: legacy.body }
      : legacy ? undefined : { id: randomUUID(), title: validateTitle(source!.trimStart().split(/\r?\n/, 1)[0].replace(/^#{1,6}\s+/, "").slice(0, 200)), body: source! };
    if (task) {
      const path = taskPath(dir, task.id);
      if (!activeTask && read(path) !== undefined) throw new Error(`Task ${task.id} already exists; resolve the legacy file manually before migrating.`);
      atomicWrite(path, encode(task));
      writeActive(active, task);
    }
    atomicWrite(join(dir, ".migrated"), "Migrated legacy focus; remove its tracked file manually.\n");
    return { migrated: !!task, legacy: true }; // Leave tracked legacy files for the user to remove explicitly.
  });
}

export function listTasks(cwd: string): { tasks: Task[]; active?: Task } {
  const { dir, active: activePath } = paths(cwd);
  const exists = directory(dir);
  if (exists && stat(join(dir, ".lock"))) throw new Error("A task operation is in progress; try again shortly.");
  const active = exists ? readFocused(dir, activePath) : undefined;
  // ponytail: scan small local task lists; add an index only if thousands of tasks make this slow.
  const tasks = exists ? readdirSync(dir).filter(name => ID.test(name.slice(0, -3)) && name.endsWith(".md")).map(name => {
    const path = join(dir, name);
    const task = decode(read(path) ?? "", path);
    if (!task || `${task.id}.md` !== name) throw new Error(`Invalid task file: ${path}`);
    return { id: task.id, title: task.title, body: task.body };
  }) : [];
  tasks.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return { tasks, active };
}

export function addTask(cwd: string, title: string, body?: string): Task {
  title = validateTitle(title);
  return locked(cwd, dir => {
    ignoreTasks(dirname(dir));
    const task: Task = {
      id: randomUUID(), title,
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

function requireMigration(dir: string) {
  if (read(join(dir, ".migrated")) !== undefined) return;
  const root = dirname(dir);
  if (!noTask(read(join(root, "FOCUS_TASK.md")) ?? read(join(root, "CURRENT_TASK.md")))) {
    throw new Error("Legacy task brief found. Run /focus init before changing focus to preserve its contents.");
  }
}

export function focusTask(cwd: string, id: string): { task: Task } {
  return locked(cwd, (dir, activePath) => {
    requireMigration(dir);
    const previous = readFocused(dir, activePath);
    if (previous?.id === id) return { task: previous };
    const path = taskPath(dir, id);
    const saved = decode(read(path) ?? "", path);
    if (!saved || saved.id !== id) throw new Error(`Task not found or invalid: ${id}`);
    const task: Task = { id: saved.id, title: saved.title, body: saved.body };
    writeActive(activePath, task);
    return { task };
  });
}

export function clearFocus(cwd: string) {
  locked(cwd, (dir, activePath) => {
    requireMigration(dir);
    readFocused(dir, activePath);
    clearActive(activePath);
  });
}

export function deleteTask(cwd: string, id: string): Task {
  return locked(cwd, (dir, activePath) => {
    requireMigration(dir);
    const active = readFocused(dir, activePath);
    const path = taskPath(dir, id);
    const saved = decode(read(path) ?? "", path);
    if (!saved || saved.id !== id) throw new Error(`Task not found or invalid: ${id}`);
    const task: Task = { id: saved.id, title: saved.title, body: saved.body };
    if (active?.id === id) clearActive(activePath);
    unlinkSync(path);
    return task;
  });
}

export function editTask(cwd: string, expected: Task, body: string) {
  return locked(cwd, (dir, activePath) => {
    requireMigration(dir);
    const task = readFocused(dir, activePath);
    if (!task || task.id !== expected.id || task.body !== expected.body) {
      throw new Error("Focus or task contents changed while editing. Reopen /focus edit; no changes were overwritten.");
    }
    atomicWrite(taskPath(dir, task.id), encode({ ...task, body }));
  });
}
