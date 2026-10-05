// Synthetic file-backed databases are copied with node:sqlite. FileSystem has
// no equivalent for SQLite backup and integrity_check.
// @effect-diagnostics nodeBuiltinImport:off instanceOfSchema:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runBase3PolicyMigrations } from "./Base3PolicyMigrations.ts";

export class Base3SchemaImportError extends Schema.TaggedError<Base3SchemaImportError>()(
  "Base3SchemaImportError",
  { reason: Schema.String, detail: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return this.detail ?? `Base3 schema import failed (${this.reason}).`;
  }
}

const AMBIGUOUS_CLOUD_STATES = new Set([
  "pending",
  "running",
  "unknown",
  "ambiguous",
  "accepted",
  "dispatching",
]);

const TABLES: Record<
  string,
  { readonly columns: readonly string[]; readonly key: readonly string[] }
> = {
  projection_dispatcher_task_routes: {
    columns: ["thread_id", "message_id", "binding_json", "created_at"],
    key: ["thread_id", "message_id"],
  },
  projection_task_handoffs: {
    columns: [
      "handoff_id",
      "thread_id",
      "source_turn_id",
      "destination_message_id",
      "destination_turn_id",
      "target_json",
      "status",
      "failure_reason",
      "created_at",
      "updated_at",
    ],
    key: ["handoff_id"],
  },
  projection_workflow_cursors: {
    columns: ["project_id", "last_sequence"],
    key: ["project_id"],
  },
  projection_agent_profile_versions: {
    columns: ["project_id", "profile_id", "version", "profile_json"],
    key: ["project_id", "profile_id", "version"],
  },
  projection_workflow_template_versions: {
    columns: ["project_id", "template_id", "version", "template_json"],
    key: ["project_id", "template_id", "version"],
  },
  projection_workflow_runs: {
    columns: ["run_id", "project_id", "run_json", "created_at", "updated_at"],
    key: ["run_id"],
  },
  projection_workflow_stage_attempts: {
    columns: ["run_id", "stage_id", "attempt", "attempt_json"],
    key: ["run_id", "stage_id", "attempt"],
  },
  projection_workflow_artifacts: {
    columns: ["artifact_id", "run_id", "stage_id", "attempt", "artifact_json"],
    key: ["artifact_id"],
  },
  projection_workflow_decisions: {
    columns: ["decision_id", "run_id", "stage_id", "attempt", "decision_json"],
    key: ["decision_id"],
  },
  action_gate_approvals: {
    columns: [
      "approval_id",
      "environment_id",
      "fingerprint",
      "status",
      "idempotency_key",
      "created_at",
      "expires_at",
      "consumed_at",
      "payload_json",
    ],
    key: ["approval_id"],
  },
  action_gate_audit: {
    columns: ["event_id", "environment_id", "plan_id", "recorded_at", "payload_json"],
    key: ["event_id"],
  },
  dream_memories: {
    columns: [
      "memory_id",
      "environment_id",
      "actor_id",
      "project_id",
      "thread_id",
      "scope_kind",
      "status",
      "source_fingerprint",
      "content_present",
      "payload_json",
      "created_at",
      "updated_at",
    ],
    key: ["memory_id"],
  },
  dream_deleted_sources: {
    columns: ["source_fingerprint", "environment_id", "deleted_at"],
    key: ["source_fingerprint"],
  },
  dream_jobs: {
    columns: ["job_id", "environment_id", "status", "payload_json", "created_at"],
    key: ["job_id"],
  },
  dream_memory_audit: {
    columns: ["event_id", "environment_id", "recorded_at", "payload_json"],
    key: ["event_id"],
  },
  concurrency_budget_audit: {
    columns: ["event_id", "environment_id", "recorded_at", "payload_json"],
    key: ["event_id"],
  },
  router_turn_observations: {
    columns: ["observation_id", "environment_id", "recorded_at", "schema_version", "payload_json"],
    key: ["observation_id"],
  },
  router_policies: {
    columns: ["policy_id", "environment_id", "state", "created_at", "payload_json"],
    key: ["policy_id"],
  },
};

export interface Base3ImportResult {
  readonly batchId: string;
  readonly fingerprint: string;
  readonly copied: number;
  readonly held: number;
  readonly resumed: boolean;
}

const fail = (reason: string, detail?: string) =>
  new Base3SchemaImportError({ reason, ...(detail === undefined ? {} : { detail }) });

const isImportError = Schema.is(Base3SchemaImportError);

const sqlValue = (value: unknown): NodeSqlite.SQLInputValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  return String(value);
};

const exists = (database: NodeSqlite.DatabaseSync, table: string) =>
  database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !==
  undefined;

const sourceKey = (row: Record<string, unknown>, key: readonly string[]) =>
  key.map((column) => String(row[column] ?? "")).join(":");

/**
 * Copy Base3 policy rows into a migrated V2 file.
 * Approval status is copied verbatim. Ambiguous external writes are held
 * and are not inserted into the executable cloud table. A retry of an
 * interrupted batch does not duplicate mapped rows.
 */
