// Typed Internal Beta acceptance manifest. Commands are fixed here.
// Never parse or execute shell from Markdown.

export const EVIDENCE_SCHEMA_VERSION = "internal-beta-evidence.v1" as const;

export type GateStatus = "PASS" | "FAIL" | "NOT_RUN" | "BLOCKED";

export type Verdict = "LOCAL_STABILIZATION_VERIFIED" | "STABILIZATION_BLOCKED";

export type GateCommand =
  | {
      readonly kind: "vp-test";
      readonly files: ReadonlyArray<string>;
      readonly testNamePattern?: string;
    }
  | {
      readonly kind: "node-script";
      readonly script: string;
      readonly args?: ReadonlyArray<string>;
    }
  | {
      readonly kind: "external";
      readonly gate: "live-provider" | "native-signing";
    };

export type GateDefinition = {
  readonly id: string;
  readonly requirementIds: ReadonlyArray<string>;
  readonly title: string;
  readonly requiredLocal: boolean;
  readonly command: GateCommand;
};

export type GateEvidence = {
  readonly id: string;
  readonly requirementIds: ReadonlyArray<string>;
  readonly title: string;
  readonly requiredLocal: boolean;
  readonly status: GateStatus;
  readonly argv: ReadonlyArray<string>;
  readonly exitCode: number | null;
  readonly evidencePath: string | null;
  readonly detail: string;
};

export type EvidenceDocument = {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly sha: string;
  readonly dirty: boolean;
  readonly recordedAt: string;
  readonly gates: ReadonlyArray<GateEvidence>;
  readonly verdict: Verdict;
};

export const GATES: ReadonlyArray<GateDefinition> = [
  {
    id: "L-lease-terminal",
    requirementIds: ["R6", "O6"],
    title: "Foreground lease spans terminal execution; unconfirmed stream-end keeps the slot",
    requiredLocal: true,
    command: {
      kind: "vp-test",
      files: [
        "apps/server/src/concurrencyBudget/awaitTurnTerminal.test.ts",
        "apps/server/src/policy/Base3Policy.integration.test.ts",
      ],
    },
  },
  {
    id: "L-successor-ask",
    requirementIds: ["R16", "R2", "R3"],
    title: "Successor ASK is explicit, action-bound, and bounded",
    requiredLocal: true,
    command: {
      kind: "vp-test",
      files: [
        "apps/server/src/actionGate/ActionGateService.test.ts",
        "apps/server/src/policy/Base3Policy.integration.test.ts",
      ],
    },
  },
  {
    id: "L-mcp-ask",
    requirementIds: ["R2", "O2"],
    title: "MCP ASK through production ActionGate",
    requiredLocal: true,
    command: {
      kind: "vp-test",
      files: ["apps/server/src/mcp/McpHttpServer.productionAsk.test.ts"],
    },
  },
  {
    id: "L-recovery",
    requirementIds: ["R9", "R10", "R11", "R12"],
    title: "File-backed restart, backup restore, and non-colliding schema import",
    requiredLocal: true,
    command: {
      kind: "vp-test",
      files: [
        "apps/server/src/policy/Base3Policy.integration.test.ts",
        "apps/server/src/policy/Base3Policy.recovery.test.ts",
      ],
    },
  },
  {
    id: "L-workload",
    requirementIds: ["R6"],
    title: "Scheduler occupancy plus bounded 60-second fake-provider workload",
    requiredLocal: true,
    command: {
      kind: "vp-test",
      files: [
        "apps/server/src/concurrencyBudget/ConcurrencyBudget.workload.test.ts",
        "apps/server/src/concurrencyBudget/ConcurrencyBudget.sustainedWorkload.test.ts",
      ],
    },
  },
  {
    id: "L-auto-manual",
    requirementIds: ["R1", "O1"],
    title: "Auto/Manual bind, immutable route, and failover provenance on the V2 gate",
    requiredLocal: true,
    command: {
      kind: "vp-test",
      files: [
        "apps/server/src/dispatcher/Dispatcher.test.ts",
        "apps/server/src/routerEvaluation/RouterEvaluationService.test.ts",
        "apps/server/src/routerEvaluation/persistTurnOutcome.test.ts",
        "apps/server/src/routerEvaluation/persistTurnOutcome.v2.test.ts",
        "apps/server/src/policy/Base3Policy.dispatch.test.ts",
      ],
    },
  },
  {
    id: "L-ws-production",
    requirementIds: ["O1", "O5", "O6", "R4", "R5", "R7"],
    title: "Production governance snapshot for Inspector, memory, and route state",
    requiredLocal: true,
    command: {
      kind: "vp-test",
      files: ["apps/server/src/policy/GovernanceProjection.test.ts"],
      testNamePattern: "Internal Beta",
    },
  },
  {
    id: "L-checker",
    requirementIds: ["R13"],
    title: "Acceptance checker rejects missing, stale, failed, and wrong-tree evidence",
    requiredLocal: true,
    command: {
      kind: "vp-test",
      files: ["scripts/internal-beta-acceptance.test.ts"],
    },
  },
  {
    id: "L-production-browser",
    requirementIds: ["R7", "O5"],
    title: "Production web UI against real RPC, disposable SQLite, and fake transports",
    requiredLocal: true,
    command: {
      kind: "node-script",
      script: "scripts/internal-beta-production-browser.ts",
    },
  },
  {
    id: "L-ui-lab",
    requirementIds: ["R13"],
    title: "V1 UI Lab is not a second engine; V2 governance surfaces are mounted",
    requiredLocal: false,
    command: {
      kind: "node-script",
      script: "scripts/v2-governance-surfaces.ts",
    },
  },
  {
    id: "E-live-provider",
    requirementIds: ["R14", "O3"],
    title: "Live paid providers",
    requiredLocal: false,
    command: { kind: "external", gate: "live-provider" },
  },
  {
    id: "E-native-signing",
    requirementIds: ["R15", "O4"],
    title: "Native install and signing",
    requiredLocal: false,
    command: { kind: "external", gate: "native-signing" },
  },
];

