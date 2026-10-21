#!/usr/bin/env node
// Deterministic provider process for disposable full-product verification only.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodePath from "node:path";
const root = process.env.B3R_LOCAL_PRODUCT_ROOT;
if (!root?.startsWith("/tmp/b3r-local-product-"))
  throw new Error("Disposable fixture root required");
const journal = NodePath.join(root, "provider-requests.ndjson");
const statePath = NodePath.join(root, "provider-state.json");
const load = () =>
  NodeFS.existsSync(statePath)
    ? JSON.parse(NodeFS.readFileSync(statePath, "utf8"))
    : { threads: {}, threadCounter: 0, turnCounter: 0 };
const save = (state) => NodeFS.writeFileSync(statePath, JSON.stringify(state));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method, params) => send({ method, params });
const version = "0.114.0";
if (process.argv.includes("--version")) {
  console.log(`codex-cli ${version}`);
  process.exit(0);
}
if (!process.argv.includes("app-server")) {
  console.error("Fixture supports only app-server and --version");
  process.exit(2);
}
const session = (thread, params = {}) => ({
  thread,
  model: params.model ?? thread.model,
  modelProvider: "local-fixture",
  cwd: thread.cwd,
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: { type: "workspaceWrite", networkAccess: false },
  reasoningEffort: "medium",
});
const complete = (threadId, turnId, status = "completed") => {
  const state = load();
  const thread = state.threads[threadId];
  const turn = thread.turns.find((v) => v.id === turnId);
  if (turn.status !== "inProgress") return;
  const text = `LOCAL fixture result ${turnId}: ${turn.input}`;
  const item = {
    type: "agentMessage",
    id: `answer-${turnId}`,
    text,
    phase: "final_answer",
    memoryCitation: null,
  };
  if (status === "completed") {
    notify("item/started", {
      threadId,
      turnId,
      startedAtMs: Date.now(),
      item: { ...item, text: "" },
    });
    notify("item/agentMessage/delta", { threadId, turnId, itemId: item.id, delta: text });
    notify("item/completed", { threadId, turnId, completedAtMs: Date.now(), item });
    turn.items = [item];
  }
  turn.status = status;
  turn.completedAt = Math.floor(Date.now() / 1000);
  thread.status = { type: "idle" };
  thread.updatedAt = Math.floor(Date.now() / 1000);
  save(state);
  NodeFS.appendFileSync(
    journal,
    JSON.stringify({ event: "terminal", threadId, turnId, status }) + "\n",
  );
  notify("turn/completed", { threadId, turn: { ...turn, input: undefined } });
};
NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (!m.method || m.id === undefined) return;
  NodeFS.appendFileSync(
    journal,
    JSON.stringify({ event: "request", method: m.method, params: m.params, pid: process.pid }) +
      "\n",
  );
  const p = m.params ?? {};
  const state = load();
  let result;
  switch (m.method) {
    case "initialize":
      result = {
        userAgent: `local-product-fixture/${version}`,
        codexHome: process.env.CODEX_HOME ?? root,
        platformFamily: "unix",
        platformOs: "linux",
      };
      break;
    case "account/read":
      result = {
        account: { type: "chatgpt", email: "fixture@example.invalid", planType: "plus" },
        requiresOpenaiAuth: false,
      };
      break;
    case "account/rateLimits/read":
      result = { rateLimits: { primary: null, secondary: null, credits: null, planType: "plus" } };
      break;
    case "skills/list":
      result = {
        data: (p.cwds ?? [process.cwd()]).map((cwd) => ({ cwd, errors: [], skills: [] })),
      };
      break;
    case "model/list":
      result = {
        data: ["fixture-manual", "fixture-auto"].map((model, i) => ({
          id: model,
          model,
          displayName: i ? "Fixture Auto" : "Fixture Manual",
          description: "Disposable deterministic local fake; no real provider",
          hidden: false,
          isDefault: !i,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Fixture" }],
          inputModalities: ["text"],
        })),
        nextCursor: null,
      };
      break;
    case "thread/start": {
      const id = `local-thread-${++state.threadCounter}`;
      const thread = {
        id,
        cliVersion: version,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        cwd: p.cwd ?? process.cwd(),
        ephemeral: false,
        model: p.model ?? "fixture-manual",
        modelProvider: "local-fixture",
        preview: "",
        projectId: null,
        sessionId: id,
        source: "appServer",
        status: { type: "idle" },
        turns: [],
      };
      state.threads[id] = thread;
      save(state);
      result = session(thread, p);
      break;
    }
    case "thread/resume": {
      const thread = state.threads[p.threadId];
      if (!thread) throw new Error("Unknown fixture thread");
      result = session(thread, p);
      break;
    }
    case "thread/read":
      result = { thread: state.threads[p.threadId] };
      break;
    case "thread/list":
      result = { data: Object.values(state.threads), nextCursor: null };
      break;
    case "thread/name/set":
    case "thread/archive":
    case "thread/unarchive":
      result = {};
      break;
    case "turn/start": {
      const thread = state.threads[p.threadId];
      if (!thread) throw new Error("Unknown fixture thread");
      const input = (p.input ?? [])
        .filter((v) => v.type === "text")
        .map((v) => v.text)
        .join("\n");
      const turn = {
        id: `local-turn-${++state.turnCounter}`,
        status: "inProgress",
        items: [],
        error: null,
        startedAt: Math.floor(Date.now() / 1000),
        input,
      };
      thread.turns.push(turn);
      thread.status = { type: "active", activeFlags: [] };
      save(state);
      result = { turn: { ...turn, input: undefined } };
      send({ id: m.id, result });
      notify("turn/started", { threadId: thread.id, turn: { ...turn, input: undefined } });
      NodeFS.appendFileSync(
        journal,
        JSON.stringify({
          event: "start",
          threadId: thread.id,
          turnId: turn.id,
          model: p.model ?? thread.model,
          input,
        }) + "\n",
      );
      if (!input.includes("HOLD_FOR_LOCAL_STOP")) setImmediate(() => complete(thread.id, turn.id));
      return;
    }
    case "turn/interrupt":
      send({ id: m.id, result: {} });
      complete(p.threadId, p.turnId, "interrupted");
      return;
    default:
      send({
        id: m.id,
        error: { code: -32601, message: `Unsupported fixture method ${m.method}` },
      });
      return;
  }
  send({ id: m.id, result });
});