export const importBase3Policy = (input: {
  readonly sourcePath: string;
  readonly destinationPath: string;
}) =>
  Effect.gen(function* () {
    yield* SqlClient.SqlClient;
    yield* runBase3PolicyMigrations;
    if (input.sourcePath.includes("/.t3/userdata")) {
      return yield* fail("real-data", "Refusing to import a live T3 home.");
    }
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return yield* Effect.try({
      try: () => importFiles(input, now),
      catch: (cause) =>
        isImportError(cause)
          ? cause
          : fail("import", cause instanceof Error ? cause.message : "import failed"),
    });
  });

function importFiles(
  input: { readonly sourcePath: string; readonly destinationPath: string },
  now: string,
): Base3ImportResult {
  const source = new NodeSqlite.DatabaseSync(input.sourcePath, { readOnly: true });
  const destination = new NodeSqlite.DatabaseSync(input.destinationPath);
  try {
    const sourceCheck = source.prepare("PRAGMA integrity_check").get() as {
      integrity_check?: string;
    };
    if (sourceCheck.integrity_check !== "ok") throw fail("integrity", sourceCheck.integrity_check);
    const fingerprint = NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(input.sourcePath))
      .digest("hex");
    const prior = destination
      .prepare(`SELECT batch_id, status FROM base3_import_batches WHERE source_fingerprint = ?`)
      .get(fingerprint) as { batch_id: string; status: string } | undefined;
    if (prior?.status === "complete") {
      const copied = destination
        .prepare(`SELECT COUNT(*) AS count FROM base3_import_map`)
        .get() as {
        count: number;
      };
      const held = destination
        .prepare(`SELECT COUNT(*) AS count FROM base3_import_holds`)
        .get() as {
        count: number;
      };
      return {
        batchId: prior.batch_id,
        fingerprint,
        copied: copied.count,
        held: held.count,
        resumed: true,
      };
    }
    const batchId = prior?.batch_id ?? `import:${fingerprint.slice(0, 16)}`;
    const resumed = prior !== undefined;
    if (!resumed) {
      destination
        .prepare(
          `INSERT INTO base3_import_batches (batch_id, source_fingerprint, status, started_at) VALUES (?, ?, 'running', ?)`,
        )
        .run(batchId, fingerprint, now);
    }
    let copied = 0;
    let held = 0;
    for (const [table, spec] of Object.entries(TABLES)) {
      if (!exists(source, table) || !exists(destination, table)) continue;
      const rows = source
        .prepare(`SELECT ${spec.columns.join(", ")} FROM ${table}`)
        .all() as Record<string, unknown>[];
      const insert = destination.prepare(
        `INSERT OR IGNORE INTO ${table} (${spec.columns.join(", ")}) VALUES (${spec.columns.map(() => "?").join(", ")})`,
      );
      const mapped = destination.prepare(
        `SELECT target_id FROM base3_import_map WHERE source_table = ? AND source_id = ?`,
      );
      const remember = destination.prepare(
        `INSERT OR IGNORE INTO base3_import_map (source_table, source_id, target_id) VALUES (?, ?, ?)`,
      );
      for (const row of rows) {
        const sourceId = sourceKey(row, spec.key);
        if (mapped.get(table, sourceId) !== undefined) continue;
        insert.run(...spec.columns.map((column) => sqlValue(row[column])));
        remember.run(table, sourceId, sourceId);
        copied += 1;
      }
    }
    if (exists(source, "cursor_cloud_operations")) {
      const rows = source
        .prepare(`SELECT command_id, state FROM cursor_cloud_operations`)
        .all() as {
        command_id: string;
        state: string;
      }[];
      const hold = destination.prepare(
        `INSERT OR IGNORE INTO base3_import_holds (source_table, source_id, reason) VALUES ('cursor_cloud_operations', ?, ?)`,
      );
      for (const row of rows) {
        if (!AMBIGUOUS_CLOUD_STATES.has(row.state)) continue;
        hold.run(row.command_id, `ambiguous:${row.state}`);
        held += 1;
      }
    }
    destination
      .prepare(
        `UPDATE base3_import_batches SET status = 'complete', finished_at = ? WHERE batch_id = ?`,
      )
      .run(now, batchId);
    return { batchId, fingerprint, copied, held, resumed };
  } finally {
    source.close();
    destination.close();
  }
}

export const backupAndCheck = (input: {
  readonly sourcePath: string;
  readonly backupPath: string;
}) =>
  Effect.try({
    try: () => {
      NodeFS.copyFileSync(input.sourcePath, input.backupPath);
      const source = new NodeSqlite.DatabaseSync(input.sourcePath, { readOnly: true });
      const backup = new NodeSqlite.DatabaseSync(input.backupPath, { readOnly: true });
      try {
        const check = (database: NodeSqlite.DatabaseSync) =>
          (database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string })
            .integrity_check;
        if (check(source) !== "ok" || check(backup) !== "ok") throw fail("integrity");
        for (const table of ["action_gate_approvals", "dream_memories", "dream_deleted_sources"]) {
          const count = (database: NodeSqlite.DatabaseSync) => {
            if (!exists(database, table)) return 0;
            return (
              database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
            ).count;
          };
          if (count(source) !== count(backup)) throw fail("backup-mismatch", table);
        }
      } finally {
        source.close();
        backup.close();
      }
    },
    catch: (cause) =>
      isImportError(cause)
        ? cause
        : fail("backup", cause instanceof Error ? cause.message : "backup failed"),
  });
