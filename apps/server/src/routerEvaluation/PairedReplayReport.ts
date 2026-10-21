/** Reports caller-declared recorded executions. Never dispatches a provider or authenticates evidence. */
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  HYBRID_MIN_SAMPLE_P90,
  MODEL_ROUTER_POLICY_VERSION,
  MeasuredQuantityV0,
  ProviderDriverKind,
  ProviderInstanceId,
  unknownQuantity,
  type ModelRouterMetricValue,
  type ModelRouterTarget,
} from "@t3tools/contracts";
import { modelRouterTargetKey } from "@t3tools/shared/modelRouter";
import { runFixedTaskCorpus, type FixedTaskCase } from "./FixedTaskCorpus.ts";

const CATEGORIES = ["code-tools", "image-vision", "long-context"] as const;
type Category = (typeof CATEGORIES)[number];
type Arm = "router" | "baseline";
type EvidenceClass = "FIXTURE" | "SYNTHETIC" | "OBSERVED";

export interface PairedReplayTask extends Pick<
  FixedTaskCase,
  "id" | "description" | "catalogEvidenceClass" | "input" | "expected"
> {
  readonly category: Category;
  /** Caller-supplied strong comparator; its strength is not independently verified here. */
  readonly baselineTarget: ModelRouterTarget;
}
export interface PairedReplayCorpus {
  readonly id: string;
  readonly version: string;
  readonly tasks: ReadonlyArray<PairedReplayTask>;
}
export interface PairedReplayRecord {
  readonly taskId: string;
  readonly arm: Arm;
  readonly executedTarget: ModelRouterTarget;
  readonly outcome: "success" | "failure" | "cancelled" | "timeout";
  readonly evidenceClass: EvidenceClass;
  readonly cost: {
    readonly completeness: "complete" | "partial" | "unknown";
    readonly quantity: MeasuredQuantityV0;
  };
  readonly latency: MeasuredQuantityV0;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const key = (record: Pick<PairedReplayRecord, "taskId" | "arm">) =>
  JSON.stringify([record.taskId, record.arm]);
const sameTarget = (a: ModelRouterTarget | null, b: ModelRouterTarget) =>
  a !== null && modelRouterTargetKey(a) === modelRouterTargetKey(b);
const ratio = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  rate: (denominator === 0
    ? { status: "unknown" }
    : { status: "known", value: numerator / denominator }) as ModelRouterMetricValue,
});
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compare(a, b))
      .map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const isQuantity = Schema.is(MeasuredQuantityV0);
