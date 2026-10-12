/** Fixture-only executor contract. No provider, RPC transport, live slot or application DB. */
const fail = (reason) => {
  throw new Error(reason);
};
const text = (value) => typeof value === "string" && value.trim().length > 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const unknown = (reason) => ({ status: "unknown", reason });
const blocked = (reason) => ({ status: "blocked", reason });
const fields = [
  "dispatchId",
  "taskId",
  "workerId",
  "startingSha",
  "environmentId",
  "principalId",
  "projectId",
  "runId",
  "stageId",
  "providerInstanceId",
  "model",
];

function bindingFor(input) {
  if (
    !input ||
    !fields.every((key) => text(input[key])) ||
    !/^[a-f0-9]{40}$/.test(input.startingSha) ||
    !Number.isSafeInteger(input.attempt) ||
    input.attempt < 1
  )
    fail("invalid-executor-binding");
  // These follow Workflow/ThreadLaunch's durable command identities. JSON-RPC
  // request IDs are deliberately neither accepted nor used as a fallback.
  return {
    ...Object.fromEntries(fields.map((key) => [key, input[key]])),
    attempt: input.attempt,
    commandId: `workflow-create-${input.dispatchId}`,
    threadId: `workflow-${input.dispatchId}`,
    messageId: `workflow-message-${input.dispatchId}`,
    stageCommandId: `workflow-dispatch-${input.dispatchId}`,
  };
}

function receiptFor(binding, ack) {
  if (!ack || !text(ack.nativeThreadId) || !text(ack.nativeTurnId)) return null;
  if (!same(bindingFor(ack.binding), binding)) fail("executor-ack-binding-conflict");
  if (
    ["commandId", "threadId", "messageId", "stageCommandId"].some(
      (key) => ack.binding[key] !== binding[key],
    )
  )
    fail("executor-ack-command-conflict");
  if (!text(ack.url)) return null;
  return {
    taskId: binding.taskId,
    workerId: binding.workerId,
    startingSha: binding.startingSha,
    dispatchId: binding.dispatchId,
    url: ack.url,
    executorBinding: binding,
    nativeThreadId: ack.nativeThreadId,
    nativeTurnId: ack.nativeTurnId,
  };
}

function resultFor(binding, receipt, result) {
  if (!result || !text(result.nativeThreadId) || !text(result.nativeTurnId)) return null;
  if (
    !same(bindingFor(result.binding), binding) ||
    result.dispatchId !== binding.dispatchId ||
    result.nativeThreadId !== receipt.nativeThreadId ||
    result.nativeTurnId !== receipt.nativeTurnId
  )
    fail("executor-result-binding-conflict");
  if (!["completed", "failed", "interrupted"].includes(result.outcome)) return null;
  return {
    binding,
    dispatchId: binding.dispatchId,
    nativeThreadId: result.nativeThreadId,
    nativeTurnId: result.nativeTurnId,
    outcome: result.outcome,
  };
}

