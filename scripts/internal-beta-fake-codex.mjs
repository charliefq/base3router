#!/usr/bin/env node
// Minimal Codex app-server stand-in for production-browser journeys.
// Logs JSON-RPC methods to T3_FAKE_CODEX_LOG. No paid network.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodeProcess from "node:process";

const logPath = NodeProcess.env.T3_FAKE_CODEX_LOG;
const writeLog = (entry) => {
  if (logPath === undefined) return;
  NodeFS.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
};

if (!NodeProcess.argv.includes("app-server")) {
  NodeProcess.stdout.write("t3-fake-codex 0.0.0\n");
  NodeProcess.exit(0);
}

const write = (message) => NodeProcess.stdout.write(`${JSON.stringify(message)}\n`);
const thread = {
  id: "fake-codex-thread",
  extra: null,
  sessionId: "fake-codex-thread",
  forkedFromId: null,
  parentThreadId: null,
  preview: "",
  projectId: null,
  ephemeral: false,
  historyMode: "legacy",
  modelProvider: "openai",
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
  recencyAt: 1_700_000_000,
  status: { type: "idle" },
  path: "/tmp/fake-codex-rollout.jsonl",
  cwd: NodeProcess.cwd(),
  cliVersion: "0.0.0",
  source: "t3-fake",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: [],
};
const model = {
  additionalSpeedTiers: [],
  defaultReasoningEffort: "medium",
  description: "Fake Codex model",
  displayName: "GPT Fake",
  hidden: false,
  id: "gpt-5.4",
  isDefault: true,
  model: "gpt-5.4",
  defaultServiceTier: "flex",
  serviceTiers: [
    { id: "flex", name: "Flex", description: "Fake flex tier." },
    { id: "priority", name: "Fast", description: "Fake fast tier." },
  ],
  supportedReasoningEfforts: [{ description: "Medium reasoning", reasoningEffort: "medium" }],
};

const rl = NodeReadline.createInterface({ input: NodeProcess.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === undefined) return;
  writeLog({ method, params: params ?? null, at: new Date().toISOString() });
  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        userAgent: "t3-fake-codex/0.0.0",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }
  if (method === "account/read") {
    write({
      jsonrpc: "2.0",
      id,
      result: { account: { type: "apiKey" }, requiresOpenaiAuth: false },
    });
    return;
  }
  if (method === "account/rateLimits/read") {
    write({ jsonrpc: "2.0", id, result: { rateLimits: null } });
    return;
  }
  if (method === "skills/list") {
    write({ jsonrpc: "2.0", id, result: { data: [] } });
    return;
  }
  if (method === "model/list") {
    write({ jsonrpc: "2.0", id, result: { data: [model], nextCursor: null } });
    return;
  }
  if (method === "thread/start" || method === "thread/resume") {
    const threadId = params?.threadId ?? thread.id;
    write({
      jsonrpc: "2.0",
      id,
      result: {
        thread: { ...thread, id: threadId, sessionId: threadId },
        model: "gpt-5.4",
        modelProvider: "openai",
      },
    });
    return;
  }
  if (method === "turn/start") {
    const turn = {
      id: `fake-turn-${Date.now()}`,
      items: [],
      itemsView: "notLoaded",
      status: "completed",
      error: null,
      startedAt: Date.now(),
      completedAt: Date.now(),
      durationMs: 1,
    };
    write({ jsonrpc: "2.0", id, result: { turn: { ...turn, status: "inProgress" } } });
    write({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: params?.threadId ?? thread.id,
        turn,
      },
    });
    return;
  }
  if (id !== undefined) {
    write({ jsonrpc: "2.0", id, result: {} });
  }
});
