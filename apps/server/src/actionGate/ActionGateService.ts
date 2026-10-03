import * as Context from "effect/Context";
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
  MODEL_ROUTER_UNKNOWN_METRIC,
  ACTION_GATE_POLICY_VERSION,
  ProjectId,
  ThreadId,
  TurnId,
  type ActionAuditEventV0,
  type ActionGateRespondApprovalRequest,
  type ActionOutcomeClass,
  type EnvironmentId,
} from "@t3tools/contracts";
import { createPendingApproval, defaultDecisionForRisk } from "@t3tools/shared/actionGate";
import { makeActionAuditEvent } from "@t3tools/shared/actionAudit";
import { buildExecutionPlan } from "@t3tools/shared/executionPlan";
import {
  FIRST_PARTY_DEVICE_TOOLS,
  FIRST_PARTY_PREVIEW_TOOLS,
  FIRST_PARTY_PULL_REQUEST_TOOLS,
  firstPartyMcpCatalog,
} from "@t3tools/shared/mcpCatalog";
import { routeMcp } from "@t3tools/shared/mcpRouter";
import { routeSkills } from "@t3tools/shared/skillRouter";
import * as DateTime from "effect/DateTime";
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

const toPersistenceError =
  (operation: string) =>
  (cause: unknown): PersistenceSqlError | PersistenceDecodeError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(`${operation}:codec`, cause)
      : new PersistenceSqlError({ operation, cause });

const toError =
  (operation: string) =>
  (cause: unknown): PersistenceSqlError | PersistenceDecodeError | ActionGateError =>
    Schema.is(ActionGateError)(cause) ? cause : toPersistenceError(operation)(cause);

export class ActionGateService extends Context.Service<
  ActionGateService,
  {
    readonly putApproval: (
      record: ActionApprovalRecord,
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
    readonly appendAudit: (
      event: ActionAuditEventV0,
    ) => Effect.Effect<void, PersistenceSqlError | PersistenceDecodeError>;
    readonly governance: (
      environmentId: EnvironmentId,
      counts: {
        readonly configuredSkillCount: number;
        readonly enabledSkillCount: number;
        readonly configuredMcpServerCount: number;
        readonly enabledMcpServerCount: number;
        readonly degradedMcpServerCount: number;
      },
    ) => Effect.Effect<ActionGovernanceSnapshotV0, PersistenceSqlError | PersistenceDecodeError>;
    readonly authorizeTool: (input: {
      readonly toolName: string;
      readonly args: unknown;
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<
      ActionGateDecision,
      PersistenceSqlError | PersistenceDecodeError | ActionGateError
    >;
  }
>()("t3/actionGate/ActionGateService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getApproval: ActionGateService["Service"]["getApproval"] = (approvalId) =>
    sql<typeof ApprovalRow.Type>`
      SELECT approval_id AS "approvalId", payload_json AS "payloadJson"
      FROM action_gate_approvals
      WHERE approval_id = ${approvalId}
    `.pipe(
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (row === undefined) return Effect.succeed(Option.none());
        return decodeApproval(row.payloadJson).pipe(Effect.map(Option.some));
      }),
      Effect.mapError(toPersistenceError("ActionGateService.getApproval")),
    );

  const putApproval: ActionGateService["Service"]["putApproval"] = (record) =>
    Effect.gen(function* () {
      if (record.idempotencyKey !== undefined) {
        const existing = yield* sql<typeof ApprovalRow.Type>`
          SELECT approval_id AS "approvalId", payload_json AS "payloadJson"
          FROM action_gate_approvals
          WHERE idempotency_key = ${record.idempotencyKey}
        `.pipe(Effect.mapError(toError("ActionGateService.putApproval.idempotency")));
        const row = existing[0];
        if (row !== undefined) {
          const decoded = yield* decodeApproval(row.payloadJson);
          if (decoded.fingerprint !== record.fingerprint) {
            return yield* new ActionGateError({
              reason: "conflict",
              detail: "Idempotency key is bound to a different action fingerprint.",
            });
          }
          return decoded;
        }
      }
      const payloadJson = yield* encodeApproval(record);
      yield* sql`
        INSERT INTO action_gate_approvals (
          approval_id, environment_id, fingerprint, status, idempotency_key,
          created_at, expires_at, consumed_at, payload_json
        ) VALUES (
          ${record.approvalId}, ${record.environmentId}, ${record.fingerprint}, ${record.status},
          ${record.idempotencyKey ?? null}, ${record.createdAt}, ${record.expiresAt},
          ${record.consumedAt ?? null}, ${payloadJson}
        )
      `;
      return record;
    }).pipe(Effect.mapError(toError("ActionGateService.putApproval")));

  const writeStatus = (record: ActionApprovalRecord) =>
    encodeApproval(record).pipe(
      Effect.flatMap(
        (payloadJson) => sql`
          UPDATE action_gate_approvals
          SET status = ${record.status},
              consumed_at = ${record.consumedAt ?? null},
              payload_json = ${payloadJson}
          WHERE approval_id = ${record.approvalId}
        `,
      ),
    );

  const respond: ActionGateService["Service"]["respond"] = (input, nowIso) =>
    Effect.gen(function* () {
      const current = yield* getApproval(input.approvalId);
      if (Option.isNone(current)) {
        return yield* new ActionGateError({
          reason: "not_found",
          detail: "Approval was not found.",
        });
      }
      const record = current.value;
      if (record.status !== "pending" && record.status !== "granted") {
        return yield* new ActionGateError({
          reason: "conflict",
          detail: `Approval is already ${record.status}.`,
        });
      }
      const status =
        input.decision === "grant" ? "granted" : input.decision === "deny" ? "denied" : "cancelled";
      const next: ActionApprovalRecord = {
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
      yield* writeStatus(next);
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
      const record = current.value;
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
      return consumed;
    }).pipe(Effect.mapError(toError("ActionGateService.consume")));

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
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceError("ActionGateService.appendAudit")));

  const countStatus = (environmentId: EnvironmentId, status: string) =>
    sql<typeof CountRow.Type>`
      SELECT COUNT(*) AS "count" FROM action_gate_approvals
      WHERE environment_id = ${environmentId} AND status = ${status}
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

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
      const pending = yield* countStatus(environmentId, "pending");
      const denied = yield* countStatus(environmentId, "denied");
      const expired = yield* countStatus(environmentId, "expired");
      const recentOutcomes = yield* recentOutcomesFor(environmentId);
      return {
        environmentId,
        policyVersion: ACTION_GATE_POLICY_VERSION,
        ...counts,
        pendingApprovalCount: pending,
        deniedCount: denied,
        expiredCount: expired,
        recentOutcomes,
        preventedUnsafeCount: denied,
        knownCostUsd: MODEL_ROUTER_UNKNOWN_METRIC,
        estimatedCostUsd: MODEL_ROUTER_UNKNOWN_METRIC,
        compliance: pending > 0 ? ("attention" as const) : ("compliant" as const),
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
        }),
      );
      yield* appendAudit(
        makeActionAuditEvent({
          kind: "approval.requested",
          at: nowIso,
          environmentId: input.environmentId,
          planId: plan.planId,
          actionId: action.actionId,
          decision: "ASK",
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
