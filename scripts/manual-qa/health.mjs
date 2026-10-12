import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
const repo = NodePath.resolve(process.argv[2] ?? process.cwd());
const base = NodePath.resolve(process.argv[3] ?? NodePath.join(repo, ".t3/qa-ac0-local"));
const log = NodeFS.readFileSync(NodePath.join(base, "private-startup.log"), "utf8");
const match = log.match(/serverPort=(\d+) webPort=(\d+)/);
if (!match) throw Error("Dev runner has not selected ports; inspect private startup log locally.");
const origin = "http://localhost:" + match[2];
for (const path of [
  "/agents",
  "/tasks",
  "/api/auth/session",
  "/src/components/CommandPalette.tsx",
]) {
  const response = await fetch(origin + path);
  const text = await response.text();
  if (response.status !== 200) throw Error("HTTP health failed: " + path + " " + response.status);
  console.log(JSON.stringify({ path, status: response.status, bytes: text.length }));
}
const peer = NodePath.join(base, "fake-peer.jsonl");
if (NodeFS.existsSync(peer)) {
  const rows = NodeFS.readFileSync(peer, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const starts = rows.filter((r) =>
    ["thread/start", "thread/resume", "turn/start"].includes(r.method),
  );
  console.log(
    JSON.stringify({
      metadataPeerRequests: rows.length,
      executionAttempts: starts.length,
      actualExecutionEnabled: false,
    }),
  );
}
console.log(
  JSON.stringify({
    entryType: "localhost on the same machine only",
    origin,
    serverPort: Number(match[1]),
    automatedBrowserQA: false,
    simulatorQA: false,
    physicalDeviceQA: false,
  }),
);
