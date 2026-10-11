// Disposable SQLite files live under the OS temp directory.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import {
  AuthOrchestrationOperateScope,
  childConstraintConflict,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  SYNTHETIC_FIXTURE_PRICE_LABEL,
  type OrchestrationV2DomainEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { authorizeDispatch, confirmProviderTermination, countOccupied } from "./Base3PolicyGate.ts";
import { PolicyExecutionContext } from "./executionContext.ts";
import { loadTaskState, reserveGovernedStart, reserveProviderHandoff } from "./TaskContract.ts";
import { recordTaskUsage } from "./TaskUsageAccounting.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-10T00:00:00.000Z",
  models: [{ slug: "gpt-5.4", name: "GPT", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

const session = {
  kind: "session" as const,
  actorId: "user-1",
  sessionId: "session-1",
  scopes: [AuthOrchestrationOperateScope],
};

const providerLayer = Layer.mock(ProviderRegistry)({
  getProviders: Effect.succeed([provider]),
  refresh: () => Effect.succeed([provider]),
  refreshInstance: () => Effect.succeed([provider]),
  refreshWorkspaceSnapshot: () => Effect.succeed([provider]),
  getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
  setProviderMaintenanceActionState: () => Effect.succeed([provider]),
  streamChanges: Stream.empty,
});

const gateLayer = Layer.mergeAll(SqlitePersistenceMemory, providerLayer);

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";
const duplicateAt = DateTime.makeUnsafe(Date.parse("2026-10-11T00:00:00.000Z"));

const pilotBrake = {
  maxProviderStarts: 5,
  stopConditions: "Stop when the tree budget or the deadline is spent",
  maxTokens: 100,
  maxCostUsd: 10,
  deadlineAt: FUTURE,
};

const pilotContract = {
  revision: 1,
  goal: "Ship the offline brake",
  redirect: "Pause when the plan changes",
  acceptance: "The tree stays inside the budget",
  brake: pilotBrake,
};

const payloadFor = (
  threadId: string,
  rootThreadId: string,
  parentThreadId: string | null,
  contract: typeof pilotContract,
) =>
  JSON.stringify({
    taskGovernance: "required",
    taskContract: contract,
    taskContractPhase: "active",
    taskAcceptedRevision: null,
    lineage: { rootThreadId, parentThreadId },
  });

const insertThread = (
  sql: SqlClient.SqlClient,
  threadId: string,
  rootThreadId: string,
  parentThreadId: string | null,
  contract: typeof pilotContract = pilotContract,
) =>
  sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    ) VALUES (
      ${threadId}, 'project-1', 'Task', 'codex', 'full-access', 'default',
      '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z',
      ${payloadFor(threadId, rootThreadId, parentThreadId, contract)}
    )
  `;

const dispatchMessage = (threadId: string, commandId: string, messageId: string) =>
  authorizeDispatch({
    type: "message.dispatch",
    commandId,
    threadId,
    messageId,
    text: "Ship the migration.",
    modelSelection: { instanceId: provider.instanceId, model: "gpt-5.4" },
    routingMode: "manual",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  }).pipe(Effect.provideService(PolicyExecutionContext, session));

const releaseLease = (threadId: string, messageId: string) =>
  confirmProviderTermination({ threadId, messageId });

/**
 * Synthetic fixture price. Production accounting never writes this label.
 */
const insertSyntheticUsage = (
  sql: SqlClient.SqlClient,
  input: {
    readonly turnId: string;
    readonly rootThreadId: string;
    readonly threadId: string;
    readonly messageId: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
    readonly role: "primary" | "retry";
  },
) =>
  sql`
    INSERT INTO task_usage_attempts (
      environment_id, provider_turn_id, root_thread_id, thread_id, message_id,
      contract_revision, provider_instance_id, status, attempt_role, usage_status, basis,
      input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_tokens,
      reported_cost_usd, source_event_id, updated_at, price_verified, price_label
    ) VALUES (
      'local', ${input.turnId}, ${input.rootThreadId}, ${input.threadId}, ${input.messageId},
      1, 'codex-work', 'completed', ${input.role}, 'complete', 'snapshot',
      ${input.inputTokens}, 0, 0, ${input.outputTokens}, 0,
      ${input.costUsd}, ${`event:${input.turnId}`}, '2026-10-11T00:00:00.000Z',
      1, ${SYNTHETIC_FIXTURE_PRICE_LABEL}
    )
  `;

const admissionCount = (sql: SqlClient.SqlClient, rootThreadId: string) =>
  sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM task_contract_admissions
    WHERE root_thread_id = ${rootThreadId}
  `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));

