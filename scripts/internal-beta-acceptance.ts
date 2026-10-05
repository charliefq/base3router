// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import {
  argvFor,
  checkEvidence,
  GATES,
  type EvidenceDocument,
  type GateEvidence,
  verdictFor,
} from "./internal-beta-acceptance-lib.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

const git = (args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });

const currentTree = () => {
  const sha = git(["rev-parse", "HEAD"]).stdout.trim();
  const dirty = git(["status", "--porcelain"]).stdout.trim().length > 0;
  return { sha, dirty };
};

const runGate = (gate: (typeof GATES)[number], evidenceDir: string): GateEvidence => {
  const mapped = argvFor(gate.command, repoRoot);
  if ("blocked" in mapped) {
    return {
      id: gate.id,
      requirementIds: [...gate.requirementIds],
      title: gate.title,
      requiredLocal: gate.requiredLocal,
      status: "BLOCKED",
      argv: [],
      exitCode: null,
      evidencePath: null,
      detail: mapped.blocked,
    };
  }
  if (gate.id === "L-ui-lab" && NodeProcess.env.INTERNAL_BETA_SKIP_UI_LAB === "1") {
    return {
      id: gate.id,
      requirementIds: [...gate.requirementIds],
      title: gate.title,
      requiredLocal: gate.requiredLocal,
      status: "NOT_RUN",
      argv: mapped.argv,
      exitCode: null,
      evidencePath: null,
      detail: "Skipped; UI Lab runs in its dedicated workflow.",
    };
  }
  const env = {
    ...NodeProcess.env,
    INTERNAL_BETA_EVIDENCE_DIR: evidenceDir,
  };
  const [bin, ...args] = mapped.argv;
  const result = NodeChildProcess.spawnSync(bin ?? "vp", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
  const logPath = NodePath.join(evidenceDir, `${gate.id}.log`);
  NodeFS.writeFileSync(
    logPath,
    `${result.stdout ?? ""}\n${result.stderr ?? ""}\nexit=${String(result.status)}\n`,
  );
  const status = result.status === 0 ? "PASS" : "FAIL";
  return {
    id: gate.id,
    requirementIds: [...gate.requirementIds],
    title: gate.title,
    requiredLocal: gate.requiredLocal,
    status,
    argv: mapped.argv,
    exitCode: result.status,
    evidencePath: logPath,
    detail:
      status === "PASS"
        ? "completed"
        : (result.stderr || result.stdout || "command failed").slice(0, 2000),
  };
};

const writeEvidence = (path: string, document: EvidenceDocument) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
};

const usage = () => {
  NodeProcess.stderr.write(
    "Usage: node scripts/internal-beta-acceptance.ts <run|check> [--out <file>] [--evidence <file>]\n",
  );
  NodeProcess.exit(2);
};

const args = NodeProcess.argv.slice(2);
const command = args[0];
if (command !== "run" && command !== "check") usage();

if (command === "run") {
  const outFlag = args.indexOf("--out");
  const specifiedOut = outFlag >= 0 ? args[outFlag + 1] : undefined;
  const outPath =
    specifiedOut !== undefined
      ? specifiedOut
      : NodePath.join(repoRoot, ".t3", "internal-beta-evidence.json");
  const evidenceDir = NodePath.join(NodePath.dirname(outPath), "internal-beta-evidence");
  NodeFS.mkdirSync(evidenceDir, { recursive: true });
  const tree = currentTree();
  const gates = GATES.map((gate) => runGate(gate, evidenceDir));
  const document: EvidenceDocument = {
    schemaVersion: "internal-beta-evidence.v1",
    sha: tree.sha,
    dirty: tree.dirty,
    recordedAt: new Date().toISOString(),
    gates,
    verdict: verdictFor(gates),
  };
  writeEvidence(outPath, document);
  NodeProcess.stdout.write(
    `${document.verdict} sha=${document.sha} dirty=${String(document.dirty)}\n`,
  );
  NodeProcess.exit(document.verdict === "LOCAL_STABILIZATION_VERIFIED" ? 0 : 1);
}

const evidenceFlag = args.indexOf("--evidence");
if (evidenceFlag < 0 || args[evidenceFlag + 1] === undefined) usage();
const evidencePath = args[evidenceFlag + 1]!;
const raw = NodeFS.existsSync(evidencePath) ? NodeFS.readFileSync(evidencePath, "utf8") : "";
let parsed: unknown = null;
if (raw.length > 0) {
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
}
const tree = currentTree();
const checked = checkEvidence({ evidence: parsed, currentSha: tree.sha, dirty: tree.dirty });
NodeProcess.stdout.write(`${checked.verdict}\n${checked.detail}\n`);
NodeProcess.exit(checked.ok ? 0 : 1);
