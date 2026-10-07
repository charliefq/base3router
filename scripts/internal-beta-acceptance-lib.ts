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

export type PreservationKind =
  | "covered"
  | "structural-only"
  | "unsupported"
  | "blocked"
  | "limitation";

export type PreservationRow = {
  readonly id: string;
  readonly title: string;
  readonly kind: PreservationKind;
  readonly gateIds: ReadonlyArray<string>;
  readonly notes: string;
};

export const PRESERVATION_MATRIX: ReadonlyArray<PreservationRow> = [
  {
    id: "routing-outcome-capture",
    title: "Routing outcome capture",
    kind: "covered",
    gateIds: ["L-auto-manual"],
    notes:
      "Terminal V2 provider turns persist one observation keyed by environmentId:threadId:messageId. Unknown cost stays unknown.",
  },
  {
    id: "workflow-human-decisions",
    title: "Workflow human decisions",
    kind: "covered",
    gateIds: ["L-workflow", "L-ws-production"],
    notes:
      "Phase 5 catalog/read/action on the authenticated session. orchestration:read views a pending gate; orchestration:operate records approve, reject, or cancel.",
  },
  {
    id: "governed-dispatch",
    title: "Governed dispatch paths",
    kind: "covered",
    gateIds: ["L-auto-manual", "L-successor-ask", "L-mcp-ask"],
    notes:
      "One authorizeDispatch gate. Ordinary message.dispatch does not require an external-write approval. ASK applies to delegation, unattended schedules, and external-write MCP tools.",
  },
  {
    id: "terminal-confirmed-leases",
    title: "Terminal-confirmed leases",
    kind: "covered",
    gateIds: ["L-lease-terminal", "L-workload"],
    notes:
      "A slot stays occupied until a matching ingested terminal writes released_at. Local projection completed|failed|cancelled|interrupted|rolled_back does not free capacity.",
  },
  {
    id: "schema-import-recovery",
    title: "Schema import and recovery",
    kind: "covered",
    gateIds: ["L-recovery"],
    notes:
      "importBase3Policy maps a disposable Base3Router database into the V2 file. Approvals copy as stored. Ambiguous external outcomes are held, not replayed.",
  },
  {
    id: "production-browser-journeys",
    title: "Production-browser journeys",
    kind: "covered",
    gateIds: ["L-production-browser"],
    notes:
      "Composer Auto/Manual, ASK grant/deny/cancel/expiry, and Dream Memory against real RPC and disposable SQLite. Browser providers are fake transports, not live CLIs.",
  },
  {
    id: "sustained-workload",
    title: "Sustained fake-provider workload",
    kind: "covered",
    gateIds: ["L-workload"],
    notes:
      "Bounded 60-second overlapping FG/BG work, 50 cancel cycles, capacity bounds, and terminal-confirmed cleanup. testHarnessDurationMs is harness wall time, not application latency.",
  },
  {
    id: "ask-expiry-deadline",
    title: "ASK expiry deadline consistency",
    kind: "covered",
    gateIds: ["L-successor-ask", "L-production-browser"],
    notes:
      "Production authorizeTool/putApproval writes the same expiresAt onto expires_at and payload_json. expireIfDue reads payload_json.expiresAt. The browser expirePendingApprovals helper is a harness fixture that patches both fields; it is not a user-facing journey.",
  },
  {
    id: "ui-lab-structural",
    title: "L-ui-lab structural check",
    kind: "structural-only",
    gateIds: ["L-ui-lab"],
    notes:
      "Confirms V1 UI Lab files are absent and V2 Inspector/Control Center mounts exist. It is not a behavioral substitute for production-browser or RPC gates.",
  },
  {
    id: "fake-transports",
    title: "Browser providers are fake transports",
    kind: "limitation",
    gateIds: ["L-production-browser", "L-workload"],
    notes:
      "Production-browser pins fake Codex/Claude absolute binaryPath values. The 60-second workload uses in-process fake turns. Neither is a live provider CLI.",
  },
  {
    id: "openrouter-no-driver",
    title: "OpenRouter has no executable driver",
    kind: "unsupported",
    gateIds: ["L-auto-manual", "L-production-browser"],
    notes:
      "Guidance / Teacher / Shadow only on this pin. Control Center must disclose that OpenRouter cannot execute product sessions.",
  },
  {
    id: "cursor-cloud-fail-closed",
    title: "Cursor Cloud REST is fail-closed for product sessions",
    kind: "unsupported",
    gateIds: ["L-auto-manual", "L-workflow"],
    notes:
      "Not a second engine. Product sessions fail that path closed. Explicit handoff remains the provider-switch contract.",
  },
  {
    id: "unconfirmed-lease-pin",
    title: "Unconfirmed disconnects and missing runId can leave leases pinned",
    kind: "limitation",
    gateIds: ["L-lease-terminal"],
    notes:
      "A closed event stream without confirmProviderTermination leaves the slot occupied. ProviderRuntimeRecoveryService can terminalize projection runs without releasing the lease. A missing runId or run_id IS NULL stays pinned.",
  },
  {
    id: "live-provider",
    title: "Live paid providers",
    kind: "blocked",
    gateIds: ["E-live-provider"],
    notes: "E-live-provider remains BLOCKED. No paid calls in Task 3A.",
  },
  {
    id: "native-signing",
    title: "Native install and signing",
    kind: "blocked",
    gateIds: ["E-native-signing"],
    notes: "E-native-signing remains BLOCKED. No native-release readiness in Task 3A.",
  },
];

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
        "apps/server/src/policy/Base3Policy.continuingProvider.test.ts",
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
    title:
      "Scheduler occupancy plus bounded 60-second fake-provider workload with 50 cancel cycles",
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
    id: "L-workflow",
    requirementIds: ["O1", "R4"],
    title: "Workflow Phase 5 human decisions on the authenticated V2 session",
    requiredLocal: true,
    command: {
      kind: "vp-test",
      files: [
        "apps/server/src/workflow/Workflow.rpc.test.ts",
        "apps/server/src/auth/RpcAuthorization.test.ts",
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
    title: "V1 UI Lab is not a second engine; V2 governance surfaces are mounted (structural only)",
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
