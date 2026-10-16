import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import {
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2ProviderEventIngestorLayerLive,
} from "./runtimeLayer.ts";

// Build the actual production composition, not ProviderReplayHarness's ingestor.
const production = Layer.mergeAll(
  OrchestrationV2EventSinkLayerLive,
  OrchestrationV2ProviderEventIngestorLayerLive,
).pipe(Layer.provide(SqlitePersistenceMemory));

it.live.each([true, false])(
  "production composition retains captured SQL across detached ingestion (confirmed=%s)",
  (terminationConfirmed) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`production-text-${terminationConfirmed}`);
        const runId = RunId.make(`production-run-${terminationConfirmed}`);
        const driver = ProviderDriverKind.make("openrouter");
        const instanceId = ProviderInstanceId.make("production-text-fixture");
        const thread: OrchestrationV2AppThread = {
          id: threadId,
          projectId: ProjectId.make("fixture-project"),
          title: "LOCAL/FIXTURE production composition",
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "openrouter/auto" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
          forkedFrom: null,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make(`thread-event:${threadId}`),
              type: "thread.created",
              threadId,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: thread,
            },
          ],
        });
        const iso = DateTime.formatIso(now);
        // This test isolates production service composition; governed admission is covered separately.
        yield* sql`INSERT INTO base3_capacity_leases (lease_id,environment_id,thread_id,message_id,run_id,workload_class,status,interrupt_requested,disconnect_unconfirmed,created_at) VALUES (${`fixture:${threadId}`},'fixture',${threadId},${MessageId.make(`message:${threadId}`)},${runId},'foreground-turn','active',0,0,${iso})`;
        const ingest = ingestor.ingestNormalized({
          providerSessionId: ProviderSessionId.make("production-fixture-session"),
          providerInstanceId: instanceId,
          threadId,
          runId,
          event: {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              id: ProviderTurnId.make(`production-turn:${threadId}`),
              providerThreadId: ProviderThreadId.make(`production-provider-thread:${threadId}`),
              nodeId: NodeId.make(`production-root:${threadId}`),
              runAttemptId: null,
              nativeTurnRef: null,
              ordinal: 1,
              status: terminationConfirmed ? "completed" : "failed",
              startedAt: now,
              completedAt: now,
              terminationConfirmed,
            },
          },
        });
        // Detached workers need the construction-time SQL service: erase all caller services.
        const stored = yield* ingest.pipe(Effect.provide(Context.empty()));
        assert.isAbove(stored.length, 0);
        const leases = yield* sql<{
          released_at: string | null;
          disconnect_unconfirmed: number;
        }>`SELECT released_at,disconnect_unconfirmed FROM base3_capacity_leases WHERE thread_id=${threadId}`;
        assert.equal(leases[0]?.released_at !== null, terminationConfirmed);
        assert.equal(leases[0]?.disconnect_unconfirmed, terminationConfirmed ? 0 : 1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(production, SqlitePersistenceMemory))),
);
