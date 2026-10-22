// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";

it("publishes complete replay status before the last response permits immediate shutdown", async () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-status-"));
  const statusPath = NodePath.join(directory, "status.json");
  const transcriptPath = NodePath.join(directory, "transcript.json");
  const preloadPath = NodePath.join(directory, "observe-publication.cjs");
  NodeFS.writeFileSync(
    transcriptPath,
    JSON.stringify({
      scenario: "status-publication",
      entries: [
        {
          type: "expect_outbound",
          frame: { kind: "request", method: "initialize", params: "<any>" },
        },
        { type: "emit_inbound", frame: { kind: "response", method: "initialize", result: {} } },
      ],
    }),
  );
  // Widen the exact publication boundary deterministically, without timers or
  // retries: the published path must remain valid during a partial staging write.
  // Also reject committing the final status after its response has been emitted.
  NodeFS.writeFileSync(
    preloadPath,
    `
const fs = require('node:fs');
const originalWrite = fs.writeFileSync;
const originalStdout = process.stdout.write.bind(process.stdout);
let responded = false;
process.stdout.write = function (chunk, ...args) {
  if (String(chunk).includes('"id":1')) responded = true;
  return originalStdout(chunk, ...args);
};
fs.writeFileSync = function (path, data, ...args) {
  const status = JSON.parse(String(data));
  if (status.cursor === 2) {
    if (responded) throw new Error('Final status committed after reply');
    originalWrite(path, String(data).slice(0, 8), ...args);
    JSON.parse(fs.readFileSync(process.env.T3_ACP_REPLAY_STATUS_PATH, 'utf8'));
  }
  return originalWrite(path, data, ...args);
};
require('node:module').syncBuiltinESMExports();
`,
  );
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--import",
      preloadPath,
      NodeURL.fileURLToPath(new URL("./acp-replay-agent.ts", import.meta.url)),
    ],
    {
      env: {
        ...process.env,
        T3_ACP_REPLAY_TRANSCRIPT_PATH: transcriptPath,
        T3_ACP_REPLAY_STATUS_PATH: statusPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const closed = NodeEvents.EventEmitter.once(child, "close");
  const lines = NodeReadline.createInterface({ input: child.stdout });
  const reply = NodeEvents.EventEmitter.once(lines, "line");
  const errors: string[] = [];
  child.stderr.on("data", (chunk) => errors.push(String(chunk)));
  try {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    );
    const response = await Promise.race([
      reply,
      closed.then(() => {
        throw new Error(`Replay exited before reply: ${errors.join("")}`);
      }),
    ]);
    assert.deepEqual(JSON.parse(String(response[0])), { jsonrpc: "2.0", id: 1, result: {} });
    // No waiting for a later write: observing the answer must imply commit.
    assert.deepEqual(JSON.parse(NodeFS.readFileSync(statusPath, "utf8")), {
      scenario: "status-publication",
      cursor: 2,
      total: 2,
    });
    assert.isFalse(NodeFS.existsSync(`${statusPath}.pending`));
  } finally {
    child.kill();
    await closed;
    lines.close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
