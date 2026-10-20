import {
  CommandId,
  MessageId,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ExecutionNode,
  OrchestrationV2TurnItem,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type TaskContractReviewInput,
  type TaskContractReviewState,
  type CollaborationSnapshot,
  type OrchestrationV2DispatchCommandResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeRun = Schema.decodeUnknownEffect(Schema.toCodecJson(OrchestrationV2Run));
const encodeRun = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2Run)),
);
const decodeAttempt = Schema.decodeUnknownEffect(Schema.toCodecJson(OrchestrationV2RunAttempt));
const encodeAttempt = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2RunAttempt)),
);
const decodeThread = Schema.decodeUnknownEffect(Schema.toCodecJson(OrchestrationV2ProviderThread));
const encodeThread = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ProviderThread)),
);
const decodeTurn = Schema.decodeUnknownEffect(Schema.toCodecJson(OrchestrationV2ProviderTurn));
const encodeTurn = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ProviderTurn)),
);
const decodeNode = Schema.decodeUnknownEffect(Schema.toCodecJson(OrchestrationV2ExecutionNode));
const encodeNode = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ExecutionNode)),
);
const decodeItem = Schema.decodeUnknownEffect(Schema.toCodecJson(OrchestrationV2TurnItem));
const encodeItem = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2TurnItem)),
);

type Creation = Extract<OrchestrationV2Command, { type: "thread.create" }>;
type Fixture = {
  sql: SqlClient.SqlClient;
  dispatch: (
    c: OrchestrationV2Command,
  ) => Effect.Effect<OrchestrationV2DispatchCommandResult, Error>;
  readSnapshot: () => Effect.Effect<CollaborationSnapshot, Error>;
  readReview: (input: TaskContractReviewInput) => Effect.Effect<TaskContractReviewState, Error>;
  noExecution: () => Effect.Effect<
    { runs: number; grants: number; outbox: number; messages: number },
    Error
  >;
  orchestrator: {
    getThreadProjection: (id: string) => Effect.Effect<OrchestrationV2ThreadProjection, Error>;
  };
};

// Dynamic boundary keeps this web test helper from pulling the server project into Web tsc.
const loadFixture = async () =>
  (await import(
    /* @vite-ignore */ new URL(
      "../../../../../server/src/collaboration/testkit/agentsTaskCreationFixture.ts",
      import.meta.url,
    ).href
  )) as {
    agentsCreationCommand: (id: string) => Creation;
    withAgentsTaskCreationFixture: (
      check: (f: Fixture) => Effect.Effect<void, Error>,
    ) => Effect.Effect<void, Error>;
  };