it("a child cannot raise the parent token, dollar, or deadline brakes", () => {
  const parent = pilotContract;
  const raised = childConstraintConflict(parent, {
    ...parent,
    brake: { ...parent.brake, maxTokens: 101 },
  });
  expect(raised).toContain("maxTokens");
  const richer = childConstraintConflict(parent, {
    ...parent,
    brake: { ...parent.brake, maxCostUsd: 11 },
  });
  expect(richer).toContain("maxCostUsd");
  const later = childConstraintConflict(parent, {
    ...parent,
    brake: { ...parent.brake, deadlineAt: "2100-01-01T00:00:00.000Z" },
  });
  expect(later).toContain("cannot extend");
  expect(childConstraintConflict(parent, parent)).toBeNull();
});

it.effect(
  "tree usage accumulates across a child and a retry, and a duplicate command reserves once",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(sql, "thread-root", "thread-root", null);
      yield* insertThread(sql, "thread-child", "thread-root", "thread-root");
      yield* dispatchMessage("thread-root", "root-start", "message-root");
      const stored = yield* loadTaskState(sql, "thread-root");
      expect(stored.contract?.goal).toBe(pilotContract.goal);
      expect(stored.contract?.redirect).toBe(pilotContract.redirect);
      expect(stored.contract?.acceptance).toBe(pilotContract.acceptance);
      expect(stored.contract?.brake.maxTokens).toBe(100);
      expect(stored.rootThreadId).toBe("thread-root");
      const member = yield* sql<{ readonly parent_thread_id: string | null }>`
        SELECT parent_thread_id FROM task_contract_members WHERE thread_id = 'thread-root'
      `;
      expect(member[0]?.parent_thread_id).toBeNull();
      yield* reserveGovernedStart({
        sql,
        state: stored,
        commandType: "message.dispatch",
        commandId: "root-start",
        threadId: "thread-root",
        messageId: "message-root",
      });
      expect(yield* admissionCount(sql, "thread-root")).toBe(1);
      yield* releaseLease("thread-root", "message-root");
      yield* insertSyntheticUsage(sql, {
        turnId: "turn-root",
        rootThreadId: "thread-root",
        threadId: "thread-root",
        messageId: "message-root",
        inputTokens: 40,
        outputTokens: 10,
        costUsd: 1,
        role: "primary",
      });
      yield* dispatchMessage("thread-child", "child-start", "message-child");
      const childMember = yield* sql<{ readonly parent_thread_id: string | null }>`
        SELECT parent_thread_id FROM task_contract_members WHERE thread_id = 'thread-child'
      `;
      expect(childMember[0]?.parent_thread_id).toBe("thread-root");
      yield* releaseLease("thread-child", "message-child");
      yield* insertSyntheticUsage(sql, {
        turnId: "turn-child",
        rootThreadId: "thread-root",
        threadId: "thread-child",
        messageId: "message-child",
        inputTokens: 20,
        outputTokens: 10,
        costUsd: 1,
        role: "primary",
      });
      const state = yield* loadTaskState(sql, "thread-root");
      yield* reserveProviderHandoff({
        sql,
        state,
        commandId: "root-start",
        threadId: "thread-root",
        messageId: "message-root",
        effectType: "provider-turn.start",
        attemptCount: 2,
      });
      expect(yield* admissionCount(sql, "thread-root")).toBe(3);
      yield* insertSyntheticUsage(sql, {
        turnId: "turn-retry",
        rootThreadId: "thread-root",
        threadId: "thread-root",
        messageId: "message-retry",
        inputTokens: 15,
        outputTokens: 10,
        costUsd: 1,
        role: "retry",
      });
      const denied = yield* Effect.flip(
        dispatchMessage("thread-root", "root-over", "message-over"),
      );
      expect(denied.reason).toBe("task-contract");
      expect(denied.message).toContain("Token budget exhausted");
      expect(denied.message).toContain("105");
      expect(yield* admissionCount(sql, "thread-root")).toBe(3);
    }).pipe(Effect.provide(gateLayer)),
);

