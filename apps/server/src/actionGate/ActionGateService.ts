import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ACTION_OUTCOME_CLASSES,
  ActionApprovalId,
  ActionApprovalRecord,
  ActionFingerprint,
  ActionGateDecision,
  ActionGateError,
  ActionGovernanceSnapshotV0,
  ActionId,
  ActionIdempotencyKey,
  MODEL_ROUTER_UNKNOWN_METRIC,
  ACTION_GATE_POLICY_VERSION,
  ProjectId,
  ThreadId,
  TurnId,
  type ActionApprovalStatus,
  type ActionAuditEventV0,
  type ActionGateRespondApprovalRequest,
  type ActionOutcomeClass,
  type EnvironmentId,
} from "@t3tools/contracts";
import { argumentSummary, makeActionAuditEvent } from "@t3tools/shared/actionAudit";
import {
  askIdempotencyKey,
  createPendingApproval,
  defaultDecisionForRisk,
  TERMINAL_APPROVAL_STATUSES,
} from "@t3tools/shared/actionGate";
import { buildExecutionPlan } from "@t3tools/shared/executionPlan";
import {
  FIRST_PARTY_DEVICE_TOOLS,
  FIRST_PARTY_PREVIEW_TOOLS,
  FIRST_PARTY_PULL_REQUEST_TOOLS,
  firstPartyMcpCatalog,
} from "@t3tools/shared/mcpCatalog";
import { routeMcp } from "@t3tools/shared/mcpRouter";
import { routeSkills } from "@t3tools/shared/skillRouter";
import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";

const ApprovalRow = Schema.Struct({
  approvalId: Schema.String,
  payloadJson: Schema.String,
});
const CountRow = Schema.Struct({
  count: Schema.Number,
});

const ApprovalJson = Schema.fromJsonString(ActionApprovalRecord);
const encodeApproval = Schema.encodeEffect(ApprovalJson);
const decodeApproval = Schema.decodeUnknownEffect(ApprovalJson);
const isActionGateError = Schema.is(ActionGateError);

const LIVE_STATUSES = new Set<ActionApprovalStatus>(["pending", "granted"]);

const toPersistenceError =
  (operation: string) =>
  (cause: unknown): PersistenceSqlError | PersistenceDecodeError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(`${operation}:codec`, cause)
      : new PersistenceSqlError({ operation, cause });

const toError =
  (operation: string) =>
  (cause: unknown): PersistenceSqlError | PersistenceDecodeError | ActionGateError =>
    isActionGateError(cause) ? cause : toPersistenceError(operation)(cause);

const uniqueConstraintConflict = (cause: unknown): boolean => {
  const text = cause instanceof Error ? `${cause.message} ${cause.name}` : String(cause);
  return /UNIQUE|unique constraint|SQLITE_CONSTRAINT/i.test(text);
};

const successorPending = (record: ActionApprovalRecord): ActionApprovalRecord => {
  const retryId = NodeCrypto.randomUUID();
  const { decidedAt: _decidedAt, consumedAt: _consumedAt, ...rest } = record;
  return {
    ...rest,
    approvalId: ActionApprovalId.make(`apr-${retryId}`),
    status: "pending",
    reasonCodes: ["APPROVAL_REQUIRED"],
    ...(record.idempotencyKey !== undefined
      ? { idempotencyKey: ActionIdempotencyKey.make(`ask-retry:${retryId}`) }
      : {}),
  };
};

