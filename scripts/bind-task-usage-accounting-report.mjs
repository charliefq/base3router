/**
 * Run the focused synthetic task-usage cohort and write a binding report.
 *
 * The cohort test does not read git. Its artifact keeps `commitSha: null`.
 * This script records the HEAD and dirty state of the process that ran it.
 * It copies the artifact's totals; it does not substitute a previous run.
 *
 * Usage, from a clean worktree, with Node 24 on PATH:
 *   node scripts/bind-task-usage-accounting-report.mjs
 *
 * TASK_USAGE_ARTIFACT_DIR overrides the output directory. The default is
 * /opt/cursor/artifacts. The cohort test reads the same variable.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const artifactDir = process.env.TASK_USAGE_ARTIFACT_DIR ?? "/opt/cursor/artifacts";
const sourcePath = `${artifactDir}/synthetic-accounting-report.json`;
const bindingPath = `${artifactDir}/task-4a-binding-report.json`;
const testArgs = ["test", "run", "apps/server/src/policy/TaskUsageAccounting.test.ts"];
const command = `vp ${testArgs.join(" ")}`;

const git = (args) => NodeChildProcess.execFileSync("git", args, { encoding: "utf8" }).trim();

const root = git(["rev-parse", "--show-toplevel"]);
process.chdir(root);
const testedCommitSha = git(["rev-parse", "HEAD"]);
const porcelain = NodeChildProcess.execFileSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
});
if (porcelain.length > 0) {
  process.stderr.write(`Refusing to bind a dirty tree:\n${porcelain}`);
  process.exit(1);
}

NodeFS.mkdirSync(artifactDir, { recursive: true });
NodeFS.rmSync(sourcePath, { force: true });
NodeFS.rmSync(bindingPath, { force: true });

const startedAt = new Date().toISOString();
NodeChildProcess.execFileSync("vp", testArgs, {
  stdio: "inherit",
  env: { ...process.env, TASK_USAGE_ARTIFACT_DIR: artifactDir },
});
const finishedAt = new Date().toISOString();

const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
};

const source = JSON.parse(NodeFS.readFileSync(sourcePath, "utf8"));
if (source.label !== "SYNTHETIC_ACCOUNTING_VERIFIED" || source.synthetic !== true) {
  throw new Error("Cohort artifact is not the synthetic accounting report.");
}
if (JSON.stringify(sortKeys(source.observed)) !== JSON.stringify(sortKeys(source.expected))) {
  throw new Error("Cohort artifact observed totals do not match its expected totals.");
}
if (source.commitSha !== null && source.commitSha !== testedCommitSha) {
  throw new Error("Generator commitSha does not match the tested HEAD.");
}

const reported = source.observed.reported;
const inputPlusOutput = reported.inputTokens + reported.outputTokens;
const billable = source.observed.reportedBillableTokens;
const excludedFromInternalCompletePairMetric = inputPlusOutput - billable;
if (
  reported.inputTokens !== 269 ||
  reported.outputTokens !== 64 ||
  inputPlusOutput !== 333 ||
  billable !== 324 ||
  excludedFromInternalCompletePairMetric !== 9 ||
  reported.reportedCostUsd !== 13
) {
  throw new Error(
    `Fresh cohort totals were ${inputPlusOutput} input-plus-output, billable ${billable}, cost ${reported.reportedCostUsd}.`,
  );
}

const binding = {
  label: "SYNTHETIC_ACCOUNTING_VERIFIED",
  dispatchId: "base3-unattended-20261010-02",
  synthetic: true,
  notModelPerformance: true,
  notAutoVsManualComparison: true,
  notVendorInvoice: true,
  notRealSpend: true,
  testedCommitSha,
  dirty: false,
  porcelain,
  command,
  startedAt,
  finishedAt,
  generatorCommitSha: source.commitSha,
  baselineSha: source.baselineSha,
  reconciliation: {
    reportedInputTokens: reported.inputTokens,
    reportedOutputTokens: reported.outputTokens,
    reportedInputPlusOutput: inputPlusOutput,
    reportedBillableTokens: billable,
    excludedFromInternalCompletePairMetric,
    incompleteAttemptOutputTokens: 9,
    vendorBillableDetermination: "unknown",
    explanation:
      "269 + 64 = 333 sums every known input and output report, including the unfinished attempt that reported 9 output tokens and no input. reportedBillableTokens is 324 because the internal complete-pair metric adds input and output only when an attempt reported both. 333 - 9 = 324. Those 9 tokens are excluded from that metric only. This run does not decide whether a vendor would bill them. The attempt reported no cost, so its provider-reported cost stays unknown. Cache and reasoning stay inside the reported input and output totals and are not added again.",
  },
  currency: {
    field: "reportedCostUsd",
    amount: reported.reportedCostUsd,
    unit: "USD-shaped provider-reported number from the synthetic fixture",
    vendorInvoice: false,
    realSpend: false,
  },
  sourceReport: source,
};

NodeFS.writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
process.stdout.write(`${bindingPath}\n${testedCommitSha}\n`);