it.effect("unknown usage and unverified prices deny the next start", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertThread(sql, "thread-unknown", "thread-unknown", null);
    yield* dispatchMessage("thread-unknown", "unknown-1", "message-unknown");
    yield* releaseLease("thread-unknown", "message-unknown");
    yield* sql`
      INSERT INTO task_usage_attempts (
        environment_id, provider_turn_id, root_thread_id, thread_id, message_id,
        contract_revision, status, attempt_role, usage_status, basis,
        input_tokens, output_tokens, reported_cost_usd, updated_at, price_verified
      ) VALUES (
        'local', 'turn-unknown', 'thread-unknown', 'thread-unknown', 'message-unknown',
        1, 'completed', 'primary', 'unavailable', 'snapshot',
        NULL, NULL, NULL, '2026-10-11T00:00:00.000Z', 0
      )
    `;
    const unknown = yield* Effect.flip(
      dispatchMessage("thread-unknown", "unknown-2", "message-unknown-2"),
    );
    expect(unknown.message).toContain("Unknown usage");
    yield* insertThread(sql, "thread-price", "thread-price", null);
    yield* dispatchMessage("thread-price", "price-1", "message-price");
    yield* releaseLease("thread-price", "message-price");
    yield* sql`
      INSERT INTO task_usage_attempts (
        environment_id, provider_turn_id, root_thread_id, thread_id, message_id,
        contract_revision, status, attempt_role, usage_status, basis,
        input_tokens, output_tokens, reported_cost_usd, updated_at, price_verified, price_label
      ) VALUES (
        'local', 'turn-price', 'thread-price', 'thread-price', 'message-price',
        1, 'completed', 'primary', 'complete', 'snapshot',
        10, 5, 1.25, '2026-10-11T00:00:00.000Z', 0, NULL
      )
    `;
    const price = yield* Effect.flip(dispatchMessage("thread-price", "price-2", "message-price-2"));
    expect(price.message).toContain("unverified pricing");
    yield* insertThread(sql, "thread-dollar", "thread-dollar", null, {
      ...pilotContract,
      brake: { ...pilotBrake, maxTokens: 1000, maxCostUsd: 3 },
    });
    yield* dispatchMessage("thread-dollar", "dollar-1", "message-dollar");
    yield* releaseLease("thread-dollar", "message-dollar");
    yield* insertSyntheticUsage(sql, {
      turnId: "turn-dollar",
      rootThreadId: "thread-dollar",
      threadId: "thread-dollar",
      messageId: "message-dollar",
      inputTokens: 4,
      outputTokens: 1,
      costUsd: 3,
      role: "primary",
    });
    const dollars = yield* Effect.flip(
      dispatchMessage("thread-dollar", "dollar-2", "message-dollar-2"),
    );
    expect(dollars.message).toContain("Dollar budget exhausted");
  }).pipe(Effect.provide(gateLayer)),
);

