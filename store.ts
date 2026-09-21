import { randomUUID } from "node:crypto";
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_CONTEXT_BYTES = 16 * 1024;
export const NO_TASK = "";
const OLD_NO_TASK = "# Focus Task\n\nNo active task.\n";
const LEGACY_NO_TASK = "# Current Task\n\nNo active task.\n";
const AGENTS_RULE = "Before starting work, read FOCUS_TASK.md for the active scope and constraints.";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREFIX = "<!-- pi-focus-task: ";
const ACTIVE = ".active";

export type Task = { id: string; title: string; status: "open" | "done"; body: string };
type TaskInfo = Omit<Task, "body">;

function paths(cwd: string) {
  const root = realpathSync(cwd);
  const dir = join(root, ".pi-focus-task");
  return { dir, current: join(root, "FOCUS_TASK.md"), active: join(dir, ACTIVE) };
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
  const { id, title, status } = data as Partial<TaskInfo>;
  if (typeof id !== "string" || !ID.test(id) || typeof title !== "string" ||
      validateTitle(title) !== title || (status !== "open" && status !== "done")) throw new Error();
  return { id, title, status };
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
    return { ...taskInfo(JSON.parse(header.slice(PREFIX.length, -4))), body: newline < 0 ? "" : text.slice(newline + 1) };
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

function readCurrent(dir: string, current: string, activePath: string) {
  const text = read(current);
  if (text === undefined && stat(join(dirname(current), "CURRENT_TASK.md"))) {
    throw new Error("Found CURRENT_TASK.md. Run /focus init to migrate its context to FOCUS_TASK.md first.");
  }
  if (noTask(text)) return { text, task: undefined };
  if (text!.startsWith("<!-- pi-focus-task")) {
    throw new Error("FOCUS_TASK.md still has old task metadata. Run /focus init to move it into .pi-focus-task/.");
  }
  const active = readActive(activePath);
  if (!active) return { text, task: undefined };
  if (active.status === "done") throw new Error("The active-task marker is marked done. Run /focus init to repair it.");
  return { text, task: { ...active, body: text! } };
}

function locked<T>(cwd: string, action: (dir: string, current: string, active: string) => T): T {
  const { dir, current, active } = paths(cwd);
  directory(dir, true);
  const lock = join(dir, ".lock");
  try { mkdirSync(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Another task operation is running. If it crashed, remove ${lock} after all Pi sessions are idle.`);
    }
    throw error;
  }
  try { return action(dir, current, active); }
  finally { rmdirSync(lock); }
}

export function initProject(cwd: string) {
  return locked(cwd, (dir, current, active) => {
    const agentsPath = join(dirname(current), "AGENTS.md");
    const agents = read(agentsPath);
    let instructions = (agents ?? "").replaceAll("CURRENT_TASK.md", "FOCUS_TASK.md");
    if (!instructions.includes(AGENTS_RULE)) {
      const separator = instructions ? (instructions.endsWith("\n") ? "\n" : "\n\n") : "";
      instructions += `${separator}## Focus task context\n\n${AGENTS_RULE}\n`;
    }
    const existing = read(current);
    const legacy = existing === undefined ? read(join(dirname(current), "CURRENT_TASK.md")) : undefined;
    const source = existing ?? legacy;
    const sourcePath = existing === undefined && legacy !== undefined ? join(dirname(current), "CURRENT_TASK.md") : current;
    const oldTask = source === undefined ? undefined : decode(source, sourcePath);
    if (Buffer.byteLength(instructions) > MAX_FILE_BYTES) throw new Error("AGENTS.md would exceed 256 KiB; shorten it before initialization.");

    if (oldTask) {
      atomicWrite(taskPath(dir, oldTask.id), encode(oldTask));
      if (oldTask.status === "open") {
        atomicWrite(current, oldTask.body);
        writeActive(active, oldTask);
      } else {
        atomicWrite(current, NO_TASK);
        clearActive(active);
      }
    } else {
      const body = noTask(source) ? NO_TASK : source!;
      if (existing === undefined || body !== existing) atomicWrite(current, body);
      if (noTask(body)) clearActive(active);
    }
    if (instructions !== agents) atomicWrite(agentsPath, instructions);
    return { migrated: legacy !== undefined, created: existing === undefined, agentsUpdated: instructions !== agents };
  });
}

export function listTasks(cwd: string): { tasks: Task[]; active?: Task } {
  const { dir, current, active: activePath } = paths(cwd);
  const exists = directory(dir);
  if (exists && stat(join(dir, ".lock"))) throw new Error("A task operation is in progress; try again shortly.");
  const { task: active } = readCurrent(dir, current, activePath);
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
  else if (text?.trim()) {
    const backups = join(dir, "backups");
    directory(backups, true);
    const path = join(backups, `${randomUUID()}.md`);
    writeFileSync(path, text, { flag: "wx", mode: 0o600 });
    return path;
  }
  return undefined;
}

export function focusTask(cwd: string, id: string): { task: Task; backup?: string } {
  return locked(cwd, (dir, current, activePath) => {
    const { text, task: previous } = readCurrent(dir, current, activePath);
    if (previous?.id === id) return { task: previous };
    const path = taskPath(dir, id);
    const task = decode(read(path) ?? "", path);
    if (!task || task.id !== id) throw new Error(`Task not found or invalid: ${id}`);
    task.status = "open"; // Explicitly focusing a completed task reopens it.
    const backup = preserve(dir, text, previous);
    atomicWrite(current, task.body);
    writeActive(activePath, task);
    return { task, backup };
  });
}

export function clearTask(cwd: string, done = false): Task | undefined {
  return locked(cwd, (dir, current, activePath) => {
    const { text, task } = readCurrent(dir, current, activePath);
    if (!task) {
      if (done) throw new Error("No managed focus task. Use /focus switch first.");
      if (noTask(text)) clearActive(activePath);
      return undefined; // Never clear an unowned FOCUS_TASK.md.
    }
    preserve(dir, undefined, { ...task, status: done ? "done" : "open" });
    atomicWrite(current, NO_TASK);
    clearActive(activePath);
    return task;
  });
}

export function editTask(cwd: string, expected: Task, body: string) {
  return locked(cwd, (dir, current, activePath) => {
    const { text, task } = readCurrent(dir, current, activePath);
    if (!task || task.id !== expected.id || text !== expected.body) {
      throw new Error("Focus or task contents changed while editing. Reopen /focus edit; no changes were overwritten.");
    }
    atomicWrite(current, body);
  });
}

export function taskContext(cwd: string): { task?: Task; body?: string } {
  const { dir, current, active } = paths(cwd);
  if (directory(dir) && stat(join(dir, ".lock"))) throw new Error("A task operation is in progress; context was not loaded.");
  const { text, task } = readCurrent(dir, current, active);
  if (noTask(text)) return {};
  if (Buffer.byteLength(text!) > MAX_CONTEXT_BYTES) throw new Error("FOCUS_TASK.md exceeds the 16 KiB context limit. Shorten it; the file has not been changed.");
  return { task, body: text! };
}
