import type { ActionOutcomeClass, McpRetryPolicy } from "@t3tools/contracts";

export const MCP_FAILURE_CATEGORIES = [
  "transient_transport",
  "timeout",
  "cancelled",
  "policy_denial",
  "invalid_arguments",
  "unsafe_ambiguity",
  "tool_error",
] as const;
export type McpFailureCategory = (typeof MCP_FAILURE_CATEGORIES)[number];

export type McpCircuitState = {
  readonly failures: number;
  readonly openUntilMs: number;
};

export const emptyCircuit = (): McpCircuitState => ({ failures: 0, openUntilMs: 0 });

export const circuitIsOpen = (state: McpCircuitState, nowMs: number): boolean =>
  state.openUntilMs > nowMs;

export const recordCircuitSuccess = (): McpCircuitState => emptyCircuit();

export const recordCircuitFailure = (
  state: McpCircuitState,
  policy: McpRetryPolicy,
  nowMs: number,
): McpCircuitState => {
  const failures = state.failures + 1;
  return {
    failures,
    openUntilMs:
      failures >= policy.circuitBreakerThreshold ? nowMs + policy.cooldownMs : state.openUntilMs,
  };
};

export const shouldRetryMcpFailure = (input: {
  readonly category: McpFailureCategory;
  readonly attempt: number;
  readonly policy: McpRetryPolicy;
  readonly cancelled: boolean;
}): boolean => {
  if (input.cancelled) return false;
  if (input.attempt >= input.policy.maxAttempts) return false;
  if (input.policy.retryUnsafe) return false;
  return input.category === "transient_transport";
};

export const outcomeClassFromFailure = (
  category: McpFailureCategory | null,
  cancelled: boolean,
): ActionOutcomeClass => {
  if (cancelled || category === "cancelled") return "cancelled";
  if (category === "timeout") return "timeout";
  if (category === "policy_denial") return "denied";
  if (category === null) return "success";
  return "failure";
};

export const terminalOutcomeIsSuccess = (outcome: ActionOutcomeClass): boolean =>
  outcome === "success";

export type McpExecutionAttempt = {
  readonly attempt: number;
  readonly startedAtMs: number;
  readonly outcome: ActionOutcomeClass;
  readonly category?: McpFailureCategory;
  readonly circuitOpen?: boolean;
};

export const planMcpAttempts = (input: {
  readonly policy: McpRetryPolicy;
  readonly failures: ReadonlyArray<McpFailureCategory>;
  readonly cancelledAtAttempt?: number;
  readonly nowMs: number;
  readonly circuit?: McpCircuitState;
}): ReadonlyArray<McpExecutionAttempt> => {
  const attempts: McpExecutionAttempt[] = [];
  let circuit = input.circuit ?? emptyCircuit();
  for (let attempt = 0; attempt <= input.policy.maxAttempts; attempt += 1) {
    if (circuitIsOpen(circuit, input.nowMs)) {
      attempts.push({
        attempt,
        startedAtMs: input.nowMs,
        outcome: "circuit_open",
        circuitOpen: true,
      });
      break;
    }
    const cancelled = input.cancelledAtAttempt === attempt;
    const category = cancelled ? "cancelled" : (input.failures[attempt] ?? null);
    if (category === null) {
      attempts.push({ attempt, startedAtMs: input.nowMs, outcome: "success" });
      break;
    }
    const outcome = outcomeClassFromFailure(category, cancelled);
    attempts.push({ attempt, startedAtMs: input.nowMs, outcome, category });
    circuit = recordCircuitFailure(circuit, input.policy, input.nowMs);
    if (
      !shouldRetryMcpFailure({
        category,
        attempt: attempt + 1,
        policy: input.policy,
        cancelled,
      })
    ) {
      break;
    }
  }
  return attempts;
};