const qualified = (record: PairedReplayRecord, unit: "usd" | "ms") => {
  const quantity = unit === "usd" ? record.cost.quantity : record.latency;
  if (unit === "usd" && record.cost.completeness !== "complete") return null;
  if (!isQuantity(quantity) || quantity.status !== "known" || quantity.unit !== unit) return null;
  if (record.evidenceClass === "OBSERVED") {
    const allowed =
      unit === "usd"
        ? quantity.source === "provider_reported"
        : ["monotonic_clock", "wall_clock", "provider_reported"].includes(quantity.source);
    if (quantity.provenance !== "observed" || !allowed) return null;
  } else if (quantity.provenance === "unknown") return null;
  return quantity;
};
const measurements = (
  records: ReadonlyArray<PairedReplayRecord>,
  unit: "usd" | "ms",
  evidenceClass: EvidenceClass,
) => {
  const quantities = records.flatMap((record) => {
    const value = qualified(record, unit);
    return value === null ? [] : [value];
  });
  const sources = [...new Set(quantities.map((item) => item.source))].sort(compare);
  const sourceComposition =
    sources.length === 0 ? "none" : sources.length === 1 ? "single" : "mixed";
  const status =
    quantities.length === 0
      ? "unknown"
      : unit === "ms" && quantities.length < HYBRID_MIN_SAMPLE_P90
        ? "insufficient"
        : "reliable";
  const values = quantities.map((item) => item.value).sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  const toQuantity = (value: number | undefined): MeasuredQuantityV0 =>
    status !== "reliable" || value === undefined || !Number.isFinite(value)
      ? unknownQuantity(unit)
      : {
          status: "known",
          value,
          unit,
          source: sources.length === 1 ? sources[0]! : "unknown",
          provenance: evidenceClass === "OBSERVED" ? "observed" : "estimated",
          observedAt: quantities
            .map((item) => item.observedAt)
            .sort(compare)
            .at(-1)!,
        };
  return {
    status,
    sampleCount: quantities.length,
    sources,
    sourceComposition,
    quantity: toQuantity(unit === "usd" ? total : values[Math.ceil(values.length * 0.9) - 1]),
    mean: toQuantity(quantities.length === 0 ? undefined : total / quantities.length),
    excludedCount: records.length - quantities.length,
    reliableSampleThreshold: unit === "ms" ? HYBRID_MIN_SAMPLE_P90 : 1,
  };
};
const armSummary = (
  records: ReadonlyArray<PairedReplayRecord>,
  eligibleTasks: number,
  evidenceClass: EvidenceClass,
) => {
  const cost = measurements(records, "usd", evidenceClass);
  const partialTasks = records.filter((record) => record.cost.completeness === "partial").length;
  return {
    evidenceClass,
    eligibleTasks,
    terminalTasks: records.length,
    terminalCoverage: ratio(records.length, eligibleTasks).rate,
    success: ratio(records.filter((record) => record.outcome === "success").length, records.length),
    taskCost: {
      total: cost.quantity,
      mean: cost.mean,
      measuredTasks: cost.sampleCount,
      eligibleTasks,
      coverage: ratio(cost.sampleCount, eligibleTasks).rate,
      partialTasks,
      missingTasks: records.length - cost.sampleCount - partialTasks,
      sources: cost.sources,
      sourceComposition: cost.sourceComposition,
      completeness: "sum_and_mean_of_explicitly_complete_qualified_tasks_only" as const,
    },
    latency: measurements(records, "ms", evidenceClass),
  };
};
const difference = (a: number | undefined, b: number | undefined) =>
  a === undefined || b === undefined
    ? { status: "unknown" as const }
    : { status: "known" as const, value: a - b };

