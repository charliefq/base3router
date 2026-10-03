#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Offline evaluation harness reads a local fixture or dataset file.
/**
 * Offline Hybrid Router evaluation harness. Never mutates the active policy,
 * never requires a provider credential, and never makes network calls.
 */
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";

import { routeHybridModel } from "@t3tools/shared/hybridRouter";
import { routeModel, type ModelRouterCatalogEntry } from "@t3tools/shared/modelRouter";
import {
  HYBRID_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_POLICY_VERSION,
  ProviderDriverKind,
  ProviderInstanceId,
  buildEvaluationDataset,
  evaluatePolicies,
  evidenceFromObservations,
  type TurnOutcomeObservationV0,
} from "@t3tools/shared/routerEvaluation";
import { SYNTHETIC_ROUTER_EVALUATION_OBSERVATIONS } from "@t3tools/shared/routerEvaluation.fixture";

const args = NodeProcess.argv.slice(2);
const datasetArg = args.includes("--dataset") ? args[args.indexOf("--dataset") + 1] : "synthetic";
const policyArg = args.includes("--policy")
  ? args[args.indexOf("--policy") + 1]
  : HYBRID_ROUTER_POLICY_VERSION;

const catalogFrom = (
  records: ReadonlyArray<TurnOutcomeObservationV0>,
): ReadonlyArray<ModelRouterCatalogEntry> => {
  const seen = new Set<string>();
  const catalog: Array<ModelRouterCatalogEntry> = [];
  for (const record of records) {
    const instanceId = record.instanceId ?? ProviderInstanceId.make("unknown");
    const key = `${instanceId}\u0000${record.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    catalog.push({
      instanceId,
      driver: record.driver ?? ProviderDriverKind.make("codex"),
      model: record.model,
      isDefault: catalog.length === 0,
      capabilities: ["code", "tools"],
      availabilityReasons: [],
    });
  }
  return catalog;
};

const loadRecords = (dataset: string): ReadonlyArray<TurnOutcomeObservationV0> => {
  if (dataset === "synthetic" || dataset === "fixture") {
    return SYNTHETIC_ROUTER_EVALUATION_OBSERVATIONS;
  }
  const raw = NodeFS.readFileSync(dataset, "utf8");
  const parsed = JSON.parse(raw) as { readonly records?: ReadonlyArray<TurnOutcomeObservationV0> };
  if (!Array.isArray(parsed.records)) {
    throw new Error("Dataset JSON must contain a records array of sanitized observations.");
  }
  return parsed.records;
};

const records = loadRecords(datasetArg ?? "synthetic");
const dataset = buildEvaluationDataset({
  records,
  synthetic: datasetArg === "synthetic" || datasetArg === "fixture",
});
const catalog = catalogFrom(records);
const evidence = evidenceFromObservations(dataset.train);
const v0Selected = new Map<string, string>();
const hybridSelected = new Map<string, string>();

for (const record of dataset.evaluation) {
  const input = {
    mode: "auto" as const,
    catalog,
  };
  const v0 = routeModel(input);
  const hybrid = routeHybridModel({
    ...input,
    evidenceByTarget: evidence,
    activePolicyVersion: HYBRID_ROUTER_POLICY_VERSION,
  });
  if (v0.selected) {
    v0Selected.set(
      record.observationId,
      `${v0.selected.target.instanceId}\u0000${v0.selected.target.model}`,
    );
  }
  if (hybrid.decision.selected) {
    hybridSelected.set(
      record.observationId,
      `${hybrid.decision.selected.target.instanceId}\u0000${hybrid.decision.selected.target.model}`,
    );
  }
}

const report = evaluatePolicies({
  records,
  v0Selected,
  hybridSelected,
  policyVersion: policyArg ?? HYBRID_ROUTER_POLICY_VERSION,
  synthetic: dataset.manifest.synthetic,
});

const human = [
  `Router evaluation ${report.evaluationId}`,
  `Policy: ${report.policyVersion} (baseline ${MODEL_ROUTER_POLICY_VERSION})`,
  `Dataset hash: ${report.dataset.datasetHash} records=${report.dataset.recordCount} eval=${report.dataset.evaluationCount}`,
  `Excluded: ${report.excludedCount} (${report.exclusionReasons.join(", ") || "none"})`,
  `Changed decisions: ${report.changedDecisions} improvements=${report.improvements} regressions=${report.regressions} unknowns=${report.unknowns}`,
  `Coverage status: ${report.coverage.status} n=${report.coverage.sampleCount}`,
  "Active policy was not mutated. No network calls were made.",
].join("\n");

NodeProcess.stdout.write(`${JSON.stringify(report, null, 2)}\n\n${human}\n`);
