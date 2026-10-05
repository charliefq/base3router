import {
  ActionApprovalId,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ActionGateService, layer as actionGateLayer } from "../actionGate/ActionGateService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import {
  argumentHash,
  authorizeDispatch,
  authorizeScheduleUpsert,
  countOccupied,
  issueContinuationGrant,
  revalidateOutboxEffect,
} from "./Base3PolicyGate.ts";
import { PolicyExecutionContext } from "./executionContext.ts";

const ready: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-05T00:00:00.000Z",
  models: [{ slug: "gpt-5.4", name: "GPT", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

const unavailable: ServerProvider = {
  ...ready,
  instanceId: ProviderInstanceId.make("claude-down"),
  driver: ProviderDriverKind.make("claude"),
  installed: false,
  status: "error",
  models: [{ slug: "claude", name: "Claude", isCustom: false, capabilities: null }],
};

const session = {
  kind: "session" as const,
  actorId: "user-1",
  sessionId: "session-1",
  scopes: [AuthOrchestrationOperateScope],
};

const providers = Layer.mock(ProviderRegistry)({
  getProviders: Effect.succeed([unavailable, ready]),
  refresh: () => Effect.succeed([unavailable, ready]),
  refreshInstance: () => Effect.succeed([unavailable, ready]),
  refreshWorkspaceSnapshot: () => Effect.succeed([unavailable, ready]),
  getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
  setProviderMaintenanceActionState: () => Effect.succeed([unavailable, ready]),
  streamChanges: Stream.empty,
});

const gateLayer = actionGateLayer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(providers),
);

const model = { instanceId: ready.instanceId, model: "gpt-5.4" as const };

const StoredRoute = Schema.Struct({
  source: Schema.optionalKey(Schema.String),
  target: Schema.optionalKey(
    Schema.Struct({
      model: Schema.optionalKey(Schema.String),
      instanceId: Schema.optionalKey(Schema.String),
    }),
  ),
  modelRoute: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodeStoredRoute = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRoute));

const dispatch = (command: Parameters<typeof authorizeDispatch>[0]) =>
  authorizeDispatch(command).pipe(Effect.provideService(PolicyExecutionContext, session));

it.effect("Auto binds the eligible model and Manual keeps an explicit target", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* dispatch({
      type: "message.dispatch",
      commandId: "auto-1",
      threadId: "thread-auto",
      messageId: "message-auto",
      text: "Choose a model.",
      routingMode: "auto",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    const autoRows = yield* sql<{ readonly binding_json: string }>`
      SELECT binding_json FROM projection_dispatcher_task_routes
      WHERE thread_id = 'thread-auto' AND message_id = 'message-auto'
    `;
    const auto = yield* decodeStoredRoute(autoRows[0]?.binding_json ?? "{}");
    expect(auto.modelRoute?.mode).toBe("auto");
    expect(auto.target?.model).toBe("gpt-5.4");
    expect(auto.target?.instanceId).toBe("codex-work");
    expect(autoRows[0]?.binding_json ?? "").toContain("claude-down");
    yield* dispatch({
      type: "message.dispatch",
      commandId: "manual-1",
      threadId: "thread-manual",
      messageId: "message-manual",
      text: "Stay on Claude.",
      routingMode: "manual",
      modelSelection: { instanceId: unavailable.instanceId, model: "claude" },
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    const manualRows = yield* sql<{ readonly binding_json: string }>`
      SELECT binding_json FROM projection_dispatcher_task_routes
      WHERE message_id = 'message-manual'
    `;
    const manual = yield* decodeStoredRoute(manualRows[0]?.binding_json ?? "{}");
    expect(manual.source).toBe("explicit");
    expect(manual.modelRoute?.mode ?? "manual").toBe("manual");
    expect(manual.target?.model).toBe("claude");
    expect(manual.target?.instanceId).toBe("claude-down");
    const rewritten = yield* Effect.flip(
      dispatch({
        type: "message.dispatch",
        commandId: "manual-2",
        threadId: "thread-manual",
        messageId: "message-manual",
        text: "Stay on Claude.",
        routingMode: "manual",
        modelSelection: model,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      }),
    );
    expect(rewritten.reason).toBe("binding-immutable");
    const still = yield* sql<{ readonly binding_json: string }>`
      SELECT binding_json FROM projection_dispatcher_task_routes WHERE message_id = 'message-manual'
    `;
    expect(still[0]?.binding_json).toContain("claude-down");
  }).pipe(Effect.provide(gateLayer)),
);

it.effect("schedule execution requires a grant and revalidates the prompt", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const unattended = yield* Effect.flip(
      authorizeScheduleUpsert({
        taskId: "task-agent",
        threadId: "thread-schedule",
        prompt: "nightly review",
        model: "gpt-5.4",
        instanceId: "codex-work",
        createdBy: "agent",
        creationSource: "mcp",
      }).pipe(Effect.provideService(PolicyExecutionContext, session)),
    );
    expect(unattended.reason).toBe("approval-required");
    const pending = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM base3_execution_grants WHERE grant_id = 'grant:schedule:task-agent'
    `;
    expect(pending[0]?.count).toBe(0);
    const row = yield* sql<{ readonly approval_id: string }>`
      SELECT approval_id FROM action_gate_approvals WHERE status = 'pending' LIMIT 1
    `;
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const gate = yield* ActionGateService;
    yield* gate.respond(
      { approvalId: ActionApprovalId.make(row[0]?.approval_id ?? "missing"), decision: "grant" },
      now,
    );
    yield* authorizeScheduleUpsert({
      taskId: "task-agent",
      threadId: "thread-schedule",
      prompt: "nightly review",
      model: "gpt-5.4",
      instanceId: "codex-work",
      createdBy: "agent",
      creationSource: "mcp",
    }).pipe(Effect.provideService(PolicyExecutionContext, session));
    yield* authorizeScheduleUpsert({
      taskId: "task-user",
      threadId: "thread-schedule",
      prompt: "weekday digest",
      model: "gpt-5.4",
      instanceId: "codex-work",
      createdBy: "user",
      creationSource: "web",
    }).pipe(Effect.provideService(PolicyExecutionContext, session));
    const changed = yield* Effect.flip(
      dispatch({
        type: "message.dispatch",
        commandId: "schedule-fire",
        threadId: "thread-schedule",
        messageId: "message-schedule",
        scheduledTaskId: "task-user",
        text: "a different prompt",
        modelSelection: model,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      }),
    );
    expect(changed.reason).toBe("argument-mismatch");
    yield* dispatch({
      type: "message.dispatch",
      commandId: "schedule-fire-ok",
      threadId: "thread-schedule",
      messageId: "message-schedule-ok",
      scheduledTaskId: "task-user",
      text: "weekday digest",
      modelSelection: model,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    const attempts = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM base3_execution_attempts
      WHERE thread_id = 'thread-schedule' AND operation = 'continuation'
    `;
    expect(attempts[0]?.count).toBe(1);
  }).pipe(Effect.provide(gateLayer)),
);

it.effect("usage-limit continuation keeps the prior actor and rejects a mismatched prompt", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const missing = yield* Effect.flip(
      issueContinuationGrant({
        grantId: "grant:usage-limit:run-missing",
        threadId: "thread-empty",
        messageId: "message-empty",
        runId: "run-missing",
        operation: "usage-limit",
        hash: "none",
      }),
    );
    expect(missing.reason).toBe("grant-missing");
    yield* dispatch({
      type: "message.dispatch",
      commandId: "limit-origin",
      threadId: "thread-limit",
      messageId: "message-limit",
      text: "original turn",
      modelSelection: model,
      routingMode: "manual",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      runId: "run-limit",
    });
    const mismatched = yield* Effect.flip(
      dispatch({
        type: "message.dispatch",
        commandId: "limit-bad",
        threadId: "thread-limit",
        messageId: "message-limit-next",
        text: "Continue where you left off.",
        modelSelection: model,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        usageLimitContinuationOfRunId: "run-limit",
      }),
    );
    expect(mismatched.reason).toBe("argument-mismatch");
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES (
        'run-limit', 'thread-limit', 1, 'codex', 'completed', '2026-10-05T00:00:00.000Z', '{}'
      )
    `;
    yield* sql`
      UPDATE base3_capacity_leases SET run_id = 'run-limit' WHERE thread_id = 'thread-limit'
    `;
    const hash = argumentHash({
      text: "Continue where you left off.",
      model: "gpt-5.4",
      instanceId: "codex-work",
      attachmentIds: [],
    });
    yield* issueContinuationGrant({
      grantId: "grant:usage-limit:run-limit",
      threadId: "thread-limit",
      messageId: "message-limit-next",
      runId: "run-limit",
      operation: "usage-limit",
      hash,
    });
    yield* dispatch({
      type: "message.dispatch",
      commandId: "limit-ok",
      threadId: "thread-limit",
      messageId: "message-limit-next",
      text: "Continue where you left off.",
      modelSelection: model,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      usageLimitContinuationOfRunId: "run-limit",
    });
    const grant = yield* sql<{ readonly actor_id: string }>`
      SELECT actor_id FROM base3_execution_grants WHERE grant_id = 'grant:usage-limit:run-limit'
    `;
    expect(grant[0]?.actor_id).toBe("user-1");
  }).pipe(Effect.provide(gateLayer)),
);

it.effect("effect outbox revalidates grants and does not rerun a terminal run", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const context = Effect.provideService(PolicyExecutionContext, session);
    const missing = yield* Effect.flip(
      revalidateOutboxEffect({
        threadId: "thread-outbox",
        request: { type: "provider-turn.start", runId: "run-outbox", messageId: "message-outbox" },
      }).pipe(context),
    );
    expect(["grant-missing", "unconfirmed"]).toContain(missing.reason);
    yield* dispatch({
      type: "message.dispatch",
      commandId: "outbox-1",
      threadId: "thread-outbox",
      messageId: "message-outbox",
      text: "start",
      modelSelection: model,
      routingMode: "manual",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES (
        'run-outbox', 'thread-outbox', 1, 'codex', 'running', '2026-10-05T00:00:00.000Z',
        '{"userMessageId":"message-outbox"}'
      )
    `;
    yield* revalidateOutboxEffect({
      threadId: "thread-outbox",
      request: { type: "provider-turn.start", runId: "run-outbox" },
    }).pipe(context);
    const attached = yield* sql<{ readonly run_id: string | null }>`
      SELECT run_id FROM base3_capacity_leases WHERE message_id = 'message-outbox'
    `;
    expect(attached[0]?.run_id).toBe("run-outbox");
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run-outbox'`;
    const terminal = yield* Effect.flip(
      revalidateOutboxEffect({
        threadId: "thread-outbox",
        request: { type: "provider-runtime.continue", runId: "run-outbox" },
      }).pipe(context),
    );
    expect(terminal.reason).toBe("terminal");
    yield* revalidateOutboxEffect({
      threadId: "thread-outbox",
      request: { type: "provider-turn.interrupt", runId: "run-outbox" },
    }).pipe(context);
    expect(
      yield* countOccupied({
        sql,
        environmentId: EnvironmentId.make("local"),
        threadId: "thread-outbox",
      }),
    ).toBe(1);
  }).pipe(Effect.provide(gateLayer)),
);