export const pairedReplayReport = (
  corpus: PairedReplayCorpus,
  inputRecords: ReadonlyArray<PairedReplayRecord>,
) => {
  const routed = runFixedTaskCorpus({
    id: corpus.id,
    version: corpus.version,
    cases: corpus.tasks,
  });
  const definitions = new Map(corpus.tasks.map((task) => [task.id, task]));
  const records = [...inputRecords].sort((a, b) => compare(key(a), key(b)));
  const recordMap = new Map<string, PairedReplayRecord>();
  for (const record of records) {
    if (!definitions.has(record.taskId)) throw new Error(`Unknown task id: ${record.taskId}`);
    if (recordMap.has(key(record))) throw new Error(`Duplicate task/arm record: ${key(record)}`);
    recordMap.set(key(record), record);
  }
  const tasks = routed.cases.map((item) => {
    const definition = definitions.get(item.id)!;
    const router = recordMap.get(key({ taskId: item.id, arm: "router" }));
    const baseline = recordMap.get(key({ taskId: item.id, arm: "baseline" }));
    return {
      id: item.id,
      description: item.description,
      category: definition.category,
      input: item.input,
      decision: item.decision,
      explanation: item.explanation,
      expected: item.expected,
      selected: item.selected,
      selectionCorrect: item.selectionCorrect,
      baselineTarget: definition.baselineTarget,
      records: {
        router:
          router === undefined
            ? null
            : { ...router, targetMatches: sameTarget(item.selected, router.executedTarget) },
        baseline:
          baseline === undefined
            ? null
            : {
                ...baseline,
                targetMatches: sameTarget(definition.baselineTarget, baseline.executedTarget),
              },
      },
      missingArms: (["router", "baseline"] as const).filter(
        (arm) => recordMap.get(key({ taskId: item.id, arm })) === undefined,
      ),
      pairEvidenceAligned:
        router !== undefined &&
        baseline !== undefined &&
        router.evidenceClass === baseline.evidenceClass,
    };
  });
  const summary = (category: Category | null, evidenceClass: EvidenceClass) => {
    const eligible = tasks.filter((task) => category === null || task.category === category);
    const included = records.filter(
      (record) =>
        record.evidenceClass === evidenceClass &&
        eligible.some((task) => task.id === record.taskId),
    );
    const pairs = eligible.flatMap((task) => {
      const router = task.records.router;
      const baseline = task.records.baseline;
      return router?.evidenceClass === evidenceClass && baseline?.evidenceClass === evidenceClass
        ? [{ router, baseline }]
        : [];
    });
    const comparable = pairs.filter(
      (pair) => pair.router.targetMatches && pair.baseline.targetMatches,
    );
    const costPairs = comparable.filter(
      (pair) => qualified(pair.router, "usd") !== null && qualified(pair.baseline, "usd") !== null,
    );
    const latencyPairs = comparable.filter(
      (pair) => qualified(pair.router, "ms") !== null && qualified(pair.baseline, "ms") !== null,
    );
    const pairedCostRouter = measurements(
      costPairs.map((pair) => pair.router),
      "usd",
      evidenceClass,
    ).mean;
    const pairedCostBaseline = measurements(
      costPairs.map((pair) => pair.baseline),
      "usd",
      evidenceClass,
    ).mean;
    const pairedLatencyRouter = measurements(
      latencyPairs.map((pair) => pair.router),
      "ms",
      evidenceClass,
    ).quantity;
    const pairedLatencyBaseline = measurements(
      latencyPairs.map((pair) => pair.baseline),
      "ms",
      evidenceClass,
    ).quantity;
    return {
      evidenceClass,
      eligibleTasks: eligible.length,
      arms: {
        router: armSummary(
          included.filter((record) => record.arm === "router"),
          eligible.length,
          evidenceClass,
        ),
        baseline: armSummary(
          included.filter((record) => record.arm === "baseline"),
          eligible.length,
          evidenceClass,
        ),
      },
      paired: {
        eligibleTasks: eligible.length,
        recordedPairs: pairs.length,
        comparablePairs: comparable.length,
        recordedCoverage: ratio(pairs.length, eligible.length).rate,
        comparableCoverage: ratio(comparable.length, eligible.length).rate,
      },
      differences: {
        definition: "router_minus_baseline_on_same_evidence_and_target_aligned_tasks" as const,
        successPairs: comparable.length,
        costPairs: costPairs.length,
        latencyPairs: latencyPairs.length,
        successRate: difference(
          comparable.length === 0
            ? undefined
            : comparable.filter((pair) => pair.router.outcome === "success").length /
                comparable.length,
          comparable.length === 0
            ? undefined
            : comparable.filter((pair) => pair.baseline.outcome === "success").length /
                comparable.length,
        ),
        meanTaskCost: difference(
          pairedCostRouter.status === "known" ? pairedCostRouter.value : undefined,
          pairedCostBaseline.status === "known" ? pairedCostBaseline.value : undefined,
        ),
        p90Latency: difference(
          pairedLatencyRouter.status === "known" ? pairedLatencyRouter.value : undefined,
          pairedLatencyBaseline.status === "known" ? pairedLatencyBaseline.value : undefined,
        ),
      },
    };
  };
  const byEvidence = (evidenceClass: EvidenceClass) => ({
    evidenceClass,
    overall: summary(null, evidenceClass),
    categories: {
      "code-tools": summary("code-tools", evidenceClass),
      "image-vision": summary("image-vision", evidenceClass),
      "long-context": summary("long-context", evidenceClass),
    },
  });
  return {
    corpusId: corpus.id,
    corpusVersion: corpus.version,
    contentHash: routed.contentHash,
    normalizedRecordHash: NodeCrypto.createHash("sha256").update(canonical(records)).digest("hex"),
    outcomeDefinition:
      "success is the explicitly recorded terminal success; failure, cancelled and timeout remain in the terminal denominator" as const,
    evidenceAuthenticity: "caller_declarations_not_independently_verified" as const,
    selectionConformance: {
      meaning: "expected_router_target_not_task_outcome" as const,
      ...ratio(tasks.filter((task) => task.selectionCorrect).length, tasks.length),
    },
    tasks,
    evidence: {
      FIXTURE: byEvidence("FIXTURE"),
      SYNTHETIC: byEvidence("SYNTHETIC"),
      OBSERVED: byEvidence("OBSERVED"),
    },
  };
};

