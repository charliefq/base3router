import { assert, it } from "@effect/vitest";
import {
  ActionApprovalId,
  CommandId,
  MessageId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import { agentsCreationCommand } from "./testkit/agentsTaskCreationFixture.ts";
import { withTaskResultLinkageFixture } from "./testkit/taskResultLinkageFixture.ts";

it.live(
  "approved child completion reaches its exact occupied parent through the production continuation worker",
  () =>
    Effect.gen(function* () {
      const key = "mailbox-parent";
      const steers = yield* Ref.make<
        ReadonlyArray<{
          threadId: string;
          runId: string;
          messageId: string;
          providerThreadId: string;
          providerTurnId: string;
          text: string;
        }>
      >([]);
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const base = agentsCreationCommand(key);
            const creation = {
              ...base,
              taskContract: {
                goal: "Inspect local fixture",
                redirect: "Keep scope",
                acceptance: "Owner reads child result",
                brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
              },
            };
            yield* f.dispatch(creation);
            const parentRunning = yield* f.orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (e) =>
                  e.type === "run.updated" &&
                  e.threadId === creation.threadId &&
                  e.payload.status === "running",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* f.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("mailbox-start"),
              threadId: creation.threadId,
              messageId: MessageId.make("mailbox-start"),
              text: "Start parent",
              attachments: [],
              modelSelection: creation.modelSelection,
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* Fiber.join(parentRunning);
            const projection = yield* f.orchestrator.getThreadProjection(creation.threadId);
            const parent = projection.runs[0]!;
            assert.isNotNull(parent.rootNodeId);
            const command: Extract<OrchestrationV2Command, { type: "delegated_task.request" }> = {
              type: "delegated_task.request",
              commandId: CommandId.make("approved-mailbox-child"),
              parentThreadId: creation.threadId,
              parentRunId: parent.id,
              parentNodeId: parent.rootNodeId!,
              task: "Inspect disposable child",
              modelSelection: creation.modelSelection,
              runtimeMode: "approval-required",
              interactionMode: "default",
              completionWake: "always",
              createdBy: "agent",
              creationSource: "server",
            };
            // Ask through the real gate without persisting a rejected orchestration receipt.
            const gate = f.actionGate;
            const decision = yield* gate.authorizeTool({
              toolName: "delegate_task",
              args: {
                task: command.task,
                model: command.modelSelection,
                ...contractGrantFields(projection.thread.taskContract ?? null),
              },
              environmentId: creation.taskCreationReview!.environmentId,
              threadId: creation.threadId,
            });
            assert.isDefined(decision.approvalId);
            yield* gate.respond(
              { approvalId: ActionApprovalId.make(decision.approvalId!), decision: "grant" },
              DateTime.formatIso(yield* DateTime.now),
            );
            const delivered = yield* f.orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (e) =>
                  e.type === "subagent.updated" &&
                  e.threadId === creation.threadId &&
                  e.payload.completionDelivery?.state === "delivered",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* f.dispatch(command);
            yield* Fiber.join(delivered);
            yield* f.worker.drain();
            const after = yield* f.orchestrator.getThreadProjection(creation.threadId);
            const calls = yield* Ref.get(steers);
            assert.equal(calls.length, 1);
            assert.equal(calls[0]!.threadId, parent.threadId);
            assert.equal(calls[0]!.runId, parent.id);
            const deliveredMessage = after.messages.find(
              (message) => message.delegatedCompletion !== undefined,
            )!;
            assert.equal(calls[0]!.messageId, deliveredMessage.id);
            assert.equal(calls[0]!.text, deliveredMessage.text);
            assert.equal(calls[0]!.providerThreadId, parent.providerThreadId);
            assert.equal(
              calls[0]!.providerTurnId,
              after.providerTurns.find((turn) => turn.runAttemptId === parent.activeAttemptId)!.id,
            );
            assert.isTrue(
              (yield* Ref.get(f.executions)).every(
                (input) =>
                  input.modelSelection.model === creation.modelSelection.model &&
                  input.providerThread.providerInstanceId === creation.modelSelection.instanceId,
              ),
            );
            assert.isTrue(after.subagents[0]!.result!.includes("Linked task output"));
            assert.equal(after.runs.length, 1);
            assert.equal(after.runs[0]!.status, "running");
            assert.equal((yield* Ref.get(f.executions)).length, 2);
            const grants = yield* f.sql<{
              operation: string;
              actor_id: string;
            }>`SELECT operation,actor_id FROM base3_execution_grants WHERE operation IN ('delegation','delegated-child','delegated-completion') ORDER BY operation`;
            assert.equal(grants.length, 3);
            assert.isTrue(grants.every((g) => g.actor_id === "fixture-owner"));
            const native = yield* f.sql<{
              status: string;
            }>`SELECT status FROM base3_delegated_mailbox_deliveries`;
            assert.deepEqual(native, [{ status: "accepted" }]);
            const reservations = yield* f.sql<{
              count: number;
            }>`SELECT COUNT(*) AS count FROM task_contract_admissions WHERE root_thread_id=${parent.threadId}`;
            assert.equal(reservations[0]!.count, 2);
            yield* captureState(f, "production-accepted", { actualSteers: calls });
          }),
        {
          governedWorker: true,
          runContinuationWorker: true,
          runningFirst: true,
          onStart: (input, events, emit) =>
            Effect.forEach(input.threadId === key ? events.slice(0, 1) : events, emit, {
              discard: true,
            }),
          onSteer: (input) =>
            Ref.update(steers, (current) => [
              ...current,
              {
                threadId: input.threadId,
                runId: input.runId,
                messageId: input.message.messageId,
                providerThreadId: input.providerThread.id,
                providerTurnId: input.providerTurnId,
                text: input.message.text,
              },
            ]),
        },
      );
    }),
);

