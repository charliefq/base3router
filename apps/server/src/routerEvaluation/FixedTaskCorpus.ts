/** Offline policy conformance, not a model-quality benchmark or a provider dispatcher. */
import * as NodeCrypto from "node:crypto";
import {
  HYBRID_MIN_SAMPLE_P90,
  MODEL_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_UNKNOWN_METRICS,
  MeasuredQuantityV0,
  ProviderDriverKind,
  ProviderInstanceId,
  unknownQuantity,
  type EvaluationMetricV0,
  type ModelRouterMetricValue,
  type ModelRouterTarget,
} from "@t3tools/contracts";
import {
  routeModel,
  modelRouterTargetKey,
  type ModelRouterInput,
} from "@t3tools/shared/modelRouter";
import * as Schema from "effect/Schema";

export interface FixedTaskMeasurement {
  readonly id: string;
  /** OBSERVED is a caller-supplied evidence assertion, not a live verification by this runner. */
  readonly evidenceClass: "FIXTURE" | "SYNTHETIC" | "OBSERVED";
  readonly cost: MeasuredQuantityV0;
  readonly latency: MeasuredQuantityV0;
}

export interface FixedTaskCase {
  readonly id: string;
  readonly description: string;
  readonly catalogEvidenceClass: "FIXTURE" | "SYNTHETIC";
  readonly input: ModelRouterInput;
  /** null means the existing router is expected to reject, not a new evaluation filter. */
  readonly expected: ModelRouterTarget | null;
  readonly recordedExecutedTarget?: ModelRouterTarget;
  readonly measurements?: ReadonlyArray<FixedTaskMeasurement>;
}

export interface FixedTaskCorpus {
  readonly id: string;
  readonly version: string;
  readonly cases: ReadonlyArray<FixedTaskCase>;
}

const target = (model: string): ModelRouterTarget => ({
  instanceId: ProviderInstanceId.make(`fixture-${model}`),
  model,
});
const catalog: ModelRouterInput["catalog"] = [
  {
    ...target("code"),
    driver: ProviderDriverKind.make("codex"),
    isDefault: false,
    capabilities: ["code", "tools"],
    availabilityReasons: [],
    metrics: {
      quality: { status: "unknown" },
      costUsd: { status: "known", value: 0.1 },
      latencyMs: { status: "known", value: 50 },
    },
  },
  {
    ...target("vision"),
    driver: ProviderDriverKind.make("claudeAgent"),
    isDefault: false,
    capabilities: ["code", "tools", "vision"],
    availabilityReasons: [],
    metrics: {
      quality: { status: "unknown" },
      costUsd: { status: "known", value: 0.4 },
      latencyMs: { status: "known", value: 100 },
    },
  },
  {
    ...target("context"),
    driver: ProviderDriverKind.make("opencode"),
    isDefault: false,
    capabilities: ["code", "tools", "long-context"],
    availabilityReasons: [],
    metrics: {
      quality: { status: "unknown" },
      costUsd: { status: "known", value: 0.2 },
      latencyMs: { status: "known", value: 20 },
    },
  },
];
const input = (
  capabilities: NonNullable<NonNullable<ModelRouterInput["task"]>["requiredCapabilities"]>,
  costWeight = 0,
  latencyWeight = 0,
): ModelRouterInput => ({
  mode: "auto",
  task: { attachmentCount: 0, composerContextKinds: [], requiredCapabilities: capabilities },
  constraints: { requiredCapabilities: capabilities },
  policy: { version: MODEL_ROUTER_POLICY_VERSION, qualityWeight: 0, costWeight, latencyWeight },
  catalog,
});

