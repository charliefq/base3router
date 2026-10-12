#!/usr/bin/env node
// Deterministic Codex app-server peer for production-browser journeys.
// NDJSON JSON-RPC at the transport boundary. No paid network.
import * as NodeFS from "node:fs";
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

const cwd = NodeProcess.cwd();
const model = {
  additionalSpeedTiers: [],
  defaultReasoningEffort: "medium",
  description: "Fake Codex model",
  displayName: "QA FIXTURE — NEVER EXECUTES",
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
  writeLog({ method, at: new Date().toISOString() });
  if (
    ![
      "initialize",
      "initialized",
      "account/read",
      "account/rateLimits/read",
      "skills/list",
      "model/list",
    ].includes(method)
  ) {
    writeLog({ blocked: true, method });
    if (id !== undefined)
      write({ id, error: { code: -32001, message: "QA fixture denies session/turn execution" } });
    return;
  }
  if (method === "initialize") {
    write({
      id,
      result: {
        userAgent: "t3-fake-codex/0.159.0",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: NodeProcess.platform === "darwin" ? "macos" : "linux",
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
});