export class ActionGateService extends Context.Service<
  ActionGateService,
  {
    readonly putApproval: (
      record: ActionApprovalRecord,
      options?: { readonly retry?: boolean },
    ) => Effect.Effect<
      ActionApprovalRecord,
      PersistenceSqlError | PersistenceDecodeError | ActionGateError
    >;
    readonly getApproval: (
      approvalId: ActionApprovalId,
    ) => Effect.Effect<
      Option.Option<ActionApprovalRecord>,
      PersistenceSqlError | PersistenceDecodeError
    >;
    readonly respond: (
      input: ActionGateRespondApprovalRequest,
      nowIso: string,
    ) => Effect.Effect<
      ActionApprovalRecord,
      PersistenceSqlError | PersistenceDecodeError | ActionGateError
    >;
    readonly consume: (
      approvalId: ActionApprovalId,
      fingerprint: ActionFingerprint,
      nowIso: string,
    ) => Effect.Effect<
      ActionApprovalRecord,
      PersistenceSqlError | PersistenceDecodeError | ActionGateError
    >;
    readonly waitForAuthorized: (
      approvalId: ActionApprovalId,
      fingerprint: ActionFingerprint,
      nowIso: string,
    ) => Effect.Effect<
      ActionApprovalRecord,
      PersistenceSqlError | PersistenceDecodeError | ActionGateError
    >;
    readonly appendAudit: (
      event: ActionAuditEventV0,
    ) => Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError>;
    readonly governance: (
      environmentId: EnvironmentId,
      counts: {
        readonly configuredSkillCount: number;
        readonly enabledSkillCount: number;
        readonly enabledMcpServerCount: number;
        readonly configuredMcpServerCount: number;
        readonly degradedMcpServerCount: number;
      },
    ) => Effect.Effect<ActionGovernanceSnapshotV0, PersistenceSqlError | PersistenceDecodeError>;
    readonly authorizeTool: (input: {
      readonly toolName: string;
      readonly args: unknown;
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly retry?: boolean;
    }) => Effect.Effect<
      ActionGateDecision,
      PersistenceSqlError | PersistenceDecodeError | ActionGateError
    >;
  }