import { contractGrantFields } from "@t3tools/contracts";
import type * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { agentsCreationActor } from "./testkit/agentsTaskCreationFixture.ts";
import { delegatedCompletionText } from "../orchestration-v2/NotificationMailbox.ts";
import { ProviderAdapterProtocolError } from "../orchestration-v2/ProviderAdapter.ts";
import { EventSinkWriteError } from "../orchestration-v2/EventSink.ts";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";

type Fixture = Parameters<Parameters<typeof withTaskResultLinkageFixture>[0]>[0];
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const captureState = (f: Fixture, name: string, trace?: unknown) =>
  Effect.gen(function* () {
    const directory = process.env.B3R_MAILBOX_EVIDENCE_DIR;
    if (directory === undefined) return;
    const fs = yield* FileSystem.FileSystem;
    const rows = yield* Effect.all({
      authorities: f.sql`SELECT * FROM base3_delegated_child_authorities ORDER BY task_id`,
      grants: f.sql`SELECT * FROM base3_execution_grants ORDER BY grant_id`,
      native: f.sql`SELECT * FROM base3_delegated_mailbox_deliveries ORDER BY message_id`,
      leases: f.sql`SELECT * FROM base3_capacity_leases ORDER BY lease_id`,
      admissions: f.sql`SELECT * FROM task_contract_admissions ORDER BY command_id`,
      runs: f.sql`SELECT * FROM orchestration_v2_projection_runs ORDER BY thread_id,ordinal`,
      attempts: f.sql`SELECT * FROM orchestration_v2_projection_run_attempts ORDER BY run_id,attempt_ordinal`,
      tasks: f.sql`SELECT * FROM orchestration_v2_projection_subagents ORDER BY subagent_id`,
      messages: f.sql`SELECT * FROM orchestration_v2_projection_messages ORDER BY message_id`,
      effects: f.sql`SELECT * FROM orchestration_v2_effect_outbox ORDER BY effect_id`,
      receipts: f.sql`SELECT * FROM orchestration_command_receipts ORDER BY command_id`,
    });
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      `${directory}/${name}.json`,
      yield* encodeSnapshot({
        ...rows,
        trace,
        executedInputs: (yield* Ref.get(f.executions)).map((input) => ({
          threadId: input.threadId,
          runId: input.runId,
          attemptId: input.attemptId,
          rootNodeId: input.rootNodeId,
          providerThreadId: input.providerThread.id,
          providerSessionId: input.providerThread.providerSessionId,
          messageId: input.message.messageId,
          text: input.message.text,
          modelSelection: input.modelSelection,
        })),
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer));
type MailboxDispatch = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
type Delegation = Extract<OrchestrationV2Command, { type: "delegated_task.request" }>;
const controlledMailbox = <E>(
  check: (input: {
    f: Fixture;
    parent: import("@t3tools/contracts").OrchestrationV2Run;
    delegation: Delegation;
    mailbox: MailboxDispatch;
    identity: import("../policy/executionContext.ts").PolicyExecutionContext;
    finishParent: () => Effect.Effect<void>;
    finishChild: (threadId: string) => Effect.Effect<void>;
  }) => Effect.Effect<void, E, Scope.Scope>,
  options: Pick<
    NonNullable<Parameters<typeof withTaskResultLinkageFixture>[1]>,
    "onSteer" | "decorateEventSink" | "supportsActiveSteering"
  > & { readonly maxProviderStarts?: number } = {},
) => {
  const pending = new Map<string, Effect.Effect<void>>();
  const { maxProviderStarts = 4, ...adapterOptions } = options;
  return withTaskResultLinkageFixture(
    (f) =>
      Effect.gen(function* () {
        const base = awaitCreation("controlled-parent");
        const creation = {
          ...base,
          taskContract: {
            ...base.taskContract,
            brake: { ...base.taskContract.brake, maxProviderStarts },
          },
        };
        yield* f.dispatch(creation);
        const parentRunning = yield* f.orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (e) =>
              e.type === "run.updated" &&
              e.threadId === creation.threadId &&
              e.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* f.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("controlled-start"),
          threadId: creation.threadId,
          messageId: MessageId.make("controlled-start"),
          text: "Start parent",
          attachments: [],
          modelSelection: creation.modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* f.worker.runOnce;
        yield* Fiber.join(parentRunning);
        const projection = yield* f.orchestrator.getThreadProjection(creation.threadId);
        const parent = projection.runs[0]!;
        const delegation: Delegation = {
          type: "delegated_task.request",
          commandId: CommandId.make("controlled-child"),
          parentThreadId: parent.threadId,
          parentRunId: parent.id,
          parentNodeId: parent.rootNodeId!,
          task: "Inspect controlled child",
          modelSelection: creation.modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "server",
        };
        const decision = yield* f.actionGate.authorizeTool({
          toolName: "delegate_task",
          args: {
            task: delegation.task,
            model: delegation.modelSelection,
            ...contractGrantFields(projection.thread.taskContract ?? null),
          },
          environmentId: creation.taskCreationReview!.environmentId,
          threadId: parent.threadId,
        });
        yield* f.actionGate.respond(
          { approvalId: decision.approvalId!, decision: "grant" },
          DateTime.formatIso(yield* DateTime.now),
        );
        yield* f.dispatch(delegation);
        yield* f.worker.runOnce;
        // This is also the frozen baseline probe: accepted delegation must reach
        // the child runtime through its own persisted execution grant.
        assert.equal((yield* Ref.get(f.executions)).length, 2);
        const parentAfter = yield* f.orchestrator.getThreadProjection(parent.threadId);
        const task = parentAfter.subagents[0]!;
        const childTerminal = yield* f.orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (e) =>
              e.type === "run.updated" &&
              e.threadId === task.childThreadId &&
              e.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* pending.get(task.childThreadId!)!;
        yield* Fiber.join(childTerminal);
        yield* f.worker.drain();
        const after = yield* f.orchestrator.getThreadProjection(parent.threadId);
        const delivery = after.runs[0]!.delegatedCompletion!.delivery!;
        const identity = {
          kind: "delegated-completion" as const,
          threadId: parent.threadId,
          parentRunId: parent.id,
          generation: delivery.generation,
          messageId: delivery.messageId,
        };
        const mailbox: MailboxDispatch = {
          type: "message.dispatch",
          commandId: CommandId.make("controlled-mailbox"),
          threadId: parent.threadId,
          messageId: delivery.messageId,
          text: delegatedCompletionText(delivery.taskIds),
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: {
            parentRunId: parent.id,
            generation: delivery.generation,
            taskIds: delivery.taskIds,
          },
        };
        yield* check({
          f,
          parent,
          delegation,
          mailbox,
          identity,
          finishParent: () => pending.get(parent.threadId)!,
          finishChild: (threadId) => pending.get(threadId)!,
        });
      }),
    {
      ...adapterOptions,
      governedWorker: true,
      startWorker: false,
      runningFirst: true,
      onStart: (input, events, emit) =>
        Effect.gen(function* () {
          pending.set(input.threadId, Effect.forEach(events.slice(1), emit, { discard: true }));
          yield* emit(events[0]!);
        }),
    },
  );
};
it.live("a queued completion cannot execute on a changed persisted target", () =>
  controlledMailbox(
    ({ f, parent, mailbox, identity, finishParent }) =>
      Effect.gen(function* () {
        yield* f.dispatch(mailbox, identity);
        // Simulate hostile/stale persisted execution state; never repair an identity.
        yield* f.sql`UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.modelSelection.model','foreign-model') WHERE thread_id=${parent.threadId} AND json_extract(payload_json,'$.userMessageId')=${mailbox.messageId}`;
        const waiting = yield* f.orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (e) =>
              e.type === "run.updated" &&
              e.payload.id === parent.id &&
              e.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* finishParent();
        yield* Fiber.join(waiting);
        yield* f.worker.drain();
        assert.equal((yield* Ref.get(f.executions)).length, 2);
        assert.deepEqual(
          yield* f.sql`SELECT message_id FROM base3_delegated_mailbox_deliveries`,
          [],
        );
      }),
    { supportsActiveSteering: false },
  ),
);

const awaitCreation = (key: string) => ({
  ...agentsCreationCommand(key),
  taskContract: {
    goal: "Inspect local fixture",
    redirect: "Keep scope",
    acceptance: "Read child result",
    brake: { maxProviderStarts: 4, stopConditions: "Scope changed" },
  },
});

it.live("a rejected approved child plan leaves no capacity or authority behind", () =>
  controlledMailbox(({ f, parent, delegation }) =>
    Effect.gen(function* () {
      const projection = yield* f.orchestrator.getThreadProjection(parent.threadId);
      const bad = {
        ...delegation,
        commandId: CommandId.make("invalid-child-plan"),
        parentNodeId: "missing-node" as typeof delegation.parentNodeId,
        task: "Unplannable approved child",
      };
      const approval = yield* f.actionGate.authorizeTool({
        toolName: "delegate_task",
        args: {
          task: bad.task,
          model: bad.modelSelection,
          ...contractGrantFields(projection.thread.taskContract ?? null),
        },
        environmentId: agentsCreationCommand("unused").taskCreationReview!.environmentId,
        threadId: parent.threadId,
      });
      yield* f.actionGate.respond(
        { approvalId: approval.approvalId!, decision: "grant" },
        DateTime.formatIso(yield* DateTime.now),
      );
      assert.isTrue(Exit.isFailure(yield* f.dispatch(bad).pipe(Effect.exit)));
      const leases = yield* f.sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM base3_capacity_leases WHERE workload_class='child-agent' AND released_at IS NULL`;
      assert.equal(leases[0]!.count, 0);
      const authorities = yield* f.sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM base3_delegated_child_authorities`;
      assert.equal(authorities[0]!.count, 1);
      assert.equal((yield* Ref.get(f.executions)).length, 2);
    }),
  ),
);

it.live("frozen approved delegation reaches the child runtime without identity repair", () =>
  controlledMailbox(({ f }) =>
    Effect.gen(function* () {
      const rows = yield* f.sql<{
        status: string;
      }>`SELECT status FROM base3_capacity_leases WHERE workload_class='child-agent'`;
      assert.deepEqual(rows, [{ status: "released" }]);
      assert.equal((yield* Ref.get(f.executions)).length, 2);
    }),
  ),
);

it.live.each([
  "absent",
  "session",
  "continuation",
  "thread",
  "parent",
  "message",
  "generation",
  "text",
  "tasks",
  "target",
  "attachments",
] as const)("rejects forged mailbox %s before any native notification or delivery grant", (mode) =>
  controlledMailbox(({ f, mailbox, identity }) =>
    Effect.gen(function* () {
      let context = identity;
      let command = mailbox;
      if (mode === "absent") context = { kind: "absent" };
      if (mode === "session") context = agentsCreationActor;
      if (mode === "continuation") context = { kind: "server-continuation" };
      if (
        context.kind !== "delegated-completion" &&
        !["absent", "session", "continuation"].includes(mode)
      )
        throw new Error("Missing identity");
      if (mode === "thread" && context.kind === "delegated-completion")
        context = { ...context, threadId: "foreign-thread" };
      if (mode === "parent" && context.kind === "delegated-completion")
        context = { ...context, parentRunId: "foreign-run" };
      if (mode === "message" && context.kind === "delegated-completion")
        context = { ...context, messageId: "foreign-message" };
      if (mode === "generation" && context.kind === "delegated-completion")
        context = { ...context, generation: context.generation + 1 };
      if (mode === "text") command = { ...command, text: "Do unauthorized work" };
      if (mode === "tasks")
        command = {
          ...command,
          delegatedCompletion: { ...command.delegatedCompletion!, taskIds: [] },
        };
      if (mode === "target")
        command = {
          ...command,
          modelSelection: {
            instanceId: agentsCreationCommand("unused").modelSelection.instanceId,
            model: "foreign-model",
          },
        };
      if (mode === "attachments") command = { ...command, context: { version: 1, records: [] } };
      assert.isTrue(Exit.isFailure(yield* f.dispatch(command, context).pipe(Effect.exit)));
      const grants = yield* f.sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM base3_execution_grants WHERE operation='delegated-completion'`;
      assert.equal(grants[0]!.count, 0);
      const effects = yield* f.sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.steer'`;
      assert.equal(effects[0]!.count, 0);
    }),
  ),
);

it.live.each(["revoked", "expired", "approval", "owner"] as const)(
  "source %s remains denied across delegation replay without reviving authority",
  (mode) =>
    controlledMailbox(({ f, mailbox, identity, delegation }) =>
      Effect.gen(function* () {
        if (mode === "revoked")
          yield* f.sql`UPDATE base3_execution_grants SET revoked_at=created_at WHERE operation='delegation'`;
        if (mode === "expired")
          yield* f.sql`UPDATE base3_execution_grants SET expires_at='2000-01-01T00:00:00Z' WHERE operation='delegation'`;
        if (mode === "approval") yield* f.sql`DELETE FROM action_gate_approvals`;
        const actor =
          mode === "owner"
            ? { ...agentsCreationActor, actorId: "foreign-owner" }
            : agentsCreationActor;
        assert.isTrue(Exit.isFailure(yield* f.dispatch(delegation, actor).pipe(Effect.exit)));
        if (mode !== "owner")
          assert.isTrue(Exit.isFailure(yield* f.dispatch(mailbox, identity).pipe(Effect.exit)));
        const grants = yield* f.sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM base3_execution_grants WHERE operation='delegated-completion'`;
        assert.equal(grants[0]!.count, 0);
      }),
    ),
);

it.live("a proven pre-send terminal uses ordinary queue admission once", () =>
  controlledMailbox(({ f, parent, mailbox, identity, finishParent }) =>
    Effect.gen(function* () {
      yield* f.dispatch(mailbox, identity);
      const waiting = yield* f.orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (e) =>
            e.type === "run.updated" &&
            e.payload.id === parent.id &&
            e.payload.status === "waiting",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* finishParent();
      yield* Fiber.join(waiting);
      yield* f.worker.drain();
      const projection = yield* f.orchestrator.getThreadProjection(parent.threadId);
      assert.equal((yield* Ref.get(f.executions)).length, 3);
      assert.equal(projection.runs.length, 2);
      assert.equal(projection.runs[1]!.userMessageId, mailbox.messageId);
      const starts = yield* f.sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM task_contract_admissions WHERE root_thread_id=${parent.threadId}`;
      assert.equal(starts[0]!.count, 3);
      assert.deepEqual(yield* f.sql`SELECT message_id FROM base3_delegated_mailbox_deliveries`, []);
      yield* f
        .dispatch(
          {
            ...mailbox,
            commandId: CommandId.make(
              "command:steer-follow-up:effect:controlled-mailbox:provider-turn.steer:" +
                mailbox.messageId,
            ),
          },
          identity,
        )
        .pipe(Effect.exit);
      assert.equal((yield* Ref.get(f.executions)).length, 3);
    }),
  ),
);

it.live(
  "possible native acceptance followed by completion and an error remains unknown through retry and recovery",
  () => {
    let nativeCalls = 0;
    let terminalBeforeError: Effect.Effect<void> = Effect.void;
    return controlledMailbox(
      ({ f, parent, mailbox, identity, finishParent }) =>
        Effect.gen(function* () {
          terminalBeforeError = Effect.scoped(
            Effect.gen(function* () {
              const terminal = yield* f.orchestrator.streamDomainEvents.pipe(
                Stream.filter(
                  (e) =>
                    e.type === "run.updated" &&
                    e.threadId === parent.threadId &&
                    e.payload.status === "waiting",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
              yield* finishParent();
              yield* Fiber.join(terminal);
            }),
          ).pipe(Effect.orDie);
          yield* f.dispatch(mailbox, identity);
          yield* f.worker.runOnce;
          assert.equal(nativeCalls, 1);
          assert.deepEqual(
            yield* f.sql<{ status: string }>`SELECT status FROM base3_delegated_mailbox_deliveries`,
            [{ status: "unknown" }],
          );
          // Advance only the disposable outbox retry schedule, never an identity or grant.
          yield* f.sql`UPDATE orchestration_v2_effect_outbox SET available_at=created_at WHERE effect_type='provider-turn.steer' AND status='pending'`;
          yield* f.worker.drain();
          assert.equal(nativeCalls, 1);
          assert.equal((yield* Ref.get(f.executions)).length, 2);
          yield* f.rebuild;
          yield* captureState(f, "unknown-after-rebuild");
          assert.isTrue(
            Exit.isFailure(
              yield* f
                .dispatch(
                  { ...mailbox, commandId: CommandId.make("recovered-unknown-mailbox") },
                  identity,
                )
                .pipe(Effect.exit),
            ),
          );
          assert.equal((yield* Ref.get(f.executions)).length, 2);
          assert.deepEqual(
            yield* f.sql<{ status: string }>`SELECT status FROM base3_delegated_mailbox_deliveries`,
            [{ status: "unknown" }],
          );
        }),
      {
        onSteer: (input) =>
          Effect.gen(function* () {
            nativeCalls++;
            yield* terminalBeforeError;
            return yield* new ProviderAdapterProtocolError({
              driver: input.providerThread.driver,
              detail: "Fake provider may have accepted before transport failure",
            });
          }),
      },
    );
  },
);

it.live(
  "native acceptance survives failed receipt settlement and retries only the acknowledgement",
  () => {
    let nativeCalls = 0;
    let failed = false;
    return controlledMailbox(
      ({ f, parent, mailbox, identity }) =>
        Effect.gen(function* () {
          yield* f.dispatch(mailbox, identity);
          yield* f.worker.runOnce;
          assert.equal(nativeCalls, 1);
          yield* captureState(f, "accepted-before-receipt-retry");
          assert.deepEqual(
            yield* f.sql<{ status: string }>`SELECT status FROM base3_delegated_mailbox_deliveries`,
            [{ status: "accepted" }],
          );
          yield* f.sql`UPDATE orchestration_v2_effect_outbox SET available_at=created_at WHERE effect_type='provider-turn.steer' AND status='pending'`;
          yield* f.worker.runOnce;
          assert.equal(nativeCalls, 1);
          const projection = yield* f.orchestrator.getThreadProjection(parent.threadId);
          assert.equal(projection.subagents[0]!.completionDelivery?.state, "delivered");
          assert.equal(projection.runs.length, 1);
          assert.equal((yield* Ref.get(f.executions)).length, 2);
        }),
      {
        onSteer: () =>
          Effect.sync(() => {
            nativeCalls++;
          }),
        decorateEventSink: (service) => ({
          ...service,
          commitCommand: (input) => {
            if (input.commandType === "notification.delivery.accept" && !failed) {
              failed = true;
              return Effect.fail(
                new EventSinkWriteError({
                  eventCount: input.events.length,
                  commandId: input.commandId,
                }),
              );
            }
            return service.commitCommand(input);
          },
        }),
      },
    );
  },
);

it.live.each(["source-revocation", "lease-interruption"] as const)(
  "atomic commit repeats %s and rolls back the delivery grant",
  (mode) => {
    let beforeCommit: Effect.Effect<void> = Effect.void;
    return controlledMailbox(
      ({ f, mailbox, identity, parent }) =>
        Effect.gen(function* () {
          beforeCommit = (
            mode === "source-revocation"
              ? f.sql`UPDATE base3_execution_grants SET revoked_at=created_at WHERE operation='delegation'`
              : f.sql`UPDATE base3_capacity_leases SET interrupt_requested=1 WHERE run_id=${parent.id}`
          ).pipe(Effect.asVoid, Effect.orDie);
          assert.isTrue(Exit.isFailure(yield* f.dispatch(mailbox, identity).pipe(Effect.exit)));
          const grants = yield* f.sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM base3_execution_grants WHERE operation='delegated-completion'`;
          const effects = yield* f.sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.steer'`;
          assert.equal(grants[0]!.count, 0);
          assert.equal(effects[0]!.count, 0);
        }),
      {
        decorateEventSink: (service) => ({
          ...service,
          commitCommand: (input) =>
            input.commandId === "controlled-mailbox"
              ? Effect.andThen(beforeCommit, service.commitCommand(input))
              : service.commitCommand(input),
        }),
      },
    );
  },
);

it.live.each(["pause", "archive", "delete"] as const)(
  "parent %s prevents mailbox effects",
  (mode) =>
    controlledMailbox(({ f, parent, mailbox, identity }) =>
      Effect.gen(function* () {
        if (mode === "pause")
          yield* f.dispatch({
            type: "thread.task-contract.redirect",
            commandId: CommandId.make("pause-mailbox"),
            threadId: parent.threadId,
            revision: 1,
          });
        else
          yield* f.dispatch(
            mode === "archive"
              ? {
                  type: "thread.archive",
                  commandId: CommandId.make("archive-mailbox"),
                  threadId: parent.threadId,
                }
              : {
                  type: "thread.delete",
                  commandId: CommandId.make("delete-mailbox"),
                  threadId: parent.threadId,
                },
          );
        assert.isTrue(Exit.isFailure(yield* f.dispatch(mailbox, identity).pipe(Effect.exit)));
        assert.equal((yield* Ref.get(f.executions)).length, 2);
      }),
    ),
);

it.live("a later unrelated active run only permits ordinary queued notification", () =>
  controlledMailbox(({ f, parent, mailbox, identity, finishParent }) =>
    Effect.gen(function* () {
      const waiting = yield* f.orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (e) =>
            e.type === "run.updated" &&
            e.payload.id === parent.id &&
            e.payload.status === "waiting",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* finishParent();
      yield* Fiber.join(waiting);
      yield* f.worker.drain();
      const running = yield* f.orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (e) =>
            e.type === "run.updated" &&
            e.payload.userMessageId === "new-active" &&
            e.payload.status === "running",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* f.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("new-active"),
        threadId: parent.threadId,
        messageId: MessageId.make("new-active"),
        text: "Independent new turn",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* f.worker.drain();
      yield* Fiber.join(running);
      yield* f.dispatch(mailbox, identity);
      yield* f.worker.drain();
      const projection = yield* f.orchestrator.getThreadProjection(parent.threadId);
      assert.equal(
        projection.runs.find((r) => r.userMessageId === mailbox.messageId)!.status,
        "queued",
      );
      assert.equal((yield* Ref.get(f.executions)).length, 3);
      assert.deepEqual(
        yield* f.sql`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.steer'`,
        [],
      );
    }),
  ),
);

it.live(
  "simultaneous approved sibling completions join a queued cohort without widening its grant",
  () =>
    controlledMailbox(
      ({ f, parent, delegation, mailbox, identity, finishChild, finishParent }) =>
        Effect.gen(function* () {
          yield* f.dispatch(mailbox, identity);
          const projection = yield* f.orchestrator.getThreadProjection(parent.threadId);
          assert.equal(
            projection.runs.find((r) => r.userMessageId === mailbox.messageId)!.status,
            "queued",
          );
          for (const ordinal of [2, 3]) {
            const sibling = {
              ...delegation,
              commandId: CommandId.make(`sibling-child-${ordinal}`),
              task: `Inspect sibling ${ordinal}`,
            };
            const approval = yield* f.actionGate.authorizeTool({
              toolName: "delegate_task",
              args: {
                task: sibling.task,
                model: sibling.modelSelection,
                ...contractGrantFields(projection.thread.taskContract ?? null),
              },
              environmentId: agentsCreationCommand("unused").taskCreationReview!.environmentId,
              threadId: parent.threadId,
            });
            yield* f.actionGate.respond(
              { approvalId: approval.approvalId!, decision: "grant" },
              DateTime.formatIso(yield* DateTime.now),
            );
            yield* f.dispatch(sibling);
            yield* f.worker.drain();
          }
          const tasks = (yield* f.orchestrator.getThreadProjection(
            parent.threadId,
          )).subagents.filter((t) => t.prompt.startsWith("Inspect sibling"));
          const childWaiters = yield* Effect.forEach(tasks, (task) =>
            f.orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (e) =>
                  e.type === "run.updated" &&
                  e.threadId === task.childThreadId &&
                  e.payload.status === "waiting",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            ),
          );
          yield* Effect.forEach(tasks, (task) => finishChild(task.childThreadId!), {
            concurrency: "unbounded",
            discard: true,
          });
          yield* Effect.forEach(childWaiters, Fiber.join, { discard: true });
          yield* f.worker.drain();
          const combined = yield* f.orchestrator.getThreadProjection(parent.threadId);
          const message = combined.messages.find((m) => m.id === mailbox.messageId)!;
          assert.equal(message.delegatedCompletion!.taskIds.length, 3);
          assert.equal(message.text, delegatedCompletionText(message.delegatedCompletion!.taskIds));
          const parentWaiting = yield* f.orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (e) =>
                e.type === "run.updated" &&
                e.payload.id === parent.id &&
                e.payload.status === "waiting",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* finishParent();
          yield* Fiber.join(parentWaiting);
          yield* f.worker.drain();
          assert.equal((yield* Ref.get(f.executions)).length, 5);
          const grants = yield* f.sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM base3_execution_grants WHERE operation='delegated-completion'`;
          assert.equal(grants[0]!.count, 1);
          yield* captureState(f, "concurrent-queued-siblings");
        }),
      { supportsActiveSteering: false, maxProviderStarts: 5 },
    ),
);

it.live(
  "an exhausted start budget denies ordinary queued mailbox work before minting delivery authority",
  () =>
    controlledMailbox(
      ({ f, parent, mailbox, identity }) =>
        Effect.gen(function* () {
          assert.isTrue(Exit.isFailure(yield* f.dispatch(mailbox, identity).pipe(Effect.exit)));
          const grants = yield* f.sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM base3_execution_grants WHERE operation='delegated-completion'`;
          const reservations = yield* f.sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM task_contract_admissions WHERE root_thread_id=${parent.threadId}`;
          assert.equal(grants[0]!.count, 0);
          assert.equal(reservations[0]!.count, 2);
        }),
      { supportsActiveSteering: false, maxProviderStarts: 2 },
    ),
);

it.live.each(["deadline", "unknown-usage", "tokens", "cost"] as const)(
  "frozen %s brakes active mailbox input without spending another start",
  (mode) =>
    controlledMailbox(({ f, parent, mailbox, identity }) =>
      Effect.gen(function* () {
        yield* f.sql`INSERT INTO task_contract_deadlines(root_thread_id,deadline_at,frozen_at,max_tokens,max_cost_usd)
    VALUES(${parent.threadId},${mode === "deadline" ? "2000-01-01T00:00:00Z" : "2099-01-01T00:00:00Z"},'2026-10-18T00:00:00Z',${mode === "tokens" ? 1 : null},${mode === "cost" ? 0.01 : null})`;
        if (mode === "tokens" || mode === "cost")
          yield* f.sql`UPDATE task_usage_attempts SET input_tokens=1,output_tokens=1,usage_status='complete',reported_cost_usd=0.01,price_verified=1,price_label='synthetic-fixture' WHERE root_thread_id=${parent.threadId}`;
        assert.isTrue(Exit.isFailure(yield* f.dispatch(mailbox, identity).pipe(Effect.exit)));
        assert.deepEqual(
          yield* f.sql`SELECT message_id FROM base3_delegated_mailbox_deliveries`,
          [],
        );
        assert.equal((yield* Ref.get(f.executions)).length, 2);
      }),
    ),
);

it.live.each(["revocation", "expiry", "environment"] as const)(
  "actual native delivery rechecks source %s",
  (mode) => {
    let nativeCalls = 0;
    return controlledMailbox(
      ({ f, mailbox, identity }) =>
        Effect.gen(function* () {
          yield* f.dispatch(mailbox, identity);
          if (mode === "revocation")
            yield* f.sql`UPDATE base3_execution_grants SET revoked_at=created_at WHERE operation='delegation'`;
          if (mode === "expiry")
            yield* f.sql`UPDATE base3_execution_grants SET expires_at='2000-01-01T00:00:00Z' WHERE operation='delegation'`;
          if (mode === "environment") f.setEnvironment("foreign-environment");
          yield* f.worker.runOnce;
          assert.equal(nativeCalls, 0);
          assert.deepEqual(
            yield* f.sql`SELECT message_id FROM base3_delegated_mailbox_deliveries`,
            [],
          );
          assert.equal((yield* Ref.get(f.executions)).length, 2);
        }),
      {
        onSteer: () =>
          Effect.sync(() => {
            nativeCalls++;
          }),
      },
    );
  },
);

it.live(
  "duplicate dispatch receipts and rebuilt contexts do not double-deliver or let another actor borrow authority",
  () => {
    let nativeCalls = 0;
    return controlledMailbox(
      ({ f, parent, delegation, mailbox, identity }) =>
        Effect.gen(function* () {
          yield* f.dispatch(delegation);
          const first = yield* f.dispatch(mailbox, identity);
          const replay = yield* f.dispatch(mailbox, identity);
          assert.equal(first.sequence, replay.sequence);
          assert.isTrue(
            Exit.isFailure(yield* f.dispatch(mailbox, agentsCreationActor).pipe(Effect.exit)),
          );
          yield* f.worker.runOnce;
          assert.equal(nativeCalls, 1);
          yield* f.rebuild;
          yield* f.dispatch(mailbox, identity);
          yield* f.worker.drain();
          assert.equal(nativeCalls, 1);
          const projection = yield* f.orchestrator.getThreadProjection(parent.threadId);
          assert.equal(projection.runs.length, 1);
          assert.equal(projection.messages.filter((m) => m.id === mailbox.messageId).length, 1);
        }),
      {
        onSteer: () =>
          Effect.sync(() => {
            nativeCalls++;
          }),
      },
    );
  },
);