export const argvFor = (
  command: GateCommand,
  repoRoot: string,
): { readonly argv: ReadonlyArray<string> } | { readonly blocked: string } => {
  switch (command.kind) {
    case "vp-test": {
      const argv = ["vp", "test", "run", ...command.files];
      if (command.testNamePattern !== undefined) {
        argv.push("--", "--testNamePattern", command.testNamePattern);
      }
      return { argv };
    }
    case "node-script":
      return {
        argv: ["node", `${repoRoot}/${command.script}`, ...(command.args ?? [])],
      };
    case "external":
      return {
        blocked:
          command.gate === "live-provider"
            ? "Live paid-provider calls are not authorized."
            : "Native install/signing is not authorized.",
      };
  }
};

export const verdictFor = (gates: ReadonlyArray<GateEvidence>): Verdict => {
  const required = gates.filter((gate) => gate.requiredLocal);
  return required.every((gate) => gate.status === "PASS")
    ? "LOCAL_STABILIZATION_VERIFIED"
    : "STABILIZATION_BLOCKED";
};

export const checkEvidence = (input: {
  readonly evidence: unknown;
  readonly currentSha: string;
  readonly dirty: boolean;
}): {
  readonly ok: boolean;
  readonly verdict: Verdict;
  readonly detail: string;
  readonly evidence?: EvidenceDocument;
} => {
  const document = input.evidence as Partial<EvidenceDocument> | null;
  if (document === null || typeof document !== "object") {
    return { ok: false, verdict: "STABILIZATION_BLOCKED", detail: "Evidence document is missing." };
  }
  if (document.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    return {
      ok: false,
      verdict: "STABILIZATION_BLOCKED",
      detail: "Evidence schema is missing or unsupported.",
    };
  }
  if (document.sha !== input.currentSha) {
    return {
      ok: false,
      verdict: "STABILIZATION_BLOCKED",
      detail: `Evidence SHA ${String(document.sha)} does not match tree ${input.currentSha}.`,
    };
  }
  if (document.dirty !== input.dirty) {
    return {
      ok: false,
      verdict: "STABILIZATION_BLOCKED",
      detail: "Evidence dirty-tree flag does not match the current working tree.",
    };
  }
  const gates = document.gates;
  if (!Array.isArray(gates) || gates.length === 0) {
    return { ok: false, verdict: "STABILIZATION_BLOCKED", detail: "Evidence has no gates." };
  }
  const requiredIds = new Set(GATES.filter((gate) => gate.requiredLocal).map((gate) => gate.id));
  const present = new Set(gates.map((gate) => gate.id));
  for (const id of requiredIds) {
    if (!present.has(id)) {
      return {
        ok: false,
        verdict: "STABILIZATION_BLOCKED",
        detail: `Required local gate ${id} is missing from evidence.`,
      };
    }
  }
  const required = gates.filter((gate) => gate.requiredLocal);
  const failed = required.find((gate) => gate.status !== "PASS");
  if (failed !== undefined) {
    return {
      ok: false,
      verdict: "STABILIZATION_BLOCKED",
      detail: `Required local gate ${failed.id} is ${failed.status}.`,
    };
  }
  if (document.verdict !== "LOCAL_STABILIZATION_VERIFIED") {
    return {
      ok: false,
      verdict: "STABILIZATION_BLOCKED",
      detail: "Evidence verdict is not LOCAL_STABILIZATION_VERIFIED.",
    };
  }
  return {
    ok: true,
    verdict: "LOCAL_STABILIZATION_VERIFIED",
    detail: "Evidence matches the current tree and required local gates passed.",
    evidence: document as EvidenceDocument,
  };
};