>()("t3/actionGate/ActionGateService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const waiters = new Map<string, Set<Deferred.Deferred<void, never>>>();

  const notifyWaiters = (approvalId: string) =>
    Effect.gen(function* () {
      const pending = waiters.get(approvalId);
      if (pending === undefined) return;
      waiters.delete(approvalId);
      yield* Effect.forEach(
        pending,
        (deferred) => Deferred.succeed(deferred, undefined).pipe(Effect.ignore),
        { discard: true },
      );
    });

  const registerWaiter = (approvalId: string, deferred: Deferred.Deferred<void, never>) =>
    Effect.sync(() => {
      const set = waiters.get(approvalId) ?? new Set<Deferred.Deferred<void, never>>();
      set.add(deferred);
      waiters.set(approvalId, set);
    });

  const unregisterWaiter = (approvalId: string, deferred: Deferred.Deferred<void, never>) =>
    Effect.sync(() => {
      const set = waiters.get(approvalId);
      if (set === undefined) return;
      set.delete(deferred);
      if (set.size === 0) waiters.delete(approvalId);
    });

  const remainingWaiters = (approvalId: string) => waiters.get(approvalId)?.size ?? 0;

  const decodeRow = (payloadJson: string) => decodeApproval(payloadJson);

  const getApproval: ActionGateService["Service"]["getApproval"] = (approvalId) =>
    sql<typeof ApprovalRow.Type>`
      SELECT approval_id AS "approvalId", payload_json AS "payloadJson"
      FROM action_gate_approvals
      WHERE approval_id = ${approvalId}
    `.pipe(
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (row === undefined) return Effect.succeed(Option.none());
        return decodeRow(row.payloadJson).pipe(Effect.map(Option.some));
      }),
      Effect.mapError(toPersistenceError("ActionGateService.getApproval")),
    );

  const loadByIdempotency = (environmentId: EnvironmentId, idempotencyKey: string) =>
    sql<typeof ApprovalRow.Type>`
      SELECT approval_id AS "approvalId", payload_json AS "payloadJson"
      FROM action_gate_approvals
      WHERE environment_id = ${environmentId} AND idempotency_key = ${idempotencyKey}
    `.pipe(
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (row === undefined) return Effect.succeed(Option.none());
        return decodeRow(row.payloadJson).pipe(Effect.map(Option.some));
      }),
    );

  const loadLiveByFingerprint = (environmentId: EnvironmentId, fingerprint: string) =>
    sql<typeof ApprovalRow.Type>`
      SELECT approval_id AS "approvalId", payload_json AS "payloadJson"
      FROM action_gate_approvals
      WHERE environment_id = ${environmentId}
        AND fingerprint = ${fingerprint}
        AND status IN ('pending', 'granted')
      ORDER BY created_at ASC, approval_id ASC
      LIMIT 1
    `.pipe(
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (row === undefined) return Effect.succeed(Option.none());
        return decodeRow(row.payloadJson).pipe(Effect.map(Option.some));
      }),
    );

  const loadConsumedByFingerprint = (environmentId: EnvironmentId, fingerprint: string) =>
    sql<typeof ApprovalRow.Type>`
      SELECT approval_id AS "approvalId", payload_json AS "payloadJson"
      FROM action_gate_approvals
      WHERE environment_id = ${environmentId}
        AND fingerprint = ${fingerprint}
        AND status = 'consumed'
      ORDER BY created_at ASC, approval_id ASC
      LIMIT 1
    `.pipe(
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (row === undefined) return Effect.succeed(Option.none());
        return decodeRow(row.payloadJson).pipe(Effect.map(Option.some));
      }),
    );

  const appendAudit: ActionGateService["Service"]["appendAudit"] = (event) =>
    sql`
      INSERT INTO action_gate_audit (event_id, environment_id, plan_id, recorded_at, payload_json)
      VALUES (
        ${event.eventId}, ${event.environmentId}, ${event.planId}, ${event.at},
        ${JSON.stringify({
          kind: event.kind,
          reasonCodes: event.reasonCodes,
          policyVersion: event.policyVersion,
          outcome: event.outcome,
          decision: event.decision,
        })}
      )
      ON CONFLICT(event_id) DO NOTHING
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceError("ActionGateService.appendAudit")));

  const resolveExisting = (record: ActionApprovalRecord) =>
    Effect.gen(function* () {
      if (record.idempotencyKey !== undefined) {
        const byKey = yield* loadByIdempotency(record.environmentId, record.idempotencyKey);
        if (Option.isSome(byKey)) return byKey.value;
      }
      const byId = yield* getApproval(record.approvalId);
      if (Option.isSome(byId)) return byId.value;
      const live = yield* loadLiveByFingerprint(record.environmentId, record.fingerprint);
      if (Option.isSome(live)) return live.value;
      return yield* new ActionGateError({
        reason: "conflict",
        detail: "Approval insert collided without a readable existing row.",
      });
    });

  const putApproval: ActionGateService["Service"]["putApproval"] = (record, options) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const payloadJson = yield* encodeApproval(record);
          const inserted = yield* sql<{ approvalId: string }>`
            INSERT INTO action_gate_approvals (
              approval_id, environment_id, fingerprint, status, idempotency_key,
              created_at, expires_at, consumed_at, payload_json
            ) VALUES (
              ${record.approvalId}, ${record.environmentId}, ${record.fingerprint}, ${record.status},
              ${record.idempotencyKey ?? null}, ${record.createdAt}, ${record.expiresAt},
              ${record.consumedAt ?? null}, ${payloadJson}
            )
            ON CONFLICT DO NOTHING
            RETURNING approval_id AS "approvalId"
          `;
          if (inserted[0] !== undefined) return record;
          const existing = yield* resolveExisting(record);
          if (existing.fingerprint !== record.fingerprint) {
            return yield* new ActionGateError({
              reason: "conflict",
              detail: "Idempotency key is bound to a different action fingerprint.",
            });
          }
          if (TERMINAL_APPROVAL_STATUSES.has(existing.status)) {
            if (existing.status === "consumed" || options?.retry !== true) {
              return yield* new ActionGateError({
                reason: "conflict",
                detail:
                  existing.status === "consumed"
                    ? `Approval cannot be resurrected from ${existing.status}.`
                    : `Approval cannot be resurrected from ${existing.status} without an explicit retry.`,
              });
            }
            const consumed = yield* loadConsumedByFingerprint(
              record.environmentId,
              record.fingerprint,
            );
            if (Option.isSome(consumed)) {
              return yield* new ActionGateError({
                reason: "conflict",
                detail: "Approval cannot be resurrected from consumed.",
              });
            }
            const successor = successorPending(record);
            const successorJson = yield* encodeApproval(successor);
            const retried = yield* sql<{ approvalId: string }>`
              INSERT INTO action_gate_approvals (
                approval_id, environment_id, fingerprint, status, idempotency_key,
                created_at, expires_at, consumed_at, payload_json
              ) VALUES (
                ${successor.approvalId}, ${successor.environmentId}, ${successor.fingerprint},
                ${successor.status}, ${successor.idempotencyKey ?? null}, ${successor.createdAt},
                ${successor.expiresAt}, ${successor.consumedAt ?? null}, ${successorJson}
              )
              ON CONFLICT DO NOTHING
              RETURNING approval_id AS "approvalId"
            `;
            if (retried[0] !== undefined) return successor;
            const live = yield* loadLiveByFingerprint(
              successor.environmentId,
              successor.fingerprint,
            );
            if (Option.isSome(live) && live.value.fingerprint === successor.fingerprint) {
              return live.value;
            }
            return yield* new ActionGateError({
              reason: "conflict",
              detail: `Approval cannot be resurrected from ${existing.status}.`,
            });
          }
          return existing;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          uniqueConstraintConflict(cause)
            ? new ActionGateError({
                reason: "conflict",
                detail: "Approval uniqueness conflict.",
              })
            : toError("ActionGateService.putApproval")(cause),
        ),
      );

  const writeExpired = (record: ActionApprovalRecord, nowIso: string) =>
    Effect.gen(function* () {
      const expired: ActionApprovalRecord = {
        ...record,
        status: "expired",
        decidedAt: nowIso,
        reasonCodes: ["APPROVAL_EXPIRED"],
      };
      const payloadJson = yield* encodeApproval(expired);
      const updated = yield* sql<{ approvalId: string }>`
        UPDATE action_gate_approvals
        SET status = 'expired', payload_json = ${payloadJson}
        WHERE approval_id = ${record.approvalId} AND status IN ('pending', 'granted')
        RETURNING approval_id AS "approvalId"
      `;
      if (updated[0] === undefined) {
        const latest = yield* getApproval(record.approvalId);
        return Option.getOrElse(latest, () => expired);
      }
      yield* appendAudit(
        makeActionAuditEvent({
          kind: "approval.expired",
          at: nowIso,
          environmentId: record.environmentId,
          planId: record.planId,
          actionId: record.actionId,
          decision: "DENY",
          outcome: "denied",
          reasonCodes: ["APPROVAL_EXPIRED"],
          fingerprint: record.fingerprint,
          approvalId: record.approvalId,
        }),
      );
      return expired;
    });

  const expireIfDue = (record: ActionApprovalRecord, nowIso: string) => {
    if (!LIVE_STATUSES.has(record.status)) return Effect.succeed(record);
    if (Date.parse(record.expiresAt) > Date.parse(nowIso)) return Effect.succeed(record);
    return writeExpired(record, nowIso);
  };

  const respond: ActionGateService["Service"]["respond"] = (input, nowIso) =>
    Effect.gen(function* () {
      const next = yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* getApproval(input.approvalId);
          if (Option.isNone(current)) {
            return yield* new ActionGateError({
              reason: "not_found",
              detail: "Approval was not found.",
            });
          }
          const record = yield* expireIfDue(current.value, nowIso);
          const status =
            input.decision === "grant"
              ? ("granted" as const)
              : input.decision === "deny"
                ? ("denied" as const)
                : ("cancelled" as const);
          if (record.status !== "pending") {
            if (status === "granted" && record.status === "granted") return record;
            if (status === "granted" && record.status === "consumed") {
              return yield* new ActionGateError({
                reason: "replay",
                detail: "One-time approval already consumed.",
              });
            }
            if (record.status === "expired") {
              return record;
            }
            return yield* new ActionGateError({
              reason: "conflict",
              detail: `Approval is already ${record.status}.`,
            });
          }
          const decided: ActionApprovalRecord = {
            ...record,
            status,
            decidedAt: nowIso,
            reasonCodes:
              status === "granted"
                ? ["ACTION_ALLOWED"]
                : status === "denied"
                  ? ["APPROVAL_DENIED"]
                  : ["APPROVAL_CANCELLED"],
          };
          const payloadJson = yield* encodeApproval(decided);
          const updated = yield* sql<{ approvalId: string }>`
            UPDATE action_gate_approvals
            SET status = ${status}, payload_json = ${payloadJson}
            WHERE approval_id = ${input.approvalId} AND status = 'pending'
            RETURNING approval_id AS "approvalId"
          `;
          if (updated[0] === undefined) {
            const latest = yield* getApproval(input.approvalId);
            if (Option.isNone(latest)) {
              return yield* new ActionGateError({
                reason: "not_found",
                detail: "Approval was not found.",
              });
            }
            if (status === "granted" && latest.value.status === "granted") return latest.value;
            if (status === "granted" && latest.value.status === "consumed") {
              return yield* new ActionGateError({
                reason: "replay",
                detail: "One-time approval already consumed.",
              });
            }
            return yield* new ActionGateError({
              reason: "conflict",
              detail: `Approval is already ${latest.value.status}.`,
            });
          }
          yield* appendAudit(
            makeActionAuditEvent({
              kind:
                status === "granted"
                  ? "approval.granted"
                  : status === "denied"
                    ? "approval.denied"
                    : "approval.cancelled",
              at: nowIso,
              environmentId: decided.environmentId,
              planId: decided.planId,
              actionId: decided.actionId,
              decision: status === "granted" ? "ALLOW" : "DENY",
              reasonCodes: decided.reasonCodes,
              fingerprint: decided.fingerprint,
              approvalId: decided.approvalId,
              ...(status === "granted"
                ? {}
                : { outcome: status === "denied" ? ("denied" as const) : ("cancelled" as const) }),
            }),
          );
          return decided;
        }),
      );
      yield* notifyWaiters(next.approvalId);
      if (next.status === "expired") {
        return yield* new ActionGateError({
          reason: "expired",
          detail: "Approval expired before a decision was recorded.",
        });
      }
      return next;
    }).pipe(Effect.mapError(toError("ActionGateService.respond")));

  const consume: ActionGateService["Service"]["consume"] = (approvalId, fingerprint, nowIso) =>
    Effect.gen(function* () {
      const current = yield* getApproval(approvalId);
      if (Option.isNone(current)) {
        return yield* new ActionGateError({
          reason: "not_found",
          detail: "Approval was not found.",
        });
      }
      const record = yield* expireIfDue(current.value, nowIso);
      if (record.fingerprint !== fingerprint) {
        return yield* new ActionGateError({
          reason: "conflict",
          detail: "Approval fingerprint does not match the planned action.",
        });
      }
      if (record.status === "consumed") {
        return yield* new ActionGateError({
          reason: "replay",
          detail: "One-time approval already consumed.",
        });
      }
      if (record.status === "expired") {
        return yield* new ActionGateError({
          reason: "expired",
          detail: "Approval expired before consumption.",
        });
      }
      if (record.status !== "granted") {
        return yield* new ActionGateError({
          reason: "conflict",
          detail: `Approval cannot be consumed from ${record.status}.`,
        });
      }
      if (record.reusePolicy === "explicit-reuse") return record;
      const consumed: ActionApprovalRecord = {
        ...record,
        status: "consumed",
        consumedAt: nowIso,
        reasonCodes: ["APPROVAL_CONSUMED"],
      };
      const payloadJson = yield* encodeApproval(consumed);
      const updated = yield* sql<{ approvalId: string }>`
        UPDATE action_gate_approvals
        SET status = 'consumed', consumed_at = ${nowIso}, payload_json = ${payloadJson}
        WHERE approval_id = ${approvalId} AND status = 'granted' AND fingerprint = ${fingerprint}
        RETURNING approval_id AS "approvalId"
      `;
      if (updated[0] === undefined) {
        return yield* new ActionGateError({
          reason: "replay",
          detail: "Concurrent one-time approval consumption was rejected.",
        });
      }
      yield* appendAudit(
        makeActionAuditEvent({
          kind: "approval.consumed",
          at: nowIso,
          environmentId: consumed.environmentId,
          planId: consumed.planId,
          actionId: consumed.actionId,
          decision: "ALLOW",
          reasonCodes: ["APPROVAL_CONSUMED"],
          fingerprint: consumed.fingerprint,
          approvalId: consumed.approvalId,
        }),
      );
      yield* notifyWaiters(approvalId);
      return consumed;
    }).pipe(Effect.mapError(toError("ActionGateService.consume")));

  const failureFromStatus = (record: ActionApprovalRecord): ActionGateError => {
    if (record.status === "expired") {
      return new ActionGateError({
        reason: "expired",
        detail: "Approval expired before execution.",
      });
    }
    if (record.status === "consumed") {
      return new ActionGateError({
        reason: "replay",
        detail: "One-time approval already consumed.",
      });
    }
    return new ActionGateError({
      reason: "conflict",
      detail: `Approval is ${record.status}.`,
    });
  };

  const waitUntilNotPending = (approvalId: ActionApprovalId, nowIso: string) =>
    Effect.gen(function* () {
      while (true) {
        const current = yield* getApproval(approvalId);
        if (Option.isNone(current)) {
          return yield* new ActionGateError({
            reason: "not_found",
            detail: "Approval was not found.",
          });
        }
        const record = yield* expireIfDue(current.value, nowIso);
        if (record.status !== "pending") return record;
        const deferred = yield* Deferred.make<void>();
        yield* registerWaiter(approvalId, deferred);
        const timeoutMs = Math.max(0, Date.parse(record.expiresAt) - Date.parse(nowIso));
        const woke = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOption(timeoutMs),
          Effect.interruptible,
          Effect.onInterrupt(() => unregisterWaiter(approvalId, deferred)),
        );
        yield* unregisterWaiter(approvalId, deferred);
        if (Option.isNone(woke)) {
          const latest = yield* getApproval(approvalId);
          if (Option.isSome(latest)) yield* expireIfDue(latest.value, record.expiresAt);
        }
      }
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          if (remainingWaiters(approvalId) > 0) return;
          yield* respond({ approvalId, decision: "cancel" }, nowIso).pipe(Effect.ignore);
        }),
      ),
    );

  const waitForAuthorized: ActionGateService["Service"]["waitForAuthorized"] = (
    approvalId,
    fingerprint,
    nowIso,
  ) =>
    Effect.gen(function* () {
      const settled = yield* waitUntilNotPending(approvalId, nowIso);
      if (settled.status === "granted" || settled.status === "consumed") {
        if (settled.status === "consumed") {
          return yield* new ActionGateError({
            reason: "replay",
            detail: "One-time approval already consumed.",
          });
        }
        return yield* consume(approvalId, fingerprint, DateTime.formatIso(yield* DateTime.now));
      }
      return yield* failureFromStatus(settled);
    }).pipe(
      Effect.mapError(toError("ActionGateService.waitForAuthorized")),
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          if (remainingWaiters(approvalId) > 0) return;
          const current = yield* getApproval(approvalId);
          if (Option.isNone(current) || current.value.status !== "pending") return;
          yield* respond({ approvalId, decision: "cancel" }, nowIso);
        }).pipe(Effect.ignore),
      ),
    );

  const countStatus = (environmentId: EnvironmentId, status: string) =>
    sql<typeof CountRow.Type>`
      SELECT COUNT(*) AS "count" FROM action_gate_approvals
      WHERE environment_id = ${environmentId} AND status = ${status}
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

  const listPending = (environmentId: EnvironmentId) =>
    sql<typeof ApprovalRow.Type>`
      SELECT approval_id AS "approvalId", payload_json AS "payloadJson"
      FROM action_gate_approvals
      WHERE environment_id = ${environmentId} AND status = 'pending'
      ORDER BY created_at ASC, approval_id ASC
      LIMIT 32
    `.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => decodeRow(row.payloadJson), { concurrency: 1 }),
      ),
    );

  const recentOutcomesFor = (environmentId: EnvironmentId) =>
    sql<{ payloadJson: string }>`
      SELECT payload_json AS "payloadJson"
      FROM action_gate_audit
      WHERE environment_id = ${environmentId}
      ORDER BY recorded_at DESC, event_id DESC
      LIMIT 8
    `.pipe(
      Effect.map((rows) =>
        rows.flatMap((row) => {
          try {
            const parsed = JSON.parse(row.payloadJson) as { readonly outcome?: unknown };
            return typeof parsed.outcome === "string" &&
              (ACTION_OUTCOME_CLASSES as ReadonlyArray<string>).includes(parsed.outcome)
              ? [parsed.outcome as ActionOutcomeClass]
              : [];
          } catch {
            return [];
          }
        }),
      ),
    );

  const governance: ActionGateService["Service"]["governance"] = (environmentId, counts) =>
    Effect.gen(function* () {
      const pendingCount = yield* countStatus(environmentId, "pending");
      const denied = yield* countStatus(environmentId, "denied");
      const expired = yield* countStatus(environmentId, "expired");
      const pending = yield* listPending(environmentId);
      const recentOutcomes = yield* recentOutcomesFor(environmentId);
      return {
        environmentId,
        policyVersion: ACTION_GATE_POLICY_VERSION,
        ...counts,
        pendingApprovalCount: pendingCount,
        deniedCount: denied,
        expiredCount: expired,
        recentOutcomes,
        preventedUnsafeCount: denied,
        knownCostUsd: MODEL_ROUTER_UNKNOWN_METRIC,
        estimatedCostUsd: MODEL_ROUTER_UNKNOWN_METRIC,
        compliance: pendingCount > 0 ? ("attention" as const) : ("compliant" as const),
        pending,
      } satisfies ActionGovernanceSnapshotV0;
    }).pipe(Effect.mapError(toPersistenceError("ActionGateService.governance")));

  const FIRST_PARTY_TOOLS = [
    ...FIRST_PARTY_PREVIEW_TOOLS,
    ...FIRST_PARTY_DEVICE_TOOLS,
    ...FIRST_PARTY_PULL_REQUEST_TOOLS,
  ];

  const authorizeTool: ActionGateService["Service"]["authorizeTool"] = (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const expiresAt = DateTime.formatIso(DateTime.add(now, { minutes: 5 }));
      const spec = FIRST_PARTY_TOOLS.find((tool) => tool.name === input.toolName);
      const serverId =
        spec?.capability === "device"
          ? "t3-device"
          : spec?.capability === "pull-requests"
            ? "t3-pull-requests"
            : "t3-preview";
      const toolId = `${serverId}/${input.toolName}`;
      const skillRoute = routeSkills({ mode: "auto", nowIso, catalog: [] });
      const mcpRoute = routeMcp({
        mode: "auto",
        nowIso,
        catalog: firstPartyMcpCatalog(nowIso),
      });
      const plan = buildExecutionPlan({
        turnId: TurnId.make(input.threadId),
        threadId: input.threadId,
        projectId: ProjectId.make("unbound"),
        environmentId: input.environmentId,
        nowIso,
        expiresAt,
        modelRoute: null,
        skillRoute,
        mcpRoute,
        actions: [
          {
            serverId,
            toolId,
            arguments: input.args,
            schemaDigest: spec?.name ?? "unknown",
            riskClass: spec?.riskClass ?? "unclassified",
            sideEffectClass: spec?.sideEffectClass ?? "unknown",
          },
        ],
      });
      const action = plan.actions[0];
      if (action === undefined) {
        return yield* new ActionGateError({
          reason: "invalid",
          detail: "Execution plan did not bind an action.",
        });
      }
      const defaults = defaultDecisionForRisk({
        riskClass: action.riskClass,
        sideEffectClass: action.sideEffectClass,
        mayExposeSecrets: spec?.name === "preview_snapshot" || spec?.name === "device_screenshot",
      });
      if (defaults.decision === "ALLOW") {
        yield* appendAudit(
          makeActionAuditEvent({
            kind: "action.started",
            at: nowIso,
            environmentId: input.environmentId,
            planId: plan.planId,
            actionId: action.actionId,
            decision: "ALLOW",
          }),
        );
        return {
          policyVersion: ACTION_GATE_POLICY_VERSION,
          actionId: action.actionId,
          decision: "ALLOW",
          riskClass: action.riskClass,
          sideEffectClass: action.sideEffectClass,
          fingerprint: action.fingerprint,
          reasonCodes: defaults.reasonCodes,
          explanation: "ActionGate allowed this action.",
          requiresApproval: false,
        } satisfies ActionGateDecision;
      }
      if (defaults.decision === "DENY") {
        yield* appendAudit(
          makeActionAuditEvent({
            kind: "action.gate.decided",
            at: nowIso,
            environmentId: input.environmentId,
            planId: plan.planId,
            actionId: action.actionId,
            decision: "DENY",
            outcome: "denied",
          }),
        );
        return {
          policyVersion: ACTION_GATE_POLICY_VERSION,
          actionId: action.actionId,
          decision: "DENY",
          riskClass: action.riskClass,
          sideEffectClass: action.sideEffectClass,
          fingerprint: action.fingerprint,
          reasonCodes: defaults.reasonCodes,
          explanation: "ActionGate denied this action.",
          requiresApproval: false,
        } satisfies ActionGateDecision;
      }
      const approval = yield* putApproval(
        createPendingApproval({
          approvalId: ActionApprovalId.make(`apr-${action.fingerprint.slice(0, 24)}`),
          plan,
          action,
          nowIso,
          expiresAt: plan.expiresAt ?? expiresAt,
          idempotencyKey: askIdempotencyKey(action.fingerprint),
          threadId: input.threadId,
          projectId: ProjectId.make("unbound"),
          argumentSummary: argumentSummary(input.args),
          askExplanation: "ActionGate requires a one-time exact-action approval before execution.",
        }),
        { retry: input.retry === true },
      );
      yield* appendAudit(
        makeActionAuditEvent({
          kind: "approval.requested",
          at: nowIso,
          environmentId: input.environmentId,
          planId: plan.planId,
          actionId: action.actionId,
          decision: "ASK",
          approvalId: approval.approvalId,
        }),
      );
      return {
        policyVersion: ACTION_GATE_POLICY_VERSION,
        actionId: action.actionId,
        decision: "ASK",
        riskClass: action.riskClass,
        sideEffectClass: action.sideEffectClass,
        fingerprint: action.fingerprint,
        reasonCodes: defaults.reasonCodes,
        explanation: "ActionGate requires a one-time exact-action approval before execution.",
        requiresApproval: true,
        approvalId: approval.approvalId,
      } satisfies ActionGateDecision;
    }).pipe(Effect.mapError(toError("ActionGateService.authorizeTool")));

  return {
    putApproval,
    getApproval,
    respond,
    consume,
    waitForAuthorized,
    appendAudit,
    governance,
    authorizeTool,
  } satisfies ActionGateService["Service"];
});