const baselineTarget: ModelRouterTarget = {
  instanceId: ProviderInstanceId.make("fixture-strong-baseline"),
  model: "fixture-universal-baseline",
};
const fixtureTasks: ReadonlyArray<PairedReplayTask> = CATEGORIES.flatMap((category) =>
  Array.from({ length: 20 }, (_, index): PairedReplayTask => {
    const expected: ModelRouterTarget = {
      instanceId: ProviderInstanceId.make(`fixture-${category}-${index}`),
      model: `fixture-${category}-efficient-${index}`,
    };
    const alternate: ModelRouterTarget = {
      instanceId: ProviderInstanceId.make(`fixture-${category}-alternate-${index}`),
      model: `fixture-${category}-alternate-${index}`,
    };
    const capabilities =
      category === "code-tools"
        ? (["code", "tools"] as const)
        : category === "image-vision"
          ? (["vision"] as const)
          : (["long-context"] as const);
    return {
      id: `${category}-${index + 1}`,
      category,
      description: `${category}: ${index % 2 === 0 ? "focused artifact" : "multi-part artifact"}, ${index + 1} input sections; fixture only.`,
      catalogEvidenceClass: "FIXTURE",
      expected,
      baselineTarget,
      input: {
        mode: "auto",
        task: {
          attachmentCount: category === "image-vision" ? (index % 3) + 1 : 0,
          composerContextKinds:
            category === "code-tools"
              ? [index % 2 === 0 ? "test" : "repository"]
              : [index % 2 === 0 ? "document" : "workspace", `sections-${index + 1}`],
          requiredCapabilities: capabilities,
        },
        constraints: {
          requiredCapabilities: capabilities,
          ...(index % 3 === 0 ? { allowedModels: [expected.model, baselineTarget.model] } : {}),
          ...(index % 2 === 0 ? { excludedInstanceIds: [alternate.instanceId] } : {}),
        },
        policy: {
          version: MODEL_ROUTER_POLICY_VERSION,
          qualityWeight: 0,
          costWeight: index % 2 === 0 ? 1 : 0,
          latencyWeight: index % 2 === 0 ? 0 : 1,
        },
        catalog: [
          {
            ...expected,
            driver: ProviderDriverKind.make("codex"),
            capabilities: [
              ...capabilities,
              ...(index % 2 === 0 ? ["code" as const] : ["tools" as const]),
            ],
            isDefault: false,
            availabilityReasons: [],
            metrics: {
              quality: { status: "unknown" },
              costUsd: { status: "known", value: 0.1 + index / 1000 },
              latencyMs: { status: "known", value: 10 + index },
            },
          },
          {
            ...alternate,
            driver: ProviderDriverKind.make("opencode"),
            capabilities,
            isDefault: false,
            availabilityReasons: [],
            metrics: {
              quality: { status: "unknown" },
              costUsd: { status: "known", value: 0.3 + index / 1000 },
              latencyMs: { status: "known", value: 40 + index },
            },
          },
          {
            ...baselineTarget,
            driver: ProviderDriverKind.make("claudeAgent"),
            capabilities: ["code", "tools", "vision", "long-context"],
            isDefault: false,
            availabilityReasons: [],
            metrics: {
              quality: { status: "unknown" },
              costUsd: { status: "known", value: 0.8 },
              latencyMs: { status: "known", value: 100 },
            },
          },
        ],
      },
    };
  }),
);
const fixtureQuantity = (value: number, unit: "usd" | "ms"): MeasuredQuantityV0 => ({
  status: "known",
  value,
  unit,
  source: "catalog_estimate",
  provenance: "estimated",
  observedAt: "2026-10-13T00:00:00Z",
});
export const PAIRED_FIXTURE_EXAMPLE = {
  meaning:
    "FIXTURE report mechanics only; no model capability, quality or savings validation" as const,
  corpus: {
    id: "model-router-paired-fixture",
    version: "1",
    tasks: fixtureTasks,
  } satisfies PairedReplayCorpus,
  records: fixtureTasks.flatMap((task, index): ReadonlyArray<PairedReplayRecord> =>
    (["router", "baseline"] as const).map((arm) => ({
      taskId: task.id,
      arm,
      executedTarget: arm === "router" ? task.expected! : task.baselineTarget,
      outcome: index % (arm === "router" ? 5 : 7) === 0 ? "failure" : "success",
      evidenceClass: "FIXTURE",
      cost: {
        completeness: "complete",
        quantity: fixtureQuantity(
          arm === "router" ? 0.2 + index / 1000 : 0.5 + index / 1000,
          "usd",
        ),
      },
      latency: fixtureQuantity((arm === "router" ? 100 : 200) + index, "ms"),
    })),
  ),
};