export async function withTaskRevisionRequestFixture(
  check: (
    f: Fixture & {
      command: Creation;
      snapshot: CollaborationSnapshot;
      projection: OrchestrationV2ThreadProjection;
      readOwnedReviewAsync: () => Promise<TaskContractReviewState>;
      dbChangesAsync: () => Promise<ReadonlyArray<Record<string, unknown>>>;
      freshFactsAsync: () => Promise<{
        snapshot: CollaborationSnapshot;
        projection: OrchestrationV2ThreadProjection;
      }>;
      setSelectedThreadStatusAsync: (status: "active" | "idle") => Promise<void>;
      insertRecoveryItemAsync: (
        type: "command_execution" | "dynamic_tool" | "subagent",
        status: "pending" | "running" | "waiting",
        historical?: boolean,
      ) => Promise<void>;
    },
  ) => Promise<void>,
) {
  const module = await loadFixture();
  await Effect.runPromise(
    module.withAgentsTaskCreationFixture((f) =>
      Effect.promise(async () => {
        const base = module.agentsCreationCommand("revision-request-root");
        const command = {
          ...base,
          taskContract: {
            ...base.taskContract!,
            brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
          },
        };
        await Effect.runPromise(f.dispatch(command));
        const launchReview = await Effect.runPromise(
          f.readReview({
            environmentId: "environment-a",
            taskId: `task:governed:thread:${command.threadId}`,
            projectId: command.projectId,
            threadId: command.threadId,
            revision: 1,
          }),
        );
        if (launchReview.status !== "available") throw new Error("Source launch review missing");
        await Effect.runPromise(
          f.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("revision-fixture-dispatch"),
            threadId: command.threadId,
            messageId: MessageId.make("revision-input"),
            text: "Implement parser",
            taskFirstLaunch: {
              commandId: CommandId.make("revision-fixture-dispatch"),
              messageId: MessageId.make("revision-input"),
              threadId: command.threadId,
              text: "Implement parser",
              reference: launchReview.reference,
              contract: launchReview.contract,
              routingMode: "manual",
              modelSelection: command.modelSelection,
              runtimeMode: command.runtimeMode,
              interactionMode: command.interactionMode,
            },
            modelSelection: command.modelSelection,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            routingMode: "manual",
            dispatchMode: { type: "start_immediately" },
          }),
        );
        const p = await Effect.runPromise(f.orchestrator.getThreadProjection(command.threadId));
        const current = p.runs[0]!;
        const start = "2026-10-14T00:00:00.000Z",
          end = "2026-10-14T00:00:01.000Z";
        const wire = {
          id: current.id,
          threadId: command.threadId,
          ordinal: 1,
          providerInstanceId: "codex",
          modelSelection: current.modelSelection,
          userMessageId: current.userMessageId,
          rootNodeId: current.rootNodeId ?? "revision-root-node",
          activeAttemptId: current.activeAttemptId ?? "revision-attempt",
          providerThreadId: current.providerThreadId ?? "revision-provider-thread",
          status: "completed",
          requestedAt: start,
          startedAt: start,
          completedAt: end,
          checkpointId: null,
          contextHandoffId: null,
        };
        const run = await Effect.runPromise(decodeRun(wire));
        const attempt = await Effect.runPromise(
          decodeAttempt({
            id: wire.activeAttemptId,
            runId: run.id,
            attemptOrdinal: 1,
            rootNodeId: wire.rootNodeId,
            providerInstanceId: "codex",
            providerThreadId: wire.providerThreadId,
            providerTurnId: "revision-turn",
            reason: "initial",
            status: "completed",
            startedAt: start,
            completedAt: end,
          }),
        );
        const thread = await Effect.runPromise(
          decodeThread({
            id: wire.providerThreadId,
            driver: "codex",
            providerInstanceId: "codex",
            providerSessionId: null,
            appThreadId: command.threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: start,
            updatedAt: end,
          }),
        );
        const turn = await Effect.runPromise(
          decodeTurn({
            id: "revision-turn",
            providerThreadId: thread.id,
            nodeId: wire.rootNodeId,
            runAttemptId: attempt.id,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: start,
            completedAt: end,
          }),
        );
        const rootWire = {
          id: wire.rootNodeId,
          threadId: command.threadId,
          runId: run.id,
          parentNodeId: null,
          rootNodeId: wire.rootNodeId,
          kind: "root_turn",
          status: "completed",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: start,
          completedAt: end,
        };
        const root = await Effect.runPromise(decodeNode(rootWire));
        const nativeItemRef = {
          driver: "codex",
          nativeId: "revision-assistant",
          strength: "strong",
        };
        const child = await Effect.runPromise(
          decodeNode({
            ...rootWire,
            id: "revision-assistant-node",
            parentNodeId: root.id,
            kind: "assistant_message",
            countsForRun: false,
            providerThreadId: thread.id,
            providerTurnId: turn.id,
            nativeItemRef,
          }),
        );
        const item = await Effect.runPromise(
          decodeItem({
            id: "revision-output",
            messageId: "revision-assistant-message",
            threadId: command.threadId,
            runId: run.id,
            nodeId: child.id,
            providerThreadId: thread.id,
            providerTurnId: turn.id,
            nativeItemRef,
            parentItemId: null,
            ordinal: 1,
            type: "assistant_message",
            status: "completed",
            title: null,
            startedAt: start,
            completedAt: end,
            updatedAt: end,
            text: "Attributed parser output. " + "x".repeat(2200),
            streaming: false,
          }),
        );
        const sql = f.sql;
        await Effect.runPromise(
          sql`UPDATE orchestration_v2_projection_runs SET provider_thread_id=${thread.id},status='completed',completed_at=${end},payload_json=${await Effect.runPromise(encodeRun(run))} WHERE run_id=${run.id}`,
        );
        await Effect.runPromise(
          sql`INSERT OR REPLACE INTO orchestration_v2_projection_run_attempts (attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_instance_id,provider_thread_id,provider_turn_id,status,payload_json) VALUES (${attempt.id},${command.threadId},${run.id},1,${root.id},'codex','codex',${thread.id},${turn.id},'completed',${await Effect.runPromise(encodeAttempt(attempt))})`,
        );
        await Effect.runPromise(
          sql`INSERT OR REPLACE INTO orchestration_v2_projection_provider_threads (provider_thread_id,thread_id,owner_node_id,provider,driver,provider_instance_id,provider_session_id,status,first_run_ordinal,last_run_ordinal,updated_at,payload_json) VALUES (${thread.id},${command.threadId},NULL,'codex','codex','codex',NULL,'idle',1,1,${end},${await Effect.runPromise(encodeThread(thread))})`,
        );
        await Effect.runPromise(
          sql`INSERT OR REPLACE INTO orchestration_v2_projection_provider_turns (provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,started_at,completed_at,payload_json) VALUES (${turn.id},${command.threadId},${thread.id},${root.id},${attempt.id},1,'completed',${start},${end},${await Effect.runPromise(encodeTurn(turn))})`,
        );
        for (const node of [root, child])
          await Effect.runPromise(
            sql`INSERT OR REPLACE INTO orchestration_v2_projection_nodes (node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,runtime_request_id,checkpoint_scope_id,started_at,completed_at,payload_json) VALUES (${node.id},${command.threadId},${run.id},${node.parentNodeId},${root.id},${node.kind},'completed',${node.providerThreadId},${node.providerTurnId},NULL,NULL,${start},${end},${await Effect.runPromise(encodeNode(node))})`,
          );
        await Effect.runPromise(
          sql`INSERT OR REPLACE INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,payload_json) VALUES (${item.id},${command.threadId},${run.id},${child.id},${thread.id},${turn.id},NULL,1,'assistant_message','completed',${end},${await Effect.runPromise(encodeItem(item))})`,
        );
        await check({
          ...f,
          readOwnedReviewAsync: () =>
            Effect.runPromise(
              f.readReview({
                environmentId: "environment-a",
                taskId: `task:governed:thread:${command.threadId}`,
                projectId: command.projectId,
                threadId: command.threadId,
                revision: 1,
              }),
            ),
          dbChangesAsync: () => Effect.runPromise(f.sql`SELECT total_changes() AS n`),
          freshFactsAsync: async () => ({
            snapshot: await Effect.runPromise(f.readSnapshot()),
            projection: await Effect.runPromise(
              f.orchestrator.getThreadProjection(command.threadId),
            ),
          }),
          setSelectedThreadStatusAsync: async (status) => {
            await Effect.runPromise(
              sql`UPDATE orchestration_v2_projection_provider_threads SET status=${status},payload_json=json_set(payload_json,'$.status',${status}) WHERE provider_thread_id=${thread.id}`,
            );
          },
          insertRecoveryItemAsync: async (type, status, historical = false) => {
            const recovery = await Effect.runPromise(
              decodeItem({
                id: "revision-recovery",
                threadId: command.threadId,
                runId: run.id,
                nodeId: root.id,
                providerThreadId: thread.id,
                providerTurnId: historical ? "earlier-provider-turn" : turn.id,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                type,
                status,
                title: null,
                startedAt: start,
                completedAt: null,
                updatedAt: end,
                ...(type === "command_execution"
                  ? { input: "fixture-only command" }
                  : type === "dynamic_tool"
                    ? { toolName: "fixture-only", input: {} }
                    : {
                        subagentId: child.id,
                        origin: "provider_native",
                        driver: "codex",
                        providerInstanceId: "codex",
                        childThreadId: null,
                        prompt: "fixture-only",
                        result: null,
                      }),
              }),
            );
            await Effect.runPromise(
              sql`INSERT OR REPLACE INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,payload_json) VALUES (${recovery.id},${command.threadId},${run.id},${root.id},${thread.id},${recovery.providerTurnId},NULL,2,${type},${status},${end},${await Effect.runPromise(encodeItem(recovery))})`,
            );
          },
          command,
          snapshot: await Effect.runPromise(f.readSnapshot()),
          projection: await Effect.runPromise(f.orchestrator.getThreadProjection(command.threadId)),
        });
      }),
    ),
  );
}
