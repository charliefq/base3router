import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import { recordTaskUsage } from "../policy/TaskUsageAccounting.ts";
import {
  EventId,
  ProviderTurnId,
  ProviderThreadId,
  ProviderInstanceId,
  NodeId,
  RunAttemptId,
  ThreadId,
  RunId,
} from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as TaskRecords from "./TaskRecords.ts";
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const stamp = "2026-10-22T00:00:00.000Z";
const layer = TaskRecords.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
it.effect(
  "lists ordinary and governed archived runs, paginates, scopes detail, and reads durable snapshots",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* TaskRecords.TaskRecords;
      for (const [thread, governance, deleted] of [
        ["chat", "chat", null],
        ["governed", "required", null],
        ["deleted", "chat", stamp],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,archived_at,deleted_at,payload_json) VALUES (${thread},'project',${thread},'codex','full-access','default',${stamp},${stamp},${stamp},${deleted},${yield* encodeJson({ taskGovernance: governance })})`;
      }
      for (let i = 0; i < 53; i++) {
        const id = `run-${String(i).padStart(3, "0")}`;
        const thread = i === 52 ? "deleted" : i === 51 ? "governed" : "chat";
        const run = {
          id,
          threadId: thread,
          ordinal: i + 1,
          providerInstanceId: "codex",
          modelSelection: { instanceId: "codex", model: "requested" },
          providerThreadId: null,
          userMessageId: `message-${i}`,
          rootNodeId: null,
          activeAttemptId: null,
          status: i === 51 ? "cancelled" : i === 50 ? "failed" : "completed",
          requestedAt: stamp,
          startedAt: stamp,
          completedAt: stamp,
          checkpointId: null,
          contextHandoffId: null,
        };
        yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json) VALUES (${id},${thread},${i + 1},'codex',${run.status},${stamp},${stamp},${yield* encodeJson(run)})`;
      }
      const first = yield* service.list(0);
      assert.equal(first.records.length, 50);
      assert.equal(first.nextOffset, 50);
      assert.equal(first.records[0]?.governance, "required");
      assert.equal(first.records[0]?.run.status, "cancelled");
      assert.equal(first.records[1]?.run.status, "failed");
      const second = yield* service.list(first.nextOffset!);
      assert.equal(second.records.length, 2);
      assert.isNull(second.nextOffset);
      assert.equal(new Set([...first.records, ...second.records].map((r) => r.run.id)).size, 52);
      assert.isNull(yield* service.detail(ThreadId.make("chat"), RunId.make("run-051")));
      const detail = yield* service.detail(ThreadId.make("governed"), RunId.make("run-051"));
      assert.equal(detail?.record.run.status, "cancelled");
      assert.deepEqual(detail?.steps, []);
      const turn = {
        id: ProviderTurnId.make("fixture-turn"),
        providerThreadId: ProviderThreadId.make("pt"),
        nodeId: NodeId.make("n"),
        runAttemptId: RunAttemptId.make("a"),
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed" as const,
        startedAt: DateTime.makeUnsafe(stamp),
        completedAt: DateTime.makeUnsafe(stamp),
        turnTokenUsage: {
          usageScope: "main_agent" as const,
          usageStatus: "complete" as const,
          hasSubagents: false,
          inputTokens: 100,
          outputTokens: 20,
        },
      };
      const event = {
        id: EventId.make("usage-one"),
        type: "provider-turn.updated" as const,
        threadId: ThreadId.make("chat"),
        runId: RunId.make("run-050"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        occurredAt: DateTime.makeUnsafe(stamp),
        payload: turn,
      };
      yield* recordTaskUsage("fixture", event);
      yield* recordTaskUsage("fixture", event); // same persisted event must not count twice
      yield* recordTaskUsage("fixture", {
        ...event,
        id: EventId.make("usage-two"),
        payload: {
          ...turn,
          usageAccounting: "incremental",
          turnTokenUsage: { ...turn.turnTokenUsage, inputTokens: 10, outputTokens: 2 },
        },
      });
      const accounted = yield* sql<{
        input_tokens: number;
        output_tokens: number;
        contract_revision: number | null;
      }>`SELECT input_tokens,output_tokens,contract_revision FROM task_usage_attempts WHERE provider_turn_id='fixture-turn'`;
      assert.equal(accounted[0]?.input_tokens, 110);
      assert.equal(accounted[0]?.output_tokens, 22);
      assert.isNull(accounted[0]?.contract_revision);
      const attempt = {
        id: "a",
        runId: "run-050",
        attemptOrdinal: 1,
        rootNodeId: "n",
        providerInstanceId: "codex",
        providerThreadId: "pt",
        providerTurnId: "fixture-turn",
        reason: "retry",
        status: "failed",
        startedAt: stamp,
        completedAt: stamp,
      };
      yield* sql`INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,provider_turn_id,status,payload_json) VALUES ('a','chat','run-050',1,'n','codex','pt','fixture-turn','failed',${yield* encodeJson(attempt)})`;
      const turnJson = yield* encodeJson({
        ...turn,
        startedAt: stamp,
        completedAt: stamp,
        modelIdentity: { requested: "requested", resolved: "resolved-model" },
      });
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,started_at,completed_at,payload_json) VALUES ('fixture-turn','chat','pt','n','a',1,'completed',${stamp},${stamp},${turnJson})`;
      const withEvidence = yield* service.detail(ThreadId.make("chat"), RunId.make("run-050"));
      assert.equal(withEvidence?.record.attempts[0]?.reason, "retry");
      assert.equal(withEvidence?.record.turns[0]?.turn.modelIdentity?.resolved, "resolved-model");
      assert.equal(withEvidence?.record.turns[0]?.accounting?.inputTokens, 110);
      assert.equal(withEvidence?.record.turns[0]?.accounting?.outputTokens, 22);

      // A second read comes from persisted rows, not a per-browser or process-local task cache.
      assert.equal((yield* service.list(0)).records[0]?.run.id, first.records[0]?.run.id);
    }).pipe(Effect.provide(layer)),
);