it.effect("a revoked grant blocks queue resume and an unknown command is refused", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* dispatch({
      type: "message.dispatch",
      commandId: "resume-origin",
      threadId: "thread-resume",
      messageId: "message-resume",
      text: "queued",
      modelSelection: model,
      routingMode: "manual",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
    });
    yield* sql`
      UPDATE base3_execution_grants
      SET revoked_at = created_at
      WHERE grant_id = 'grant:message:thread-resume:message-resume'
    `;
    const resumed = yield* Effect.flip(
      dispatch({
        type: "queue.resume",
        commandId: "resume-1",
        threadId: "thread-resume",
        messageId: "message-resume",
      }),
    );
    expect(resumed.reason).toBe("grant-revoked");
    const cloud = yield* Effect.flip(
      dispatch({ type: "cursor.cloud.dispatch", commandId: "cloud-1" }),
    );
    expect(cloud.reason).toBe("ungoverned");
    const attempts = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM base3_execution_attempts WHERE thread_id = 'thread-resume'
    `;
    expect(attempts[0]?.count).toBe(1);
  }).pipe(Effect.provide(gateLayer)),
);

it.effect("child admission rejects without waiting and leaves the parent lease occupied", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const gate = yield* ActionGateService;
    yield* dispatch({
      type: "message.dispatch",
      commandId: "parent-1",
      threadId: "thread-parent",
      messageId: "message-parent",
      text: "parent",
      modelSelection: model,
      routingMode: "manual",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    const admit = (task: string, commandId: string) =>
      Effect.gen(function* () {
        const command = {
          type: "delegated_task.request",
          commandId,
          parentThreadId: "thread-parent",
          task,
        };
        yield* Effect.flip(dispatch(command));
        const row = yield* sql<{ readonly approval_id: string }>`
          SELECT approval_id FROM action_gate_approvals
          WHERE status = 'pending'
          ORDER BY created_at DESC
          LIMIT 1
        `;
        const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
        yield* gate.respond(
          {
            approvalId: ActionApprovalId.make(row[0]?.approval_id ?? "missing"),
            decision: "grant",
          },
          now,
        );
        return yield* dispatch(command).pipe(Effect.exit);
      });
    for (const index of [1, 2, 3]) {
      const admitted = yield* admit(`child ${index}`, `child-${index}`);
      expect(admitted._tag).toBe("Success");
    }
    const rejected = yield* admit("child 4", "child-4");
    expect(rejected._tag).toBe("Failure");
    const classes = yield* sql<{ readonly workload_class: string; readonly count: number }>`
      SELECT workload_class, COUNT(*) AS count
      FROM base3_capacity_leases
      WHERE thread_id = 'thread-parent' AND released_at IS NULL
      GROUP BY workload_class
    `;
    const countFor = (name: string) =>
      classes.find((row) => row.workload_class === name)?.count ?? 0;
    expect(countFor("foreground-turn")).toBe(1);
    expect(countFor("child-agent")).toBe(3);
    expect(
      yield* countOccupied({
        sql,
        environmentId: EnvironmentId.make("local"),
        threadId: "thread-parent",
      }),
    ).toBe(4);
  }).pipe(Effect.provide(gateLayer)),
);
