import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RunAttemptId,
  ThreadId,
  ControllerTool,
  ControllerToolInputs,
  ControllerTaskView,
  ControllerIdentityView,
  ControllerStatus,
  OrchestrationV2Command,
  TaskResultFeedbackSubmit,
  type CollaborationTask,
  type ControllerInput,
} from "@t3tools/contracts";
import { PolicyExecutionContext } from "../policy/executionContext.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { TaskResultFeedbackService, readCollaborationSnapshot } from "../collaboration/store.ts";

export class ControllerBridgeError extends Schema.TaggedError<ControllerBridgeError>()(
  "ControllerBridgeError",
  {
    code: Schema.Literals([
      "unauthorized",
      "denied",
      "invalid_request",
      "stale",
      "conflict",
      "unavailable",
    ]),
  },
) {}
const fail = (code: ControllerBridgeError["code"]) => new ControllerBridgeError({ code });
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
// Canonical input hashing makes object property order irrelevant to idempotency.
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
type Identity = {
  id: string;
  display_name: string;
  projects_json: string;
  actions_json: string;
  generation: number;
  expires_at: string;
  revoked_at: string | null;
};
type TaskRow = {
  task_id: string;
  controller_id: string;
  project_id: string;
  thread_id: string;
  fence: number;
  pending_key: string | null;
  create_command_json: string;
  launch_command_json: string | null;
};
const Operation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("dispatch"), command: OrchestrationV2Command }),
  Schema.Struct({ kind: Schema.Literal("feedback"), input: TaskResultFeedbackSubmit }),
]);
type Operation = typeof Operation.Type;
type Receipt = {
  tool: string;
  request_sha256: string;
  task_id: string;
  generation: number;
  operation_json: string;
  response_json: string | null;
  error_code: ControllerBridgeError["code"] | null;
};
const encodeOperation = Schema.encodeSync(Schema.fromJsonString(Operation));
const encodeCommand = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2Command));
const encodeView = Schema.encodeSync(Schema.fromJsonString(ControllerTaskView));
const isBridgeError = Schema.is(ControllerBridgeError);
const decodeOperation = Schema.decodeUnknownEffect(Schema.fromJsonString(Operation));
const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2Command));
const decodeView = Schema.decodeUnknownEffect(Schema.fromJsonString(ControllerTaskView));
const decodeProjects = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const decodeActions = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ControllerTool)),
);
const decodeInputs = {
  create_task: Schema.decodeUnknownEffect(ControllerToolInputs.create_task),
  start_task: Schema.decodeUnknownEffect(ControllerToolInputs.start_task),
  cancel_task: Schema.decodeUnknownEffect(ControllerToolInputs.cancel_task),
  submit_feedback: Schema.decodeUnknownEffect(ControllerToolInputs.submit_feedback),
  get_task: Schema.decodeUnknownEffect(ControllerToolInputs.get_task),
  get_result: Schema.decodeUnknownEffect(ControllerToolInputs.get_result),
};
const decodeInput = (
  tool: ControllerTool,
  raw: unknown,
): Effect.Effect<ControllerInput<ControllerTool>, Schema.SchemaError> =>
  decodeInputs[tool](raw, { onExcessProperty: "error" });
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const policy = (identity: Identity) => ({
  kind: "session" as const,
  actorId: `controller:${identity.id}`,
  sessionId: `controller:${identity.id}:${identity.generation}`,
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
  expiresAt: identity.expires_at,
});

export class ControllerBridge extends Context.Service<
  ControllerBridge,
  {
    readonly authenticate: (bearer: string) => Effect.Effect<void, ControllerBridgeError>;
    readonly call: (
      bearer: string,
      tool: ControllerTool,
      input: unknown,
    ) => Effect.Effect<ControllerTaskView, ControllerBridgeError>;
    readonly status: (
      id: string,
    ) => Effect.Effect<typeof ControllerStatus.Type, ControllerBridgeError>;
    readonly list: Effect.Effect<
      ReadonlyArray<typeof ControllerIdentityView.Type>,
      ControllerBridgeError
    >;
    readonly revoke: (id: string) => Effect.Effect<void, ControllerBridgeError>;
  }
