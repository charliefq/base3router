/**
 * Run the focused synthetic task-usage cohort and write a binding report.
 *
 * The cohort test does not read git. Its artifact keeps `commitSha: null`.
 * This script records the HEAD and dirty state of the process that ran it.
 * It copies the artifact's totals; it does not substitute a previous run.
 *
 * Usage, from a clean worktree, with Node 24 on PATH:
 *   node scripts/bind-task-usage-accounting-report.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const artifactDir = "/opt/cursor/artifacts";
const sourcePath = `${artifactDir}/synthetic-accounting-report.json`;
const bindingPath = `${artifactDir}/task-4a-binding-report.json`;
const testArgs = ["test", "run", "apps/server/src/policy/TaskUsageAccounting.test.ts"];
const command = `vp ${testArgs.join(" ")}`;

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const root = git(["rev-parse", "--show-toplevel"]);
process.chdir(root);
const testedCommitSha = git(["rev-parse", "HEAD"]);
const porcelain = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
if (porcelain.length > 0) {
  process.stderr.write(`Refusing to bind a dirty tree:\n${porcelain}`);
  process.exit(1);
}

mkdirSync(artifactDir, { recursive: true });
rmSync(sourcePath, { force: true });
rmSync(bindingPath, { force: true });

const startedAt = new Date().toISOString();
execFileSync("vp", testArgs, { stdio: "inherit" });
const finishedAt = new Date().toISOString();

const source = JSON.parse(readFileSync(sourcePath, "utf8"));
if (source.label !== "SYNTHETIC_ACCOUNTING_VERIFIED" || source.synthetic !== true) {
  throw new Error("Cohort artifact is not the synthetic accounting report.");
}
if (JSON.stringify(source.observed) !== JSON.stringify(source.expected)) {
  throw new Error("Cohort artifact observed totals do not match its expected totals.");
}
if (source.commitSha !== null && source.commitSha !== testedCommitSha) {
  throw new Error("Generator commitSha does not match the tested HEAD.");
}

const reported = source.observed.reported;
const inputPlusOutput = reported.inputTokens + reported.outputTokens;
const billable = source.observed.reportedBillableTokens;
const excludedBecauseIncomplete = inputPlusOutput - billable;
if (
  reported.inputTokens !== 269 ||
  reported.outputTokens !== 64 ||
  inputPlusOutput !== 333 ||
  billable !== 324 ||
  excludedBecauseIncomplete !== 9 ||
  reported.reportedCostUsd !== 13
) {
  throw new Error(
    `Fresh cohort totals were ${inputPlusOutput} input-plus-output, billable ${billable}, cost ${reported.reportedCostUsd}.`,
  );
}

const binding = {
  label: "SYNTHETIC_ACCOUNTING_VERIFIED",
  dispatchId: "base3-unattended-20261010-01",
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
    excludedBecauseIncomplete,
    incompleteAttemptOutputTokens: 9,
    explanation:
      "269 + 64 = 333 sums every known input and output report, including the unfinished attempt that reported 9 output tokens and no input. reportedBillableTokens is 324 because it adds input and output only for attempts that reported both. 333 - 9 = 324. Cache and reasoning stay visible and are not added on top of that sum.",
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

writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
process.stdout.write(`${bindingPath}\n${testedCommitSha}\n`);
