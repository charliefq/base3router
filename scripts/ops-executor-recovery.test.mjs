import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, assert, describe, it } from "vite-plus/test";
import { createReceiptStore, openReceiptStore } from "./ops-receipt-store.mjs";
import { createFixtureExecutor } from "./ops-executor-recovery.mjs";

const input = {
  dispatchId: "durable-dispatch-1",
  taskId: "fixture-task",
  workerId: "fixture-worker",
  startingSha: "a".repeat(40),
  environmentId: "fixture-environment",
  principalId: "fixture-principal",
  projectId: "fixture-project",
  runId: "fixture-run",
  stageId: "fixture-stage",
  attempt: 1,
  providerInstanceId: "fixture-provider",
  model: "fixture-model",
};
const ackFor = (binding) => ({
  binding,
  nativeThreadId: "native-thread-1",
  nativeTurnId: "native-turn-1",
  url: "https://example.invalid/fixture-launch",
});
const resultFor = (ack, outcome = "completed") => ({
  binding: ack.binding,
  dispatchId: ack.binding.dispatchId,
  nativeThreadId: ack.nativeThreadId,
  nativeTurnId: ack.nativeTurnId,
  outcome,
});
const parents = [];
afterEach(() => {
  for (const parent of parents.splice(0)) NodeFS.rmSync(parent, { recursive: true, force: true });
});
function fixture() {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "executor-recovery-test-"));
  parents.push(parent);
  const store = createReceiptStore({ parentDirectory: parent });
  const acknowledgments = new Map();
  let launches = 0;
  let lookups = 0;
  const launch = async (binding) => {
    launches++;
    // A fake command receipt is saved before returning, just as an accepted
    // ThreadLaunch command can survive loss of its caller's acknowledgment.
    const ack = ackFor(binding);
    acknowledgments.set(binding.dispatchId, ack);
    return ack;
  };
  const findLaunch = async (binding) => {
    lookups++;
    return acknowledgments.get(binding.dispatchId) ?? null;
  };
  const reopen = () => openReceiptStore({ directory: store.directory, storeId: store.storeId });
  return {
    store,
    reopen,
    launch,
    findLaunch,
    acknowledgments,
    counts: () => ({ launches, lookups }),
    executor: (options = {}) =>
      createFixtureExecutor({ receiptStore: reopen(), launch, findLaunch, ...options }),
  };
}