it.effect("a restart keeps the frozen deadline and does not extend it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const expired = {
      ...pilotContract,
      brake: { ...pilotBrake, deadlineAt: PAST },
    };
    yield* TestClock.setTime(Date.parse("2026-10-11T00:00:00.000Z"));
    yield* insertThread(sql, "thread-clock", "thread-clock", null, expired);
    const first = yield* Effect.flip(dispatchMessage("thread-clock", "clock-1", "message-clock"));
    expect(first.message).toContain("Absolute deadline");
    expect(first.message).toContain("does not extend");
    const frozen = yield* sql<{ readonly deadline_at: string }>`
      SELECT deadline_at FROM task_contract_deadlines WHERE root_thread_id = 'thread-clock'
    `;
    expect(frozen[0]?.deadline_at.startsWith("2020-01-01")).toBe(true);
    const storedDeadline = frozen[0]?.deadline_at;
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = ${payloadFor("thread-clock", "thread-clock", null, pilotContract)}
      WHERE thread_id = 'thread-clock'
    `;
    const second = yield* Effect.flip(
      dispatchMessage("thread-clock", "clock-2", "message-clock-2"),
    );
    expect(second.message).toContain(storedDeadline ?? PAST);
    const again = yield* sql<{ readonly deadline_at: string }>`
      SELECT deadline_at FROM task_contract_deadlines WHERE root_thread_id = 'thread-clock'
    `;
    expect(again[0]?.deadline_at).toBe(storedDeadline);
    expect(yield* admissionCount(sql, "thread-clock")).toBe(0);
  }).pipe(Effect.provide(gateLayer)),
);

it.effect(
  "a duplicate usage event does not double the accounting, and the production row stays unverified",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(sql, "thread-duplicate", "thread-duplicate", null);
      yield* dispatchMessage("thread-duplicate", "dup-start", "message-dup");
      yield* releaseLease("thread-duplicate", "message-dup");
      const event = {
        id: "event-pilot-1",
        type: "provider-turn.updated",
        threadId: "thread-duplicate",
        occurredAt: duplicateAt,
        runId: "run-duplicate",
        providerInstanceId: provider.instanceId,
        payload: {
          id: "turn-duplicate",
          status: "completed",
          usageAccounting: "snapshot",
          reportedCostUsd: 1.5,
          turnTokenUsage: {
            usageStatus: "complete",
            inputTokens: 10,
            outputTokens: 5,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            reasoningTokens: 0,
          },
        },
      } as Extract<OrchestrationV2DomainEvent, { type: "provider-turn.updated" }>;
      yield* recordTaskUsage("local", event);
      yield* recordTaskUsage("local", event);
      const rows = yield* sql<{
        readonly tokens: number | null;
        readonly price_verified: number;
        readonly price_label: string | null;
        readonly attempts: number;
      }>`
        SELECT
          SUM(input_tokens + output_tokens) AS tokens,
          MAX(price_verified) AS price_verified,
          MAX(price_label) AS price_label,
          COUNT(*) AS attempts
        FROM task_usage_attempts
        WHERE root_thread_id = 'thread-duplicate'
      `;
      expect(Number(rows[0]?.attempts ?? 0)).toBe(1);
      expect(Number(rows[0]?.tokens ?? 0)).toBe(15);
      expect(Number(rows[0]?.price_verified ?? 1)).toBe(0);
      expect(rows[0]?.price_label).toBeNull();
      const denied = yield* Effect.flip(
        dispatchMessage("thread-duplicate", "dup-next", "message-dup-2"),
      );
      expect(denied.message).toContain("unverified pricing");
    }).pipe(Effect.provide(gateLayer)),
);

it.effect(
  "concurrent starts cannot take two reservations, and interrupt does not free the lease",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(sql, "thread-race", "thread-race", null);
      const raced = yield* Effect.all(
        [
          Effect.result(dispatchMessage("thread-race", "race-a", "message-race-a")),
          Effect.result(dispatchMessage("thread-race", "race-b", "message-race-b")),
        ],
        { concurrency: 2 },
      );
      const denied = raced.filter((result) => result._tag === "Failure");
      const admitted = raced.filter((result) => result._tag === "Success");
      expect(admitted).toHaveLength(1);
      expect(denied).toHaveLength(1);
      const failure = denied[0];
      if (failure?._tag === "Failure") {
        expect(String(failure.failure)).toContain("unsettled reservation");
      }
      expect(yield* admissionCount(sql, "thread-race")).toBe(1);
      const flags = yield* sql<{
        readonly interrupt_requested: number;
        readonly released_at: string | null;
      }>`
      SELECT interrupt_requested, released_at
      FROM base3_capacity_leases
      WHERE thread_id = 'thread-race'
    `;
      expect(flags[0]?.released_at).toBeNull();
      expect(
        yield* countOccupied({
          sql,
          environmentId: EnvironmentId.make("local"),
          threadId: "thread-race",
        }),
      ).toBe(1);

      yield* insertThread(sql, "thread-pin", "thread-pin", null);
      yield* dispatchMessage("thread-pin", "pin-1", "message-pin");
      yield* insertSyntheticUsage(sql, {
        turnId: "turn-pin",
        rootThreadId: "thread-pin",
        threadId: "thread-pin",
        messageId: "message-pin",
        inputTokens: 80,
        outputTokens: 30,
        costUsd: 1,
        role: "primary",
      });
      const exhausted = yield* Effect.flip(dispatchMessage("thread-pin", "pin-2", "message-pin-2"));
      expect(exhausted.message).toContain("Token budget exhausted");
      const pinned = yield* sql<{
        readonly interrupt_requested: number;
        readonly released_at: string | null;
      }>`
      SELECT interrupt_requested, released_at
      FROM base3_capacity_leases
      WHERE thread_id = 'thread-pin'
    `;
      expect(pinned[0]?.interrupt_requested).toBe(1);
      expect(pinned[0]?.released_at).toBeNull();
      yield* sql`UPDATE base3_capacity_leases SET run_id = 'run-pin' WHERE thread_id = 'thread-pin'`;
      yield* confirmProviderTermination({ threadId: "thread-pin", runId: "run-pin" });
      const once = yield* sql<{ readonly released_at: string | null }>`
      SELECT released_at FROM base3_capacity_leases WHERE thread_id = 'thread-pin'
    `;
      const releasedAt = once[0]?.released_at;
      expect(releasedAt).not.toBeNull();
      yield* confirmProviderTermination({ threadId: "thread-pin", runId: "run-pin" });
      const twice = yield* sql<{ readonly released_at: string | null }>`
      SELECT released_at FROM base3_capacity_leases WHERE thread_id = 'thread-pin'
    `;
      expect(twice[0]?.released_at).toBe(releasedAt);
      expect(
        yield* countOccupied({
          sql,
          environmentId: EnvironmentId.make("local"),
          threadId: "thread-pin",
        }),
      ).toBe(0);
    }).pipe(Effect.provide(gateLayer)),
);
