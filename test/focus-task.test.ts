import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { addTask, clearFocus, deleteTask, editTask, focusTask, focusedBrief, initProject, listTasks, MAX_CONTEXT_BYTES } from "../store.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function project(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-focus-task-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}
function harness(cwd: string) {
  const events = new Map<string, (...args: any[]) => any>();
  let command: Omit<RegisteredCommand, "name" | "sourceInfo">;
  const notices: string[] = [];
  const ctx = { cwd, hasUI: false, mode: "print", isIdle: () => true, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
  extension({ on: (event: string, handler: (...args: any[]) => any) => { events.set(event, handler); }, registerCommand: (_name: string, options: typeof command) => { command = options; } } as unknown as ExtensionAPI);
  const context = () => {
    const systemPromptOptions = { sections: {} as Record<string, string>, contextFiles: [{ path: join(cwd, "AGENTS.md"), content: "Project rules" }] };
    events.get("before_agent_start")!({ systemPromptOptions }, ctx);
    return systemPromptOptions;
  };
  return { ctx, events, notices, run: (args: string) => command.handler(args, ctx), context, prompt: () => context().contextFiles[1]?.content };
}

test("private focus lifecycle, direct edits, and Pi project context", async t => {
  const cwd = project(t);
  const h = harness(cwd);
  assert.equal(h.prompt(), undefined);
  assert.deepEqual(initProject(cwd), { migrated: false, legacy: false });
  assert.equal(existsSync(join(cwd, "FOCUS_TASK.md")), false);
  assert.equal(existsSync(join(cwd, "AGENTS.md")), false);
  const a = addTask(cwd, "A", "# A\nDo not publish this.");
  const b = addTask(cwd, "B", "# B\nOther context.");
  focusTask(cwd, a.id);
  assert.deepEqual(h.context().contextFiles, [
    { path: join(cwd, "AGENTS.md"), content: "Project rules" },
    { path: join(realpathSync(cwd), ".pi-focus-task", `${a.id}.md`), content: a.body },
  ]);
  assert.equal(h.context().sections.focus_task, undefined);
  assert.equal(h.prompt(), a.body);
  const file = join(cwd, ".pi-focus-task", `${a.id}.md`);
  writeFileSync(file, readFileSync(file, "utf8") + "\nNext: implement.\n");
  assert.match(h.prompt()!, /Next: implement/);
  const snapshot = listTasks(cwd).active!;
  focusTask(cwd, b.id);
  assert.equal(h.prompt(), b.body);
  assert.throws(() => editTask(cwd, snapshot, "stale"), /changed while editing/);
  focusTask(cwd, a.id);
  assert.match(h.prompt()!, /Next: implement/);
  editTask(cwd, listTasks(cwd).active!, "Updated private brief");
  assert.equal(h.prompt(), "Updated private brief");
  clearFocus(cwd);
  assert.equal(h.prompt(), undefined);
  assert.equal(listTasks(cwd).tasks.length, 2);
  focusTask(cwd, a.id);
  deleteTask(cwd, a.id);
  assert.equal(h.prompt(), undefined);
  assert.equal(listTasks(cwd).tasks.length, 1);
  await h.run("switch B");
  assert.equal(h.prompt(), b.body);
  assert.equal(existsSync(join(cwd, "FOCUS_TASK.md")), false);
});

test("raw authoring preserves text without a model call; opt-in polish updates the private brief", async t => {
  const cwd = project(t);
  const h = harness(cwd);
  let calls = 0;
  h.ctx.model = { provider: "stub", id: "polisher" } as NonNullable<typeof h.ctx.model>;
  h.ctx.modelRegistry = { complete: async () => {
    calls++;
    return { stopReason: "stop", content: [{ type: "text", text: "Polished brief" }] };
  } } as unknown as typeof h.ctx.modelRegistry;
  await h.run("add --raw Private\n  keep spacing  \n");
  assert.equal(listTasks(cwd).tasks[0].body, "Private\n  keep spacing  \n");
  assert.equal(calls, 0);
  await h.run("switch Private");
  await h.run("edit --raw Updated\n  exact  \n");
  assert.equal(h.prompt(), "Updated\n  exact  \n");
  assert.equal(calls, 0);
  await h.run("edit --polish Rough revision");
  assert.equal(h.prompt(), "Polished brief");
  assert.equal(calls, 1);
});

test("init migrates a legacy brief without changing or deleting tracked project files", t => {
  const cwd = project(t);
  writeFileSync(join(cwd, "AGENTS.md"), "Project rules\nRead FOCUS_TASK.md\n");
  writeFileSync(join(cwd, "FOCUS_TASK.md"), "# Old work\nKeep decisions.\n");
  assert.deepEqual(initProject(cwd), { migrated: true, legacy: true });
  assert.equal(focusedBrief(cwd)?.content, "# Old work\nKeep decisions.\n");
  assert.deepEqual(initProject(cwd), { migrated: false, legacy: true });
  assert.equal(readFileSync(join(cwd, "FOCUS_TASK.md"), "utf8"), "# Old work\nKeep decisions.\n");
  assert.equal(readFileSync(join(cwd, "AGENTS.md"), "utf8"), "Project rules\nRead FOCUS_TASK.md\n");
});

test("legacy focused edits migrate once without overwriting later private edits", t => {
  const cwd = project(t);
  const task = addTask(cwd, "Previous", "Saved old copy");
  focusTask(cwd, task.id);
  writeFileSync(join(cwd, "FOCUS_TASK.md"), "# Previous\nUnsaved checkpoint");
  assert.throws(() => clearFocus(cwd), /Run \/focus init/);
  assert.equal(initProject(cwd).migrated, true);
  assert.equal(focusedBrief(cwd)?.content, "# Previous\nUnsaved checkpoint");
  editTask(cwd, listTasks(cwd).active!, "New private progress");
  assert.equal(initProject(cwd).migrated, false);
  assert.equal(focusedBrief(cwd)?.content, "New private progress");
});

test("project .gitignore protects task files without editing AGENTS.md", t => {
  const cwd = project(t);
  const git = (...args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  writeFileSync(join(cwd, ".gitignore"), "node_modules/\r\n");
  addTask(cwd, "Private", "Local only");
  assert.equal(readFileSync(join(cwd, ".gitignore"), "utf8"), "node_modules/\r\n.pi-focus-task/\n");
  initProject(cwd);
  assert.equal(readFileSync(join(cwd, ".gitignore"), "utf8"), "node_modules/\r\n.pi-focus-task/\n");
  assert.equal(git("status", "--short", "--untracked-files=all").stdout, "?? .gitignore\n");
  assert.equal(existsSync(join(cwd, "AGENTS.md")), false);
});

test("init creates .gitignore if absent and refuses a symlink without saving a task", t => {
  const cwd = project(t);
  initProject(cwd);
  assert.equal(readFileSync(join(cwd, ".gitignore"), "utf8"), ".pi-focus-task/\n");
  const other = project(t);
  const outside = join(other, "outside");
  writeFileSync(outside, "untouched");
  symlinkSync(outside, join(other, ".gitignore"));
  assert.throws(() => addTask(other, "Private"), /regular file/);
  assert.equal(readFileSync(outside, "utf8"), "untouched");
  assert.deepEqual(listTasks(other).tasks, []);
});

test("invalid active markers, symlinks, and oversized briefs never enter model context", t => {
  const cwd = project(t);
  const h = harness(cwd);
  const a = addTask(cwd, "A", "okay");
  focusTask(cwd, a.id);
  const file = join(cwd, ".pi-focus-task", `${a.id}.md`);
  writeFileSync(file, readFileSync(file, "utf8") + "x".repeat(MAX_CONTEXT_BYTES));
  assert.equal(h.prompt(), undefined);
  writeFileSync(join(cwd, ".pi-focus-task", ".active"), '{"id":"../bad"}');
  assert.equal(h.prompt(), undefined);
  assert.throws(() => listTasks(cwd), /Invalid active-task marker/);
  const other = project(t);
  symlinkSync(join(cwd, ".pi-focus-task"), join(other, ".pi-focus-task"));
  assert.throws(() => focusedBrief(other), /real directory/);
});

test("real Pi places AGENTS.md then focus in one project context through compaction", { timeout: 30_000 }, async t => {
  const cwd = project(t);
  const agent = project(t);
  const task = addTask(cwd, "Runtime", "Unique handoff: purple otters.");
  focusTask(cwd, task.id);
  writeFileSync(join(cwd, "AGENTS.md"), "Unique project guidance: blue herons.\n");
  const requests: any[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) => ({ id: "test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason: finish }] });
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
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { "focus-test": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-test-only", models: [{ id: "test-model", contextWindow: 2048, maxTokens: 256 }] } } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 256, keepRecentTokens: 0 }, retry: { enabled: false } }));
  const cli = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const run = promisify(execFile)(process.execPath, [cli, "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-tools", "--session-dir", join(cwd, "sessions"), "-e", repo, "--provider", "focus-test", "--model", "test-model", "--mode", "json", "Old detail. ".repeat(600) + "Begin.", "Continue."], { cwd, timeout: 20_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" } });
  run.child.stdin?.end();
  const { stdout, stderr } = await run;
  assert.doesNotMatch(stderr, /Failed to load extension/);
  assert.match(stdout, /"type":"compaction_end"/);
  assert.ok(requests.length >= 3);
  const agentRequests = requests.filter(request => !request.messages[0].content.includes("context summarization assistant"));
  assert.ok(agentRequests.length >= 2);
  for (const request of agentRequests) {
    const system = request.messages[0].content as string;
    assert.match(system, /<project_context>[\s\S]*blue herons[\s\S]*purple otters[\s\S]*<\/project_context>/);
    assert.doesNotMatch(system, /<focus_task>/);
    assert.equal(request.messages.filter((message: any) => message.content?.includes?.("purple otters")).length, 1);
    assert.equal(request.messages[0].role, "system");
  }
  assert.equal(existsSync(join(cwd, "FOCUS_TASK.md")), false);
  assert.equal(readFileSync(join(cwd, "AGENTS.md"), "utf8"), "Unique project guidance: blue herons.\n");
  assert.ok(readdirSync(join(cwd, ".pi-focus-task")).includes(".active"));
});
