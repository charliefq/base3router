import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  GovernanceSnapshot,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { readGovernanceSnapshot } from "./GovernanceProjection.ts";
import { PolicyExecutionContext } from "./executionContext.ts";

const session = {
  kind: "session" as const,
  actorId: "user-1",
  sessionId: "session-1",
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
};

it.effect("Internal Beta governance snapshot hides content and keeps unconfirmed occupancy", () =>
  Effect.gen(function* () {
    const absent = yield* Effect.flip(
      readGovernanceSnapshot({}).pipe(
        Effect.provideService(PolicyExecutionContext, { kind: "absent" }),
      ),
    );
    expect(absent.message).toContain("authenticated");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_dispatcher_task_routes (thread_id, message_id, binding_json, created_at)
      VALUES (
        'thread-1', 'message-1',
        '{"target":{"model":"gpt-5.4","instanceId":"codex-work"},"modelRoute":{"mode":"manual"}}',
        '2026-10-05T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO base3_capacity_leases (
        lease_id, environment_id, thread_id, message_id, run_id, parent_lease_id,
        workload_class, status, interrupt_requested, disconnect_unconfirmed, created_at
      ) VALUES (
        'lease-1', 'local', 'thread-1', 'message-1', NULL, NULL,
        'foreground-turn', 'active', 1, 1, '2026-10-05T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO action_gate_approvals (
        approval_id, environment_id, fingerprint, status, idempotency_key,
        created_at, expires_at, consumed_at, payload_json
      ) VALUES (
        'approval-1', 'local', 'fp', 'pending', NULL,
        '2026-10-05T00:00:00.000Z', '2026-10-05T01:00:00.000Z', NULL, '{"secret":"no"}'
      )
    `;
    yield* sql`
      INSERT INTO dream_memories (
        memory_id, environment_id, actor_id, project_id, thread_id, scope_kind, status,
        source_fingerprint, content_present, payload_json, created_at, updated_at
      ) VALUES (
        'memory-1', 'local', 'user-1', NULL, 'thread-1', 'personal', 'deleted',
        'fp', 0, '{"content":"hidden"}', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO dream_deleted_sources (source_fingerprint, environment_id, deleted_at)
      VALUES ('fp', 'local', '2026-10-05T00:00:00.000Z')
    `;
    const snapshot = yield* readGovernanceSnapshot({ threadId: "thread-1" }).pipe(
      Effect.provideService(PolicyExecutionContext, session),
    );
    expect(snapshot.protocolVersion).toBe(2);
    expect(snapshot.routes[0]?.mode).toBe("manual");
    expect(snapshot.routes[0]?.model).toBe("gpt-5.4");
    expect(snapshot.leases[0]?.occupied).toBe(true);
    expect(snapshot.leases[0]?.interruptRequested).toBe(true);
    expect(snapshot.leases[0]?.disconnectUnconfirmed).toBe(true);
    expect(snapshot.approvals[0]?.status).toBe("pending");
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(GovernanceSnapshot))(snapshot);
    expect(encoded).not.toContain("hidden");
    expect(encoded).not.toContain("secret");
    expect(snapshot.memories[0]?.contentPresent).toBe(false);
    expect(snapshot.memories[0]?.status).toBe("deleted");
    expect(snapshot.deletedSourceCount).toBe(1);
    const readOnly = yield* readGovernanceSnapshot({}).pipe(
      Effect.provideService(PolicyExecutionContext, {
        ...session,
        scopes: [AuthOrchestrationReadScope],
      }),
    );
    expect(readOnly.routes.length).toBe(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