export const layer = Layer.effect(ActionGateService, make);

const emptyGovernance = (environmentId: EnvironmentId): ActionGovernanceSnapshotV0 => ({
  environmentId,
  policyVersion: ACTION_GATE_POLICY_VERSION,
  configuredSkillCount: 0,
  enabledSkillCount: 0,
  configuredMcpServerCount: 0,
  enabledMcpServerCount: 0,
  degradedMcpServerCount: 0,
  pendingApprovalCount: 0,
  deniedCount: 0,
  expiredCount: 0,
  recentOutcomes: [],
  preventedUnsafeCount: 0,
  knownCostUsd: MODEL_ROUTER_UNKNOWN_METRIC,
  estimatedCostUsd: MODEL_ROUTER_UNKNOWN_METRIC,
  compliance: "unknown",
  pending: [],
});

export const layerTest = Layer.succeed(
  ActionGateService,
  ActionGateService.of({
    putApproval: (record) => Effect.succeed(record),
    getApproval: () => Effect.succeed(Option.none()),
    respond: () =>
      Effect.fail(
        new ActionGateError({ reason: "not_found", detail: "Test ActionGate has no approvals." }),
      ),
    consume: () =>
      Effect.fail(
        new ActionGateError({ reason: "not_found", detail: "Test ActionGate has no approvals." }),
      ),
    waitForAuthorized: () =>
      Effect.fail(
        new ActionGateError({ reason: "not_found", detail: "Test ActionGate has no approvals." }),
      ),
    appendAudit: () => Effect.void,
    governance: (environmentId) => Effect.succeed(emptyGovernance(environmentId)),
    authorizeTool: () =>
      Effect.succeed({
        policyVersion: ACTION_GATE_POLICY_VERSION,
        actionId: ActionId.make("action-test"),
        decision: "ALLOW",
        riskClass: "read-only-local",
        sideEffectClass: "read",
        fingerprint: ActionFingerprint.make("0".repeat(64)),
        reasonCodes: ["ACTION_ALLOWED"],
        explanation: "Test ActionGate allows tools.",
        requiresApproval: false,
      }),
  }),
);
