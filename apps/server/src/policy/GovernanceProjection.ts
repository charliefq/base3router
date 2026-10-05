import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  GovernanceReadError,
  GovernanceSnapshot,
  ORCHESTRATION_PROTOCOL_VERSION,
  type GovernanceApprovalProjection,
  type GovernanceLeaseProjection,
  type GovernanceMemoryProjection,
  type GovernanceRouteProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PolicyExecutionContext } from "./executionContext.ts";

const decodeSnapshot = Schema.decodeUnknownEffect(GovernanceSnapshot);

const routeFields = (
  json: string,
): Pick<GovernanceRouteProjection, "mode" | "model" | "instanceId"> => {
  try {
    const parsed = JSON.parse(json) as {
      readonly target?: { readonly model?: string; readonly instanceId?: string };
      readonly modelRoute?: { readonly mode?: string };
      readonly source?: string;
    };
    const declared = parsed.modelRoute?.mode;
    const mode =
      declared === "auto" || declared === "manual"
        ? declared
        : parsed.source === "explicit"
          ? "manual"
          : "unknown";
    return {
      mode,
      model: parsed.target?.model ?? null,
      instanceId: parsed.target?.instanceId ?? null,
    };
  } catch {
    return { mode: "unknown", model: null, instanceId: null };
  }
};

/**
 * Session-scoped governance read model. Thread filters narrow the view;
 * they are not an identity claim. Occupancy follows the lease row: projection
 * terminalization does not free a slot without provider confirmation.
 */
const isGovernanceReadError = Schema.is(GovernanceReadError);

export const readGovernanceSnapshot = (input: { readonly threadId?: string | undefined }) =>
  Effect.gen(function* () {
    const context = yield* PolicyExecutionContext;
    if (context.kind !== "session" && context.kind !== "kernel-test") {
      return yield* new GovernanceReadError({
        message: "Governance requires an authenticated session.",
      });
    }
    if (
      context.kind === "session" &&
      !context.scopes.includes(AuthOrchestrationReadScope) &&
      !context.scopes.includes(AuthOrchestrationOperateScope)
    ) {
      return yield* new GovernanceReadError({
        message: "The authenticated session is missing orchestration:read.",
      });
    }
    const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sqlOption)) {
      return yield* new GovernanceReadError({ message: "Policy store is unavailable." });
    }
    const sql = sqlOption.value;
    const threadId = input.threadId;
    const routeRows =
      threadId === undefined
        ? yield* sql<{
            readonly thread_id: string;
            readonly message_id: string;
            readonly binding_json: string;
            readonly created_at: string;
          }>`
            SELECT thread_id, message_id, binding_json, created_at
            FROM projection_dispatcher_task_routes
            ORDER BY created_at DESC
            LIMIT 40
          `
        : yield* sql<{
            readonly thread_id: string;
            readonly message_id: string;
            readonly binding_json: string;
            readonly created_at: string;
          }>`
            SELECT thread_id, message_id, binding_json, created_at
            FROM projection_dispatcher_task_routes
            WHERE thread_id = ${threadId}
            ORDER BY created_at DESC
            LIMIT 40
          `;
    const leaseRows =
      threadId === undefined
        ? yield* sql<{
            readonly lease_id: string;
            readonly thread_id: string;
            readonly message_id: string | null;
            readonly run_id: string | null;
            readonly workload_class: string;
            readonly status: string;
            readonly interrupt_requested: number;
            readonly disconnect_unconfirmed: number;
            readonly run_status: string | null;
          }>`
            SELECT l.lease_id, l.thread_id, l.message_id, l.run_id, l.workload_class, l.status,
              l.interrupt_requested, l.disconnect_unconfirmed, r.status AS run_status
            FROM base3_capacity_leases l
            LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = l.run_id
            WHERE l.released_at IS NULL
            ORDER BY l.created_at DESC
            LIMIT 40
          `
        : yield* sql<{
            readonly lease_id: string;
            readonly thread_id: string;
            readonly message_id: string | null;
            readonly run_id: string | null;
            readonly workload_class: string;
            readonly status: string;
            readonly interrupt_requested: number;
            readonly disconnect_unconfirmed: number;
            readonly run_status: string | null;
          }>`
            SELECT l.lease_id, l.thread_id, l.message_id, l.run_id, l.workload_class, l.status,
              l.interrupt_requested, l.disconnect_unconfirmed, r.status AS run_status
            FROM base3_capacity_leases l
            LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = l.run_id
            WHERE l.released_at IS NULL AND l.thread_id = ${threadId}
            ORDER BY l.created_at DESC
            LIMIT 40
          `;
    const approvalRows = yield* sql<{
      readonly approval_id: string;
      readonly status: string;
      readonly consumed_at: string | null;
    }>`
      SELECT approval_id, status, consumed_at
      FROM action_gate_approvals
      ORDER BY created_at DESC
      LIMIT 40
    `;
    const memoryRows =
      threadId === undefined
        ? yield* sql<{
            readonly memory_id: string;
            readonly status: string;
            readonly scope_kind: string;
            readonly content_present: number;
          }>`
            SELECT memory_id, status, scope_kind, content_present
            FROM dream_memories
            ORDER BY updated_at DESC
            LIMIT 40
          `
        : yield* sql<{
            readonly memory_id: string;
            readonly status: string;
            readonly scope_kind: string;
            readonly content_present: number;
          }>`
            SELECT memory_id, status, scope_kind, content_present
            FROM dream_memories
            WHERE thread_id = ${threadId}
            ORDER BY updated_at DESC
            LIMIT 40
          `;
    const deleted = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM dream_deleted_sources
    `;
    const routes: ReadonlyArray<GovernanceRouteProjection> = routeRows.map((row) => ({
      threadId: row.thread_id,
      messageId: row.message_id,
      createdAt: row.created_at,
      ...routeFields(row.binding_json),
    }));
    const leases: ReadonlyArray<GovernanceLeaseProjection> = leaseRows.map((row) => ({
      leaseId: row.lease_id,
      threadId: row.thread_id,
      messageId: row.message_id,
      runId: row.run_id,
      workloadClass: row.workload_class,
      status: row.status,
      interruptRequested: row.interrupt_requested === 1,
      disconnectUnconfirmed: row.disconnect_unconfirmed === 1,
      runStatus: row.run_status,
      occupied: row.status === "active",
    }));
    const approvals: ReadonlyArray<GovernanceApprovalProjection> = approvalRows.map((row) => ({
      approvalId: row.approval_id,
      status: row.status,
      consumedAt: row.consumed_at,
    }));
    const memories: ReadonlyArray<GovernanceMemoryProjection> = memoryRows.map((row) => ({
      memoryId: row.memory_id,
      status: row.status,
      scopeKind: row.scope_kind,
      contentPresent: row.content_present === 1,
    }));
    return yield* decodeSnapshot({
      protocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      ...(threadId === undefined ? {} : { threadId }),
      routes,
      leases,
      approvals,
      memories,
      deletedSourceCount: deleted[0]?.count ?? 0,
    });
  }).pipe(
    Effect.mapError((error) =>
      isGovernanceReadError(error)
        ? error
        : new GovernanceReadError({ message: "Policy store is unavailable." }),
    ),
  );