export const FIXED_TASK_CORPUS: FixedTaskCorpus = {
  id: "model-router-fixed-tasks",
  version: "1",
  cases: [
    {
      id: "code-tools",
      description: "Code work requires code and tools.",
      catalogEvidenceClass: "FIXTURE",
      input: input(["code", "tools"]),
      expected: target("code"),
    },
    {
      id: "image-attachment",
      description: "An image attachment explicitly requires vision.",
      catalogEvidenceClass: "FIXTURE",
      input: {
        ...input(["vision"]),
        task: {
          attachmentCount: 1,
          composerContextKinds: ["image"],
          requiredCapabilities: ["vision"],
        },
      },
      expected: target("vision"),
    },
    {
      id: "long-context",
      description: "Long context requires its advertised capability.",
      catalogEvidenceClass: "FIXTURE",
      input: input(["long-context"]),
      expected: target("context"),
    },
    {
      id: "cost-preference",
      description: "Known fixture cost receives policy weight, not a hard cost cap.",
      catalogEvidenceClass: "FIXTURE",
      input: input([], 1, 0),
      expected: target("code"),
    },
    {
      id: "latency-preference",
      description: "Known fixture latency receives policy weight, not a deadline.",
      catalogEvidenceClass: "FIXTURE",
      input: input([], 0, 1),
      expected: target("context"),
    },
    {
      id: "capability-unavailable",
      description: "The supplied catalog lacks required vision.",
      catalogEvidenceClass: "FIXTURE",
      input: { ...input(["vision"]), catalog: [catalog[0]!, catalog[2]!] },
      expected: null,
    },
    {
      id: "unknown-metrics",
      description: "Unknown metrics preserve the existing policy tie-break.",
      catalogEvidenceClass: "FIXTURE",
      input: {
        ...input([]),
        catalog: catalog.map((entry) => ({ ...entry, metrics: MODEL_ROUTER_UNKNOWN_METRICS })),
      },
      expected: target("code"),
    },
  ],
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = <T extends string>(values: ReadonlyArray<T>): ReadonlyArray<T> =>
  [...values].sort(compare);

/** Sort only order-independent router inputs; no eligibility or ranking is implemented here. */
const normalizedInput = (value: ModelRouterInput): ModelRouterInput => ({
  ...value,
  ...(value.task === undefined
    ? {}
    : {
        task: {
          ...value.task,
          ...(value.task.requiredCapabilities === undefined
            ? {}
            : { requiredCapabilities: sorted(value.task.requiredCapabilities) }),
          ...(value.task.composerContextKinds === undefined
            ? {}
            : { composerContextKinds: sorted(value.task.composerContextKinds) }),
        },
      }),
  ...(value.constraints === undefined
    ? {}
    : {
        constraints: Object.fromEntries(
          Object.entries(value.constraints).map(([key, list]) => [
            key,
            list === undefined ? undefined : sorted(list),
          ]),
        ),
      }),
  ...(value.preferredTargets === undefined
    ? {}
    : {
        preferredTargets: [...value.preferredTargets].sort((a, b) =>
          compare(modelRouterTargetKey(a), modelRouterTargetKey(b)),
        ),
      }),
  catalog: [...value.catalog]
    .sort((a, b) => compare(modelRouterTargetKey(a), modelRouterTargetKey(b)))
    .map((entry) => ({
      ...entry,
      capabilities: sorted(entry.capabilities),
      availabilityReasons: sorted(entry.availabilityReasons),
    })),
});

const unique = (ids: ReadonlyArray<string>, label: string) => {
  if (new Set(ids).size !== ids.length)
    throw new Error(`Duplicate ${label} makes corpus identity ambiguous.`);
};
const normalized = (corpus: FixedTaskCorpus): FixedTaskCorpus => {
  unique(
    corpus.cases.map((item) => item.id),
    "case id",
  );
  return {
    ...corpus,
    cases: [...corpus.cases]
      .sort((a, b) => compare(a.id, b.id))
      .map((item) => {
        // routeModel uses the first duplicate target; its order is therefore not irrelevant.
        unique(item.input.catalog.map(modelRouterTargetKey), "catalog target");
        unique(
          (item.measurements ?? []).map((record) => record.id),
          "measurement id",
        );
        return {
          ...item,
          input: normalizedInput(item.input),
          measurements: [...(item.measurements ?? [])].sort((a, b) => compare(a.id, b.id)),
        };
      }),
  };
};
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
export const fixedTaskCorpusHash = (corpus: FixedTaskCorpus): string =>
  NodeCrypto.createHash("sha256")
    .update(canonicalJson(normalized(corpus)))
    .digest("hex");

const sameTarget = (a: ModelRouterTarget | null, b: ModelRouterTarget | null) =>
  a === null || b === null ? a === b : modelRouterTargetKey(a) === modelRouterTargetKey(b);
const ratio = (id: string, numerator: number, denominator: number) => ({
  meaning: "fixture_policy_conformance" as const,
  evidenceClass: "FIXTURE" as const,
  metric: {
    id,
    numerator,
    denominator,
    sampleCount: denominator,
    status: denominator === 0 ? "unknown" : "reliable",
    provenance: "estimated",
    unit: "rate",
  } satisfies EvaluationMetricV0,
  rate: (denominator === 0
    ? { status: "unknown" }
    : { status: "known", value: numerator / denominator }) as ModelRouterMetricValue,
});

const isQuantity = Schema.is(MeasuredQuantityV0);
const aggregate = (records: ReadonlyArray<FixedTaskMeasurement>, unit: "usd" | "ms") => {
  const quantities = records.flatMap((record) => {
    const value = unit === "usd" ? record.cost : record.latency;
    const allowedSource =
      unit === "usd"
        ? value.source === "provider_reported"
        : ["monotonic_clock", "wall_clock", "provider_reported"].includes(value.source);
    return record.evidenceClass === "OBSERVED" &&
      isQuantity(value) &&
      value.status === "known" &&
      value.unit === unit &&
      value.provenance === "observed" &&
      allowedSource
      ? [value]
      : [];
  });
  const sampleCount = quantities.length;
  const status =
    sampleCount === 0
      ? "unknown"
      : unit === "ms" && sampleCount < HYBRID_MIN_SAMPLE_P90
        ? "insufficient"
        : "reliable";
  const values = quantities.map((item) => item.value).sort((a, b) => a - b);
  const value =
    unit === "usd"
      ? values.reduce((sum, next) => sum + next, 0)
      : values[Math.ceil(sampleCount * 0.9) - 1];
  const quantity: MeasuredQuantityV0 =
    status === "reliable" && value !== undefined && Number.isFinite(value)
      ? {
          status: "known",
          value,
          unit,
          source: unit === "usd" ? "provider_reported" : "user_explicit",
          provenance: "observed",
          observedAt: quantities
            .map((item) => item.observedAt)
            .sort(compare)
            .at(-1)!,
        }
      : unknownQuantity(unit);
  return {
    status: quantity.status === "unknown" && status === "reliable" ? "unknown" : status,
    quantity,
    sampleCount,
    excludedCount: records.length - sampleCount,
    aggregation:
      unit === "usd"
        ? "sum_of_qualified_observations"
        : "nearest_rank_p90_of_qualified_observations",
    reliableSampleThreshold: unit === "ms" ? HYBRID_MIN_SAMPLE_P90 : 1,
  };
};

export const runFixedTaskCorpus = (corpus: FixedTaskCorpus) => {
  const stable = normalized(corpus);
  const cases = stable.cases.map((item) => {
    const decision = routeModel(item.input);
    const selected = decision.selected?.target ?? null;
    const measurements = item.measurements ?? [];
    // Quantities without any recorded execution cannot be actual execution evidence.
    const qualifiedRecords = item.recordedExecutedTarget === undefined ? [] : measurements;
    return {
      ...item,
      measurements,
      decision,
      selected,
      explanation: decision.explanation,
      selectionCorrect: sameTarget(selected, item.expected),
      executionConsistency:
        item.recordedExecutedTarget === undefined
          ? ("unobserved" as const)
          : sameTarget(selected, item.recordedExecutedTarget)
            ? ("match" as const)
            : ("mismatch" as const),
      actualCost: aggregate(qualifiedRecords, "usd"),
      p90Latency: aggregate(qualifiedRecords, "ms"),
    };
  });
  const executed = cases.filter((item) => item.executionConsistency !== "unobserved");
  const records = cases.flatMap((item) =>
    item.recordedExecutedTarget === undefined ? [] : item.measurements,
  );
  return {
    id: stable.id,
    version: stable.version,
    contentHash: fixedTaskCorpusHash(stable),
    cases,
    selectionQuality: ratio(
      "selection_quality",
      cases.filter((item) => item.selectionCorrect).length,
      cases.length,
    ),
    executionConsistency: ratio(
      "execution_consistency",
      executed.filter((item) => item.executionConsistency === "match").length,
      executed.length,
    ),
    actualCost: aggregate(records, "usd"),
    p90Latency: aggregate(records, "ms"),
  };
};