describe("isolated executor mapping and recovery", () => {
  it("persists intent before launch, then binds native identity and stage across reopen", async () => {
    const f = fixture();
    const first = await f
      .executor({
        launch: (binding) => {
          const entry = f.reopen().read().entries[0];
          assert.equal(entry.state, "pending");
          assert.equal(entry.executor.stage, "pending");
          assert.equal(binding.commandId, `workflow-create-${input.dispatchId}`);
          assert.equal(binding.threadId, `workflow-${input.dispatchId}`);
          assert.equal(binding.messageId, `workflow-message-${input.dispatchId}`);
          assert.equal(binding.stageCommandId, `workflow-dispatch-${input.dispatchId}`);
          return f.launch(binding);
        },
      })
      .dispatch(input);
    assert.equal(first.status, "bound");
    assert.equal(first.receipt.nativeThreadId, "native-thread-1");
    assert.equal(first.receipt.nativeTurnId, "native-turn-1");
    assert.equal(f.reopen().read().entries[0].executor.stage, "recorded");
    const token = f.reopen().snapshot().token;
    assert.deepEqual(await f.executor().dispatch(input), first);
    assert.deepEqual(f.reopen().snapshot().token, token);
    assert.deepEqual(f.counts(), { launches: 1, lookups: 0 });
  });

  it.each(["after-intent-record", "after-launch", "before-stage-record"])(
    "recovers the %s window without relaunching",
    async (point) => {
      const f = fixture();
      await NodeAssert.rejects(
        f
          .executor({
            fault: (at) => {
              if (at === point) throw new Error("simulated-crash");
            },
          })
          .dispatch(input),
        /simulated-crash/,
      );
      const entry = f.reopen().read().entries[0];
      assert.equal(entry.executor.stage, "pending");
      const result = await f.executor().dispatch(input);
      assert.equal(result.status, point === "after-intent-record" ? "unknown" : "bound");
      assert.equal(f.counts().launches, point === "after-intent-record" ? 0 : 1);
      assert.equal(f.counts().lookups, point === "before-stage-record" ? 0 : 1);
      if (point === "after-intent-record") {
        await f.executor().dispatch(input);
        assert.equal(f.counts().launches, 0);
      }
    },
  );

  it("recovers a lost launch ACK by explicit fake command lookup", async () => {
    const f = fixture();
    const result = await f
      .executor({
        launch: async (binding) => {
          await f.launch(binding);
          throw new Error("transport-disconnected");
        },
      })
      .dispatch(input);
    assert.deepEqual(result, { status: "unknown", reason: "launch-ack-lost" });
    assert.equal(f.reopen().read().entries[0].state, "pending");
    assert.equal((await f.executor().dispatch(input)).status, "bound");
    assert.deepEqual(f.counts(), { launches: 1, lookups: 1 });
  });

  it("requires replay of an early terminal result after a lost ACK is recovered", async () => {
    const f = fixture();
    await f
      .executor({
        launch: async (binding) => {
          await f.launch(binding);
          throw new Error("lost-ack");
        },
      })
      .dispatch(input);
    const result = resultFor(f.acknowledgments.get(input.dispatchId));
    const token = f.reopen().snapshot().token;
    assert.equal(f.executor().observeResult(input, result).status, "unknown");
    assert.deepEqual(f.reopen().snapshot().token, token);
    await f.executor().dispatch(input);
    assert.equal(f.executor().observeResult(input, result).status, "observed");
    assert.equal(f.counts().launches, 1);
  });

  it("does not adopt a legacy receipt without a proven executor mapping", async () => {
    const f = fixture();
    f.store.record({
      expected: f.store.snapshot().token,
      entry: {
        kind: "start",
        id: input.dispatchId,
        state: "pending",
        receipt: null,
        binding: { taskId: input.taskId, workerId: input.workerId, startingSha: input.startingSha },
      },
    });
    await NodeAssert.rejects(f.executor().dispatch(input), /executor-dispatch-binding-conflict/);
    assert.deepEqual(f.counts(), { launches: 0, lookups: 0 });
  });

  it("does not pretend that a production lookup capability exists", async () => {
    const f = fixture();
    await f.executor({ launch: async () => null }).dispatch(input);
    const token = f.reopen().snapshot().token;
    assert.deepEqual(await f.executor({ findLaunch: undefined }).dispatch(input), {
      status: "blocked",
      reason: "executor-lookup-unavailable",
    });
    assert.deepEqual(f.reopen().snapshot().token, token);
    assert.equal(f.counts().launches, 0);
  });

  it("requires an explicitly injected fake launch before reserving a dispatch", async () => {
    const f = fixture();
    assert.equal((await f.executor({ launch: undefined }).dispatch(input)).status, "blocked");
    assert.equal(f.reopen().read().entries.length, 0);
  });

  it.each(["nativeThreadId", "nativeTurnId", "url"])(
    "keeps missing %s unknown until a full matching lookup, without resend",
    async (key) => {
      const f = fixture();
      assert.equal(
        (
          await f
            .executor({
              launch: async (binding) => ({ ...(await f.launch(binding)), [key]: null }),
            })
            .dispatch(input)
        ).status,
        "unknown",
      );
      assert.equal(f.reopen().read().entries[0].state, "pending");
      assert.equal((await f.executor().dispatch(input)).status, "bound");
      assert.equal(f.counts().launches, 1);
    },
  );

  it("never treats a JSON-RPC request ID or accepted command alone as a native launch", async () => {
    const f = fixture();
    await NodeAssert.rejects(
      f.executor().dispatch({ ...input, dispatchId: undefined, id: 1 }),
      /invalid-executor-binding/,
    );
    await NodeAssert.rejects(
      f.executor().dispatch({ ...input, dispatchId: 1 }),
      /invalid-executor-binding/,
    );
    assert.equal(f.reopen().read().entries.length, 0);
    assert.equal(
      (
        await f
          .executor({ launch: async () => ({ id: 1, result: { sequence: 12 } }) })
          .dispatch(input)
      ).status,
      "unknown",
    );
    assert.equal((await f.executor().dispatch(input)).status, "unknown");
    assert.equal(f.counts().launches, 0);
  });

  it.each([
    "environmentId",
    "principalId",
    "projectId",
    "runId",
    "stageId",
    "attempt",
    "providerInstanceId",
    "model",
    "taskId",
    "workerId",
    "startingSha",
  ])("rejects reuse of a durable dispatch with another %s", async (key) => {
    const f = fixture();
    await f.executor().dispatch(input);
    const value = key === "attempt" ? 2 : key === "startingSha" ? "b".repeat(40) : "other";
    await NodeAssert.rejects(
      f.executor().dispatch({ ...input, [key]: value }),
      /executor-dispatch-binding-conflict/,
    );
    assert.deepEqual(f.counts(), { launches: 1, lookups: 0 });
  });

  it("rejects two dispatch IDs claiming the same stage attempt", async () => {
    const f = fixture();
    await f.executor().dispatch(input);
    await NodeAssert.rejects(
      f.executor().dispatch({ ...input, dispatchId: "different-dispatch" }),
      /executor-stage-already-claimed/,
    );
    assert.equal(f.counts().launches, 1);
  });

  it.each(["environmentId", "commandId"])("rejects a lookup ACK for another %s", async (key) => {
    const f = fixture();
    await f.executor({ launch: async () => null }).dispatch(input);
    const binding = f.reopen().read().entries[0].executor.binding;
    await NodeAssert.rejects(
      f
        .executor({ findLaunch: async () => ackFor({ ...binding, [key]: "different" }) })
        .dispatch(input),
      /executor-ack-(binding|command)-conflict/,
    );
    assert.equal(f.reopen().read().entries[0].state, "pending");
    assert.equal(f.counts().launches, 0);
  });

  it("lookup errors and an uncertain receipt never authorize another launch", async () => {
    const f = fixture();
    await f.executor({ launch: async () => null }).dispatch(input);
    const snapshot = f.reopen().snapshot();
    f.store.record({
      expected: snapshot.token,
      entry: { ...snapshot.journal.entries[0], state: "uncertain" },
    });
    assert.deepEqual(
      await f
        .executor({
          findLaunch: async () => {
            throw new Error("unavailable");
          },
        })
        .dispatch(input),
      {
        status: "unknown",
        reason: "executor-lookup-failed",
      },
    );
    assert.equal((await f.executor().dispatch(input)).status, "unknown");
    assert.equal(f.reopen().read().entries[0].state, "uncertain");
    assert.equal(f.counts().launches, 0);
  });

  it("two concurrent claimants launch once even while the first ACK is delayed", async () => {
    const f = fixture();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const first = f
      .executor({
        launch: async (binding) => {
          await gate;
          return f.launch(binding);
        },
      })
      .dispatch(input);
    assert.equal((await f.executor().dispatch(input)).status, "unknown");
    release();
    assert.equal((await first).status, "bound");
    assert.equal((await f.executor().dispatch(input)).status, "bound");
    assert.deepEqual(f.counts(), { launches: 1, lookups: 1 });
  });

  it("a stale claim token fails before launch and preserves the winning intent", async () => {
    const f = fixture();
    const stale = f.reopen().snapshot();
    await f.executor().dispatch(input);
    const token = f.reopen().snapshot().token;
    await NodeAssert.rejects(
      f
        .executor({
          receiptStore: { snapshot: () => stale, record: (write) => f.store.record(write) },
        })
        .dispatch(input),
      /receipt-cas-conflict/,
    );
    assert.deepEqual(f.reopen().snapshot().token, token);
    assert.equal(f.counts().launches, 1);
  });

  it("rejects conflicting native ACKs racing a successful lookup", async () => {
    const f = fixture();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const first = f
      .executor({
        launch: async (binding) => {
          const ack = await f.launch(binding);
          await gate;
          return { ...ack, nativeTurnId: "conflicting-turn" };
        },
      })
      .dispatch(input);
    assert.equal((await f.executor().dispatch(input)).status, "bound");
    release();
    await NodeAssert.rejects(first, /executor-native-identity-conflict/);
    assert.equal(f.reopen().read().entries[0].receipt.nativeTurnId, "native-turn-1");
    assert.equal(f.counts().launches, 1);
  });

  it("does not promote a result before ACK or stage persistence; replay after binding is idempotent", async () => {
    const f = fixture();
    const executor = f.executor({
      fault: (point) => {
        if (point === "before-stage-record") throw new Error("crash");
      },
    });
    assert.deepEqual(executor.observeResult(input, {}), {
      status: "unknown",
      reason: "stage-not-bound",
    });
    await NodeAssert.rejects(executor.dispatch(input), /crash/);
    const result = resultFor(f.acknowledgments.get(input.dispatchId));
    assert.equal(executor.observeResult(input, result).status, "unknown");
    assert.equal(f.reopen().read().entries[0].executor.result, null);
    await f.executor().dispatch(input);
    assert.equal(f.executor().observeResult(input, result).status, "observed");
    const token = f.reopen().snapshot().token;
    assert.equal(f.executor().observeResult(input, result).status, "observed");
    assert.deepEqual(f.reopen().snapshot().token, token);
    assert.equal(f.counts().launches, 1);
  });

  it.each(["nativeThreadId", "nativeTurnId", "dispatchId"])(
    "rejects a terminal result with conflicting %s",
    async (key) => {
      const f = fixture();
      await f.executor().dispatch(input);
      const result = resultFor(f.acknowledgments.get(input.dispatchId));
      assert.throws(
        () => f.executor().observeResult(input, { ...result, [key]: "other" }),
        /executor-result-binding-conflict/,
      );
      assert.equal(f.reopen().read().entries[0].executor.result, null);
    },
  );

  it("rejects result scope conflicts and preserves a terminal result against older/nonterminal or conflicting events", async () => {
    const f = fixture();
    await f.executor().dispatch(input);
    const result = resultFor(f.acknowledgments.get(input.dispatchId));
    assert.throws(
      () =>
        f.executor().observeResult(input, {
          ...result,
          binding: { ...result.binding, environmentId: "other" },
        }),
      /executor-result-binding-conflict/,
    );
    assert.equal(
      f.executor().observeResult(input, { ...result, nativeTurnId: null }).status,
      "unknown",
    );
    f.executor().observeResult(input, result);
    assert.equal(
      f.executor().observeResult(input, { ...result, outcome: "inProgress" }).status,
      "unknown",
    );
    assert.throws(
      () => f.executor().observeResult(input, { ...result, outcome: "failed" }),
      /executor-result-conflict/,
    );
    assert.equal(f.reopen().read().entries[0].executor.result.outcome, "completed");
  });

  it.each(["commandId", "threadId", "messageId", "stageCommandId"])(
    "rejects a result contradicting its durable %s",
    async (key) => {
      const f = fixture();
      await f.executor().dispatch(input);
      const result = resultFor(f.acknowledgments.get(input.dispatchId));
      assert.throws(
        () =>
          f.executor().observeResult(input, {
            ...result,
            binding: { ...result.binding, [key]: "conflicting-command" },
          }),
        /executor-result-binding-conflict/,
      );
      assert.equal(f.reopen().read().entries[0].executor.result, null);
    },
  );

  it("fails closed on missing, locked or corrupt storage without calling services", async () => {
    for (const damage of ["missing", "locked", "corrupt"]) {
      const f = fixture();
      const journal = NodePath.join(f.store.directory, "journal.json");
      if (damage === "missing") NodeFS.unlinkSync(journal);
      if (damage === "corrupt") NodeFS.writeFileSync(journal, "{");
      if (damage === "locked")
        NodeFS.writeFileSync(NodePath.join(f.store.directory, "writer.lock"), "independent-writer");
      await NodeAssert.rejects(
        f.executor().dispatch(input),
        /receipt-store-(unreadable|locked-or-inaccessible)/,
      );
      assert.deepEqual(f.counts(), { launches: 0, lookups: 0 });
    }
  });
});