>()("t3/controller/ControllerBridge") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const feedback = yield* TaskResultFeedbackService;
  const environment = yield* ServerEnvironment;
  const audit = (id: string | null, tool: string, task: string | null, outcome: string) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO controller_audit(controller_id,tool,task_id,outcome,recorded_at)
      VALUES(${id},${tool},${task},${outcome},${yield* now})`;
    });
  const authenticate = Effect.fn("controller.authenticate")(function* (bearer: string) {
    if (!bearer.startsWith("b3rc_") || bearer.length < 32 || bearer.length > 512)
      return yield* fail("unauthorized");
    const rows =
      yield* sql<Identity>`SELECT id,display_name,projects_json,actions_json,generation,expires_at,revoked_at
      FROM controller_identities WHERE token_sha256=${hash(bearer)}`;
    const identity = rows[0];
    if (
      !identity ||
      identity.revoked_at !== null ||
      !Number.isFinite(Date.parse(identity.expires_at)) ||
      Date.parse(identity.expires_at) <= Date.parse(yield* now)
    )
      return yield* fail("unauthorized");
    return identity;
  });
  const owned = (id: string, taskId: string) =>
    Effect.gen(function* () {
      const rows =
        yield* sql<TaskRow>`SELECT * FROM controller_tasks WHERE task_id=${taskId} AND controller_id=${id}`;
      if (!rows[0]) return yield* fail("denied");
      return rows[0];
    });
  const allowed = (id: Identity, tool: ControllerTool, project?: string) =>
    Effect.gen(function* () {
      const actions = yield* decodeActions(id.actions_json);
      const projects = yield* decodeProjects(id.projects_json);
      if (!actions.includes(tool) || (project !== undefined && !projects.includes(project)))
        return yield* fail("denied");
    });
  const facts = (row: TaskRow) =>
    Effect.gen(function* () {
      const snapshot = yield* readCollaborationSnapshot(sql, `controller:${row.controller_id}`, {
        environmentId: yield* environment.getEnvironmentId,
        canOperate: true,
      });
      const task = snapshot.tasks.find(
        (t) => t.threadId === row.thread_id && t.projectId === row.project_id,
      );
      if (!task) return yield* fail("unavailable");
      const projection = yield* orchestrator.getThreadProjection(ThreadId.make(row.thread_id));
      if (
        projection.thread.deletedAt !== null ||
        projection.thread.archivedAt !== null ||
        projection.thread.taskGovernance !== "required" ||
        !projection.thread.taskContract
      )
        return yield* fail("unavailable");
      const input = {
        environmentId: yield* environment.getEnvironmentId,
        taskId: task.id,
        projectId: row.project_id,
        threadId: row.thread_id,
        revision: projection.thread.taskContract.revision,
      };
      return { task, projection, input };
    });
  const view = (
    row: TaskRow,
    receipt: ControllerTaskView["receipt"] = null,
    includeFeedback = true,
  ) =>
    Effect.gen(function* () {
      const f = yield* facts(row);
      const run = f.projection.runs.at(-1);
      const launch = row.launch_command_json ? yield* decodeCommand(row.launch_command_json) : null;
      const admission = launch
        ? yield* orchestrator.getTaskFirstLaunchStatus({ command: launch })
        : null;
      const result = f.task.resultReadout ?? {
        status: "unavailable" as const,
        reason: "No correlated task result.",
      };
      const observed =
        f.task.routingReadout?.status === "available" &&
        f.task.routingReadout.execution.status === "observed";
      return {
        version: 1 as const,
        controllerId: row.controller_id,
        taskId: row.task_id,
        threadId: row.thread_id,
        projectId: row.project_id,
        fence: row.fence,
        contractRevision: f.input.revision,
        admission: launch
          ? admission?.status === "admitted"
            ? ("admitted" as const)
            : ("unknown" as const)
          : ("created" as const),
        execution: observed
          ? ("observed" as const)
          : run
            ? ("unknown" as const)
            : ("not_started" as const),
        terminal: !!run && ["completed", "failed", "cancelled", "interrupted"].includes(run.status),
        run: run?.activeAttemptId
          ? { runId: run.id, attemptId: run.activeAttemptId, status: run.status }
          : null,
        result,
        feedback: includeFeedback ? yield* feedback.read(f.input) : null,
        receipt,
      };
    });
  const assertExpected = (
    row: TaskRow,
    task: CollaborationTask,
    revision: number,
    fence: number,
  ) => {
    if (
      row.fence !== fence ||
      task.contractReadout?.status !== "available" ||
      task.contractReadout.contract.revision !== revision
    )
      return Effect.fail(fail("stale"));
    return Effect.void;
  };
  const prepareOperation = (
    id: Identity,
    tool: ControllerTool,
    raw: unknown,
    key: string,
    taskId: string,
  ) =>
    Effect.gen(function* () {
      const identityHash = hash(canonical([id.id, key]));
      const commandId = CommandId.make(`controller:${identityHash}`);
      if (tool === "create_task") {
        const input = yield* decodeInputs.create_task(raw, {
          onExcessProperty: "error",
        });
        const command: Extract<OrchestrationV2Command, { type: "thread.create" }> = {
          type: "thread.create",
          commandId,
          threadId: ThreadId.make(taskId),
          projectId: ProjectId.make(input.projectId),
          title: input.title,
          modelSelection: {
            instanceId: ProviderInstanceId.make(input.modelSelection.instanceId),
            model: input.modelSelection.model,
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
          taskGovernance: "required",
          taskContract: input.contract,
          taskCreationReview: {
            environmentId: EnvironmentId.make(yield* environment.getEnvironmentId),
            projectId: ProjectId.make(input.projectId),
            modelSelection: {
              instanceId: ProviderInstanceId.make(input.modelSelection.instanceId),
              model: input.modelSelection.model,
            },
          },
        };
        yield* sql`INSERT INTO controller_tasks(task_id,controller_id,project_id,thread_id,pending_key,create_command_json)
        VALUES(${taskId},${id.id},${input.projectId},${taskId},${key},${encodeCommand(command)})`;
        return { kind: "dispatch" as const, command };
      }
      const row = yield* owned(id.id, taskId);
      if (row.pending_key !== null) return yield* fail("conflict");
      const f = yield* facts(row);
      let operation: Operation;
      if (tool === "start_task") {
        const input = yield* decodeInputs.start_task(raw, {
          onExcessProperty: "error",
        });
        yield* assertExpected(row, f.task, input.expectedRevision, input.expectedFence);
        if (row.launch_command_json !== null || f.projection.runs.length !== 0)
          return yield* fail("conflict");
        const review = yield* orchestrator.getTaskReview(f.input);
        if (review.status !== "available") return yield* fail("stale");
        const marker = {
          commandId,
          messageId: MessageId.make(`cm_${identityHash.slice(0, 32)}`),
          threadId: ThreadId.make(row.thread_id),
          reference: review.reference,
          contract: review.contract,
          text: input.text,
          routingMode: input.routingMode,
          modelSelection: f.projection.thread.modelSelection,
          runtimeMode: f.projection.thread.runtimeMode,
          interactionMode: f.projection.thread.interactionMode,
        };
        const command: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
          type: "message.dispatch",
          commandId,
          messageId: marker.messageId,
          threadId: marker.threadId,
          text: input.text,
          attachments: [],
          routingMode: input.routingMode,
          modelSelection: marker.modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
          taskFirstLaunch: marker,
        };
        operation = { kind: "dispatch", command };
        yield* sql`UPDATE controller_tasks SET launch_command_json=${encodeCommand(command)} WHERE task_id=${taskId}`;
      } else if (tool === "cancel_task") {
        const input = yield* decodeInputs.cancel_task(raw, {
          onExcessProperty: "error",
        });
        yield* assertExpected(row, f.task, input.expectedRevision, input.expectedFence);
        const latest = f.projection.runs.at(-1);
        if (
          latest?.id !== input.runId ||
          latest.activeAttemptId !== input.attemptId ||
          !["preparing", "starting", "running"].includes(latest.status)
        )
          return yield* fail("stale");
        operation = {
          kind: "dispatch",
          command: {
            type: "run.interrupt",
            commandId,
            threadId: ThreadId.make(row.thread_id),
            runId: RunId.make(input.runId),
            expectedAttemptId: RunAttemptId.make(input.attemptId),
            expectedContractRevision: input.expectedRevision,
            holdQueue: true,
          },
        };
      } else if (tool === "submit_feedback") {
        const input = yield* decodeInputs.submit_feedback(raw, {
          onExcessProperty: "error",
        });
        yield* assertExpected(row, f.task, input.expectedRevision, input.expectedFence);
        const state = yield* feedback.read(f.input);
        if (
          state.status !== "available" ||
          state.result.status !== "available" ||
          state.result.runId !== input.runId ||
          state.result.attemptId !== input.attemptId ||
          state.fingerprint !== input.fingerprint ||
          state.contextKey !== input.contextKey
        )
          return yield* fail("stale");
        operation = {
          kind: "feedback",
          input: {
            ...f.input,
            reference: state.reference,
            fingerprint: input.fingerprint,
            contextKey: input.contextKey,
            kind: input.kind,
            confirm: true,
          },
        };
      } else return yield* fail("invalid_request");
      const claimed = yield* sql`UPDATE controller_tasks SET fence=fence+1,pending_key=${key}
      WHERE task_id=${taskId} AND fence=${row.fence} AND pending_key IS NULL RETURNING task_id`;
      if (claimed.length !== 1) return yield* fail("stale");
      return operation;
    });
  const call = Effect.fn("controller.call")(function* (
    bearer: string,
    tool: ControllerTool,
    raw: unknown,
  ) {
    const id = yield* authenticate(bearer);
    yield* allowed(id, tool);
    // Decode strict per-tool input before touching receipts or task state.
    const input = yield* decodeInput(tool, raw).pipe(
      Effect.mapError(() => fail("invalid_request")),
    );
    const mutation = "idempotencyKey" in input;
    const taskId =
      "taskId" in input
        ? input.taskId
        : `ct_${hash(canonical([id.id, input.idempotencyKey])).slice(0, 32)}`;
    const row = "projectId" in input ? null : yield* owned(id.id, taskId);
    yield* allowed(
      id,
      tool,
      row ? row.project_id : "projectId" in input ? input.projectId : undefined,
    );
    if (!mutation) {
      const result = yield* view(row!);
      yield* audit(id.id, tool, taskId, "read");
      return tool === "get_result" ? { ...result, feedback: null } : result;
    }
    const key = input.idempotencyKey;
    const requestHash = hash(canonical(input));
    const prepared = yield* sql.withTransaction(
      Effect.gen(function* () {
        // Serialize claims with an actual write, including across server processes.
        const current = yield* sql<Identity>`UPDATE controller_identities SET generation=generation
        WHERE id=${id.id} AND generation=${id.generation} AND revoked_at IS NULL AND expires_at>${yield* now}
        RETURNING id,display_name,projects_json,actions_json,generation,expires_at,revoked_at`;
        if (!current[0]) return yield* fail("unauthorized");
        yield* allowed(
          current[0],
          tool,
          row?.project_id ?? ("projectId" in input ? input.projectId : undefined),
        );
        const prior =
          (yield* sql<Receipt>`SELECT * FROM controller_receipts WHERE controller_id=${id.id} AND idempotency_key=${key}`)[0];
        if (prior) {
          if (
            prior.tool !== tool ||
            prior.request_sha256 !== requestHash ||
            prior.generation !== id.generation ||
            prior.task_id !== taskId
          )
            return yield* fail("conflict");
          return prior;
        }
        const operation = yield* prepareOperation(id, tool, input, key, taskId);
        yield* sql`INSERT INTO controller_receipts(controller_id,idempotency_key,tool,request_sha256,task_id,generation,operation_json)
        VALUES(${id.id},${key},${tool},${requestHash},${taskId},${id.generation},${encodeOperation(operation)})`;
        yield* audit(id.id, tool, taskId, "prepared");
        return {
          tool,
          request_sha256: requestHash,
          task_id: taskId,
          generation: id.generation,
          operation_json: encodeOperation(operation),
          response_json: null,
          error_code: null,
        };
      }),
    );
    if (prepared.error_code) return yield* fail(prepared.error_code);
    if (prepared.response_json) return yield* decodeView(prepared.response_json);
    // Never hold the SQL transaction over the orchestrator's serialized command queue.
    // Recovery always replays this persisted exact command id, not a new dispatch.
    const active = yield* authenticate(bearer);
    if (active.generation !== prepared.generation) return yield* fail("unauthorized");
    yield* allowed(
      active,
      tool,
      row?.project_id ?? ("projectId" in input ? input.projectId : undefined),
    );
    const operation = yield* decodeOperation(prepared.operation_json);
    let commandReceipt: ControllerTaskView["receipt"] = null;
    if (operation.kind === "dispatch") {
      const dispatched = yield* orchestrator.dispatch(operation.command).pipe(Effect.result);
      if (dispatched._tag === "Failure") {
        const receipt = (yield* sql<{
          status: string;
        }>`SELECT status FROM orchestration_command_receipts WHERE command_id=${operation.command.commandId}`)[0];
        // Unknown admission retains the claim; same-key recovery is the only retry.
        if (!receipt || receipt.status !== "rejected") return yield* fail("unavailable");
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE controller_receipts SET error_code='denied' WHERE controller_id=${id.id} AND idempotency_key=${key}`;
            yield* sql`UPDATE controller_tasks SET pending_key=NULL,
              launch_command_json=CASE WHEN ${tool}='start_task' THEN NULL ELSE launch_command_json END
              WHERE task_id=${taskId} AND pending_key=${key}`;
            yield* audit(id.id, tool, taskId, "rejected");
          }),
        );
        return yield* fail("denied");
      }
      commandReceipt = { commandId: operation.command.commandId, status: "accepted" };
    } else {
      const state = yield* feedback.submit(operation.input);
      if (state.status !== "available") {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE controller_receipts SET error_code='stale' WHERE controller_id=${id.id} AND idempotency_key=${key}`;
            yield* sql`UPDATE controller_tasks SET pending_key=NULL WHERE task_id=${taskId} AND pending_key=${key}`;
            yield* audit(id.id, tool, taskId, "stale");
          }),
        );
        return yield* fail("stale");
      }
    }
    const result = yield* view(yield* owned(id.id, taskId), commandReceipt);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE controller_receipts SET response_json=${encodeView(result)} WHERE controller_id=${id.id} AND idempotency_key=${key} AND response_json IS NULL`;
        yield* sql`UPDATE controller_tasks SET pending_key=NULL WHERE task_id=${taskId} AND pending_key=${key}`;
        yield* audit(id.id, tool, taskId, "accepted");
      }),
    );
    const saved = (yield* sql<{
      response_json: string;
    }>`SELECT response_json FROM controller_receipts WHERE controller_id=${id.id} AND idempotency_key=${key}`)[0];
    if (!saved) return yield* fail("unavailable");
    return yield* decodeView(saved.response_json);
  });
  const callAuthorized = (bearer: string, tool: ControllerTool, raw: unknown) =>
    Effect.gen(function* () {
      const identity = yield* authenticate(bearer);
      return yield* call(bearer, tool, raw).pipe(
        Effect.provideService(PolicyExecutionContext, policy(identity)),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const code = isBridgeError(error) ? error.code : "unavailable";
          const identity = yield* authenticate(bearer).pipe(Effect.option);
          yield* audit(Option.isSome(identity) ? identity.value.id : null, tool, null, code).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          return yield* fail(code);
        }),
      ),
    );
  const requireAdmin = (scope: typeof AuthAccessReadScope | typeof AuthAccessWriteScope) =>
    Effect.gen(function* () {
      const context = yield* PolicyExecutionContext;
      if (
        context.kind !== "session" ||
        !context.actorId.trim() ||
        !context.sessionId.trim() ||
        !context.scopes.includes(scope) ||
        (context.expiresAt !== undefined &&
          (!Number.isFinite(Date.parse(context.expiresAt)) ||
            Date.parse(context.expiresAt) <= Date.parse(yield* now)))
      )
        return yield* fail("denied");
    });
  const list = Effect.gen(function* () {
    yield* requireAdmin(AuthAccessReadScope);
    const identities =
      yield* sql<Identity>`SELECT id,display_name,projects_json,actions_json,generation,expires_at,revoked_at FROM controller_identities ORDER BY id`;
    return yield* Effect.forEach(identities, (id) =>
      Effect.gen(function* () {
        const count = yield* sql<{
          n: number;
        }>`SELECT COUNT(*) AS n FROM controller_tasks WHERE controller_id=${id.id}`;
        return {
          id: id.id,
          displayName: id.display_name,
          projects: yield* decodeProjects(id.projects_json),
          actions: yield* decodeActions(id.actions_json),
          generation: id.generation,
          expiresAt: id.expires_at,
          revokedAt: id.revoked_at,
          supervisedTasks: count[0]?.n ?? 0,
        };
      }),
    );
  }).pipe(Effect.mapError((e) => (isBridgeError(e) ? e : fail("unavailable"))));
  const status = (id: string) =>
    Effect.gen(function* () {
      yield* requireAdmin(AuthAccessReadScope);
      const identity = (yield* list).find((i) => i.id === id) ?? null;
      const rows = identity
        ? yield* sql<TaskRow>`SELECT * FROM controller_tasks WHERE controller_id=${id} ORDER BY task_id`
        : [];
      const storedIdentity = identity
        ? (yield* sql<Identity>`SELECT id,display_name,projects_json,actions_json,generation,expires_at,revoked_at FROM controller_identities WHERE id=${id}`)[0]
        : undefined;
      const tasks = storedIdentity
        ? yield* Effect.forEach(rows, (row) =>
            view(row, null, false).pipe(
              Effect.provideService(PolicyExecutionContext, policy(storedIdentity)),
              Effect.option,
            ),
          ).pipe(Effect.map((views) => views.flatMap((v) => (Option.isSome(v) ? [v.value] : []))))
        : [];
      const traffic = yield* sql<{
        at: string | null;
      }>`SELECT MAX(recorded_at) AS at FROM controller_audit WHERE controller_id=${id} AND outcome='authenticated'`;
      return {
        version: 1 as const,
        environmentId: yield* environment.getEnvironmentId,
        configuration: !identity
          ? ("not_configured" as const)
          : identity.revokedAt
            ? ("revoked" as const)
            : Date.parse(identity.expiresAt) <= Date.parse(yield* now)
              ? ("expired" as const)
              : ("configured" as const),
        identity,
        lastAuthenticatedAt: traffic[0]?.at ?? null,
        tasks,
      };
    }).pipe(Effect.mapError((e) => (isBridgeError(e) ? e : fail("unavailable"))));
  const revoke = (id: string) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireAdmin(AuthAccessWriteScope);
          yield* sql`UPDATE controller_identities SET revoked_at=${yield* now},generation=generation+1 WHERE id=${id} AND revoked_at IS NULL`;
          yield* audit(id, "revoke", null, "revoked");
        }),
      )
      .pipe(Effect.mapError((e) => (isBridgeError(e) ? e : fail("unavailable"))));
  return ControllerBridge.of({
    authenticate: (token) =>
      authenticate(token).pipe(
        Effect.tap((identity) => audit(identity.id, "authenticate", null, "authenticated")),
        Effect.asVoid,
        Effect.tapError(() =>
          audit(null, "authenticate", null, "unauthorized").pipe(Effect.ignore),
        ),
        Effect.mapError((e) => (isBridgeError(e) ? e : fail("unavailable"))),
      ),
    call: callAuthorized,
    list,
    status,
    revoke,
  });
});
export const layer = Layer.effect(ControllerBridge, make);
