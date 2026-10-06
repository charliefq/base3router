#!/usr/bin/env node
// Deterministic Codex app-server peer for production-browser journeys.
// NDJSON JSON-RPC at the transport boundary. No paid network.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeProcess from "node:process";
import * as NodeReadline from "node:readline";

const logPath = NodeProcess.env.T3_FAKE_CODEX_LOG;

const writeLog = (entry) => {
  if (logPath === undefined) return;
  NodeFS.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
};

const write = (message) => {
  NodeFS.writeSync(1, `${JSON.stringify(message)}\n`);
};

if (!NodeProcess.argv.includes("app-server")) {
  NodeFS.writeSync(1, "t3-fake-codex 0.0.0\n");
  NodeProcess.exit(0);
}

const nowSec = () => Math.floor(Date.now() / 1000);
const cwd = NodeProcess.cwd();
const makeThread = (threadId) => ({
  id: threadId,
  sessionId: threadId,
  preview: "",
  projectId: null,
  ephemeral: false,
  historyMode: "legacy",
  modelProvider: "openai",
  createdAt: nowSec(),
  updatedAt: nowSec(),
  recencyAt: nowSec(),
  status: { type: "idle" },
  path: "/tmp/fake-codex-rollout.jsonl",
  cwd,
  cliVersion: "0.159.0",
  source: "vscode",
  turns: [],
});

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

const promptText = (params) => {
  const items = params?.input;
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => (typeof item?.text === "string" ? item.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
};

let thread = makeThread("fake-codex-thread");
let turnCount = 0;

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
      id,
      result: {
        userAgent: "t3-fake-codex/0.159.0",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: NodeOS.platform() === "darwin" ? "macos" : "linux",
      },
    });
    return;
  }
  if (method === "initialized") {
    return;
  }
  if (method === "account/read") {
    write({
      id,
      result: { account: { type: "apiKey" }, requiresOpenaiAuth: false },
    });
    return;
  }
  if (method === "account/rateLimits/read") {
    write({
      id,
      result: {
        rateLimits: {
          limitId: "fake",
          windowDurationMins: 60,
          usedPercent: 0,
          remainingPercent: 100,
        },
      },
    });
    return;
  }
  if (method === "skills/list") {
    const cwds = Array.isArray(params?.cwds) && params.cwds.length > 0 ? params.cwds : [cwd];
    write({
      id,
      result: {
        data: cwds.map((entry) => ({ cwd: entry, errors: [], skills: [] })),
      },
    });
    return;
  }
  if (method === "model/list") {
    write({ id, result: { data: [model], nextCursor: null } });
    return;
  }
  if (method === "thread/start" || method === "thread/resume") {
    const threadId = params?.threadId ?? thread.id;
    thread = makeThread(threadId);
    const result = {
      thread,
      model: "gpt-5.4",
      modelProvider: "openai",
      cwd,
      instructionSources: [],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
      },
    };
    write({ id, result });
    write({ method: "thread/started", params: { thread } });
    return;
  }
  if (method === "turn/start") {
    turnCount += 1;
    const turnId = `fake-turn-${turnCount}`;
    const text = promptText(params);
    const turn = {
      id: turnId,
      items: [],
      itemsView: "notLoaded",
      status: "inProgress",
      error: null,
      startedAt: nowSec(),
      completedAt: null,
      durationMs: null,
    };
    const threadId = params?.threadId ?? thread.id;
    const agentText = text.length > 0 ? `fake-codex received: ${text}` : "fake-codex turn complete";
    const agentItem = {
      type: "agentMessage",
      id: `fake-msg-${turnCount}`,
      text: agentText,
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    write({ id, result: { turn } });
    write({ method: "turn/started", params: { threadId, turn } });
    write({
      method: "item/started",
      params: {
        item: agentItem,
        threadId,
        turnId,
        startedAtMs: Date.now(),
      },
    });
    write({
      method: "item/completed",
      params: {
        item: agentItem,
        threadId,
        turnId,
        completedAtMs: Date.now(),
      },
    });
    write({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          ...turn,
          items: [agentItem],
          itemsView: "summary",
          status: "completed",
          completedAt: nowSec(),
          durationMs: 1,
        },
      },
    });
    return;
  }
  if (id !== undefined) {
    write({ id, result: {} });
  }
});