/** Inject only controlled fake services. An absent lookup stays blocked, never a retry-send. */
export function createFixtureExecutor({ receiptStore, launch, findLaunch, fault = () => {} }) {
  const read = (binding) => {
    const snapshot = receiptStore.snapshot();
    const entry = snapshot.journal.entries.find(
      (item) => item.kind === "start" && item.id === binding.dispatchId,
    );
    if (entry) {
      // The shared journal freezes its core binding/receipt; this wrapper owns
      // validation of the extra executor binding, stage and result fields.
      if (entry.executor?.version !== 1 || !same(entry.executor.binding, binding))
        fail("executor-dispatch-binding-conflict");
      if (
        !["pending", "recorded"].includes(entry.executor.stage) ||
        (entry.executor.stage === "recorded" && entry.state !== "confirmed") ||
        (entry.executor.result !== null && entry.executor.stage !== "recorded")
      )
        fail("invalid-executor-record");
      if (entry.state === "confirmed") {
        const receipt = entry.receipt;
        const expected = receiptFor(binding, {
          binding: receipt.executorBinding,
          nativeThreadId: receipt.nativeThreadId,
          nativeTurnId: receipt.nativeTurnId,
          url: receipt.url,
        });
        if (!expected || !same(expected, receipt)) fail("invalid-executor-receipt");
        if (entry.executor.result !== null) {
          const result = resultFor(binding, receipt, entry.executor.result);
          if (!result || !same(result, entry.executor.result)) fail("invalid-executor-result");
        }
      }
    }
    // Distinct dispatch IDs cannot claim the same environment/project stage attempt.
    for (const other of snapshot.journal.entries) {
      if (other.kind !== "start" || other.id === binding.dispatchId || !other.executor) continue;
      if (
        ["environmentId", "projectId", "runId", "stageId", "attempt"].every(
          (key) => other.executor.binding?.[key] === binding[key],
        )
      )
        fail("executor-stage-already-claimed");
    }
    return { ...snapshot, entry };
  };
  const write = (snapshot, entry) => receiptStore.record({ expected: snapshot.token, entry });
  const bindStage = (binding) => {
    const snapshot = read(binding);
    if (snapshot.entry?.state !== "confirmed") return unknown("launch-not-confirmed");
    if (snapshot.entry.executor.stage !== "recorded") {
      fault("before-stage-record");
      write(snapshot, {
        ...snapshot.entry,
        executor: { ...snapshot.entry.executor, stage: "recorded" },
      });
    }
    return { status: "bound", receipt: structuredClone(snapshot.entry.receipt) };
  };
  const confirm = (binding, ack) => {
    const receipt = receiptFor(binding, ack);
    if (!receipt) return unknown("native-launch-identity-missing");
    const snapshot = read(binding);
    if (!snapshot.entry) fail("executor-intent-missing");
    if (snapshot.entry.state === "confirmed") {
      if (!same(snapshot.entry.receipt, receipt)) fail("executor-native-identity-conflict");
    } else write(snapshot, { ...snapshot.entry, state: "confirmed", receipt });
    return bindStage(binding);
  };
  return {
    async dispatch(input) {
      const binding = bindingFor(input);
      const snapshot = read(binding);
      if (snapshot.entry?.state === "confirmed") return bindStage(binding);
      let ack;
      if (snapshot.entry) {
        if (typeof findLaunch !== "function") return blocked("executor-lookup-unavailable");
        try {
          ack = await findLaunch(structuredClone(binding));
        } catch {
          return unknown("executor-lookup-failed");
        }
      } else {
        if (typeof launch !== "function") return blocked("fixture-launch-unavailable");
        write(snapshot, {
          kind: "start",
          id: binding.dispatchId,
          binding: {
            taskId: binding.taskId,
            workerId: binding.workerId,
            startingSha: binding.startingSha,
          },
          state: "pending",
          receipt: null,
          executor: { version: 1, binding, stage: "pending", result: null },
        });
        fault("after-intent-record");
        try {
          ack = await launch(structuredClone(binding));
        } catch {
          return unknown("launch-ack-lost");
        }
        fault("after-launch");
      }
      return confirm(binding, ack);
    },
    observeResult(input, result) {
      const binding = bindingFor(input);
      const snapshot = read(binding);
      if (snapshot.entry?.state !== "confirmed" || snapshot.entry.executor.stage !== "recorded")
        return unknown("stage-not-bound");
      if (!result || !text(result.nativeThreadId) || !text(result.nativeTurnId))
        return unknown("native-result-identity-missing");
      const observed = resultFor(binding, snapshot.entry.receipt, result);
      if (!observed) return unknown("result-not-terminal");
      const existing = snapshot.entry.executor.result;
      if (existing !== null && !same(existing, observed)) fail("executor-result-conflict");
      if (existing === null)
        write(snapshot, {
          ...snapshot.entry,
          executor: { ...snapshot.entry.executor, result: observed },
        });
      return { status: "observed", result: observed };
    },
  };
}
