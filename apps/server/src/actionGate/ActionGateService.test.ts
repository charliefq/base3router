import {
  ActionApprovalId,
  ActionGateError,
  ActionIdempotencyKey,
  EnvironmentId,
  McpActionGateBlockedError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createPendingApproval } from "@t3tools/shared/actionGate";
import { argumentSummary } from "@t3tools/shared/actionAudit";
import { buildExecutionPlan } from "@t3tools/shared/executionPlan";
import { firstPartyMcpCatalog } from "@t3tools/shared/mcpCatalog";
import { routeMcp } from "@t3tools/shared/mcpRouter";
import { routeSkills } from "@t3tools/shared/skillRouter";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { requireAllowedMcpTool } from "../mcp/McpActionAuthorization.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ActionGateService, layer as actionGateLayer } from "./ActionGateService.ts";

const isActionGateError = Schema.is(ActionGateError);
const isBlocked = Schema.is(McpActionGateBlockedError);

const layer = actionGateLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const environmentId = EnvironmentId.make("lab-environment");
const NOW = "2026-10-03T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

function plannedAction(expression = "1") {
  const skillRoute = routeSkills({
    mode: "auto",
    nowIso: NOW,
    catalog: [],
  });
  const mcpRoute = routeMcp({
    mode: "auto",
    nowIso: NOW,
    catalog: firstPartyMcpCatalog(NOW),
  });
  const plan = buildExecutionPlan({
    turnId: TurnId.make("turn-1"),
    threadId: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    environmentId,
    nowIso: NOW,
    modelRoute: null,
    skillRoute,
    mcpRoute,
    actions: [
      {
        serverId: "t3-preview",
        toolId: "t3-preview/preview_evaluate",
        arguments: { expression },
        schemaDigest: "schema",
        riskClass: "destructive",
        sideEffectClass: "network",
      },
    ],
  });
  const action = plan.actions[0];
  if (action === undefined) throw new Error("expected planned action");
  return { plan, action };
}

const invocation = Layer.succeed(
  McpInvocationContext.McpInvocationContext,
  McpInvocationContext.McpInvocationContext.of({
    environmentId,
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "session-1",
    providerInstanceId: ProviderInstanceId.make("provider-1"),
    capabilities: new Set(["preview", "device", "pull-requests"]),
    issuedAt: Date.parse(NOW),
  }),
);

it.effect("consumes a granted one-time approval once under concurrent callers", () =>
  Effect.gen(function* () {
    const service = yield* ActionGateService;
    const { plan, action } = plannedAction();
    const pending = createPendingApproval({
      approvalId: ActionApprovalId.make("apr-sql-1"),
      plan,
      action,
      nowIso: NOW,
      expiresAt: FUTURE,
      idempotencyKey: ActionIdempotencyKey.make("idem-sql-1"),
      argumentSummary: argumentSummary({ expression: "1" }),
    });
    yield* service.putApproval(pending);
    const granted = yield* service.respond(
      { approvalId: pending.approvalId, decision: "grant" },
      NOW,
    );
    assert.equal(granted.status, "granted");
    const [first, second] = yield* Effect.all(
      [
        service.consume(pending.approvalId, action.fingerprint, NOW).pipe(Effect.exit),
        service.consume(pending.approvalId, action.fingerprint, NOW).pipe(Effect.exit),
      ],
      { concurrency: 2 },
    );
    const succeeded = [first, second].filter(Exit.isSuccess);
    const failed = [first, second].filter(Exit.isFailure);
    assert.equal(succeeded.length, 1);
    assert.equal(failed.length, 1);
    const replay = yield* service
      .consume(pending.approvalId, action.fingerprint, "2026-10-03T00:00:01.000Z")
      .pipe(Effect.flip);
    assert.equal(isActionGateError(replay) && replay.reason === "replay", true);
    const snapshot = yield* service.governance(environmentId, {
      configuredSkillCount: 0,
      enabledSkillCount: 0,
      configuredMcpServerCount: 3,
      enabledMcpServerCount: 3,
      degradedMcpServerCount: 0,
    });
    assert.equal(snapshot.pendingApprovalCount, 0);
    assert.equal(snapshot.pending.length, 0);
    assert.equal(snapshot.knownCostUsd.status, "unknown");
    const allowed = yield* service.authorizeTool({
      toolName: "preview_status",
      args: {},
      environmentId,
      threadId: ThreadId.make("thread-1"),
    });
    assert.equal(allowed.decision, "ALLOW");
    const asked = yield* service.authorizeTool({
      toolName: "preview_open",
      args: { url: "https://example.test" },
      environmentId,
      threadId: ThreadId.make("thread-1"),
    });
    assert.equal(asked.decision, "ASK");
    assert.equal(asked.requiresApproval, true);
  }).pipe(Effect.provide(layer)),
);

it.effect("putApproval is atomically idempotent under concurrent identical requests", () =>
  Effect.gen(function* () {
    const service = yield* ActionGateService;
    const { plan, action } = plannedAction("concurrent");
    const pending = createPendingApproval({
      approvalId: ActionApprovalId.make("apr-idem-same"),
      plan,
      action,
      nowIso: NOW,
      expiresAt: FUTURE,
      idempotencyKey: ActionIdempotencyKey.make("idem-same-fp"),
      argumentSummary: argumentSummary({ expression: "concurrent" }),
    });
    const [first, second] = yield* Effect.all(
      [service.putApproval(pending), service.putApproval(pending)],
      { concurrency: 2 },
    );
    assert.equal(first.approvalId, second.approvalId);
    assert.equal(first.fingerprint, action.fingerprint);
    const snapshot = yield* service.governance(environmentId, {
      configuredSkillCount: 0,
      enabledSkillCount: 0,
      configuredMcpServerCount: 0,
      enabledMcpServerCount: 0,
      degradedMcpServerCount: 0,
    });
    assert.equal(snapshot.pendingApprovalCount, 1);
    assert.equal(snapshot.pending.length, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("concurrent conflicting idempotency keys never silently reuse an approval", () =>
  Effect.gen(function* () {
    const service = yield* ActionGateService;
    const firstAction = plannedAction("left");
    const secondAction = plannedAction("right");
    const key = ActionIdempotencyKey.make("idem-conflict");
    const left = createPendingApproval({
      approvalId: ActionApprovalId.make("apr-conflict-a"),
      plan: firstAction.plan,
      action: firstAction.action,
      nowIso: NOW,
      expiresAt: FUTURE,
      idempotencyKey: key,
    });
    const right = createPendingApproval({
      approvalId: ActionApprovalId.make("apr-conflict-b"),
      plan: secondAction.plan,
      action: secondAction.action,
      nowIso: NOW,
      expiresAt: FUTURE,
      idempotencyKey: key,
    });
    const [first, second] = yield* Effect.all(
      [service.putApproval(left).pipe(Effect.exit), service.putApproval(right).pipe(Effect.exit)],
      { concurrency: 2 },
    );
    const succeeded = [first, second].filter(Exit.isSuccess);
    const failed = [first, second].filter(Exit.isFailure);
    assert.equal(succeeded.length, 1);
    assert.equal(failed.length, 1);
    const loser = failed[0];
    if (loser === undefined || !Exit.isFailure(loser)) {
      assert.equal(true, false, "expected one winner and one conflict");
      return;
    }
    const flipped = yield* Effect.failCause(loser.cause).pipe(Effect.flip);
    assert.equal(isActionGateError(flipped) && flipped.reason === "conflict", true);
  }).pipe(Effect.provide(layer)),
);

it.effect("does not resurrect consumed, denied, cancelled, or expired approvals", () =>
  Effect.gen(function* () {
    const service = yield* ActionGateService;
    const { plan, action } = plannedAction("resurrect");
    const pending = createPendingApproval({
      approvalId: ActionApprovalId.make("apr-dead"),
      plan,
      action,
      nowIso: NOW,
      expiresAt: FUTURE,
      idempotencyKey: ActionIdempotencyKey.make("idem-dead"),
    });
    yield* service.putApproval(pending);
    yield* service.respond({ approvalId: pending.approvalId, decision: "deny" }, NOW);
    const again = yield* service.putApproval(pending).pipe(Effect.flip);
    assert.equal(isActionGateError(again) && again.reason === "conflict", true);
  }).pipe(Effect.provide(layer)),
);

it.effect("grant resumes the waiting action exactly once", () =>
  Effect.gen(function* () {
    const service = yield* ActionGateService;
    let executions = 0;
    const asked = yield* service.authorizeTool({
      toolName: "preview_open",
      args: { url: "https://example.test/grant" },
      environmentId,
      threadId: ThreadId.make("thread-1"),
    });
    assert.equal(asked.decision, "ASK");
    const approvalId = asked.approvalId;
    if (approvalId === undefined) {
      assert.equal(asked.requiresApproval, true, "expected approval");
      return;
    }
    const current = yield* service.getApproval(approvalId);
    const nowIso = current._tag === "Some" ? current.value.createdAt : NOW;
    const snapshot = yield* service.governance(environmentId, {
      configuredSkillCount: 0,
      enabledSkillCount: 0,
      configuredMcpServerCount: 3,
      enabledMcpServerCount: 3,
      degradedMcpServerCount: 0,
    });
    assert.equal(snapshot.pending.length, 1);
    assert.equal(snapshot.pending[0]?.serverId, "t3-preview");
    assert.equal(snapshot.pending[0]?.toolId.includes("preview_open"), true);
    const waiter = service.waitForAuthorized(approvalId, asked.fingerprint, nowIso).pipe(
      Effect.map((consumed) => {
        executions += 1;
        return consumed;
      }),
      Effect.exit,
    );
    const [waited, granted] = yield* Effect.all(
      [waiter, service.respond({ approvalId, decision: "grant" }, nowIso).pipe(Effect.exit)],
      { concurrency: 2 },
    );
    assert.equal(Exit.isSuccess(granted), true);
    assert.equal(Exit.isSuccess(waited), true);
    assert.equal(executions, 1);
    const replay = yield* service
      .waitForAuthorized(approvalId, asked.fingerprint, nowIso)
      .pipe(Effect.flip);
    assert.equal(isActionGateError(replay) && replay.reason === "replay", true);
    assert.equal(executions, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("deny, expire, and cancel execute the tool zero times", () =>
  Effect.gen(function* () {
    const service = yield* ActionGateService;
    const denyAsk = yield* service.authorizeTool({
      toolName: "preview_open",
      args: { url: "https://example.test/deny" },
      environmentId,
      threadId: ThreadId.make("thread-deny"),
    });
    const denyId = denyAsk.approvalId;
    if (denyId === undefined) {
      assert.equal(denyAsk.requiresApproval, true, "expected deny approval");
      return;
    }
    const denyRecord = yield* service.getApproval(denyId);
    const denyNow = denyRecord._tag === "Some" ? denyRecord.value.createdAt : NOW;
    let denyExec = 0;
    const [deniedWait] = yield* Effect.all(
      [
        service.waitForAuthorized(denyId, denyAsk.fingerprint, denyNow).pipe(
          Effect.map(() => {
            denyExec += 1;
          }),
          Effect.exit,
        ),
        service.respond({ approvalId: denyId, decision: "deny" }, denyNow),
      ],
      { concurrency: 2 },
    );
    assert.equal(Exit.isFailure(deniedWait), true);
    assert.equal(denyExec, 0);

    const cancelAsk = yield* service.authorizeTool({
      toolName: "preview_open",
      args: { url: "https://example.test/cancel" },
      environmentId,
      threadId: ThreadId.make("thread-cancel"),
    });
    const cancelId = cancelAsk.approvalId;
    if (cancelId === undefined) {
      assert.equal(cancelAsk.requiresApproval, true, "expected cancel approval");
      return;
    }
    const cancelRecord = yield* service.getApproval(cancelId);
    const cancelNow = cancelRecord._tag === "Some" ? cancelRecord.value.createdAt : NOW;
    let cancelExec = 0;
    const [cancelledWait] = yield* Effect.all(
      [
        service.waitForAuthorized(cancelId, cancelAsk.fingerprint, cancelNow).pipe(
          Effect.map(() => {
            cancelExec += 1;
          }),
          Effect.exit,
        ),
        service.respond({ approvalId: cancelId, decision: "cancel" }, cancelNow),
      ],
      { concurrency: 2 },
    );
    assert.equal(Exit.isFailure(cancelledWait), true);
    assert.equal(cancelExec, 0);

    const { plan, action } = plannedAction("expire");
    const expired = createPendingApproval({
      approvalId: ActionApprovalId.make("apr-expire"),
      plan,
      action,
      nowIso: NOW,
      expiresAt: NOW,
      idempotencyKey: ActionIdempotencyKey.make("idem-expire"),
    });
    yield* service.putApproval(expired);
    let expireExec = 0;
    const expiredWait = yield* service
      .waitForAuthorized(expired.approvalId, action.fingerprint, FUTURE)
      .pipe(
        Effect.map(() => {
          expireExec += 1;
        }),
        Effect.exit,
      );
    assert.equal(Exit.isFailure(expiredWait), true);
    assert.equal(expireExec, 0);
    const lateGrant = yield* service
      .respond({ approvalId: expired.approvalId, decision: "grant" }, FUTURE)
      .pipe(Effect.flip);
    assert.equal(isActionGateError(lateGrant), true);
  }).pipe(Effect.provide(layer)),
);

it.effect("changed arguments cannot resume the previous approval", () =>
  Effect.gen(function* () {
    const service = yield* ActionGateService;
    const first = yield* service.authorizeTool({
      toolName: "preview_open",
      args: { url: "https://example.test/a" },
      environmentId,
      threadId: ThreadId.make("thread-1"),
    });
    const second = yield* service.authorizeTool({
      toolName: "preview_open",
      args: { url: "https://example.test/b" },
      environmentId,
      threadId: ThreadId.make("thread-1"),
    });
    assert.equal(first.fingerprint === second.fingerprint, false);
    assert.equal(first.approvalId === second.approvalId, false);
    const firstId = first.approvalId;
    if (firstId === undefined) {
      assert.equal(first.requiresApproval, true, "expected first approval");
      return;
    }
    const firstRecord = yield* service.getApproval(firstId);
    const firstNow = firstRecord._tag === "Some" ? firstRecord.value.createdAt : NOW;
    yield* service.respond({ approvalId: firstId, decision: "grant" }, firstNow);
    const mismatch = yield* service
      .consume(firstId, second.fingerprint, firstNow)
      .pipe(Effect.flip);
    assert.equal(isActionGateError(mismatch) && mismatch.reason === "conflict", true);
  }).pipe(Effect.provide(layer)),
);

it.effect("simultaneous grants execute once and grant-versus-deny has one winner", () =>
  Effect.gen(function* () {
    const service = yield* ActionGateService;
    const asked = yield* service.authorizeTool({
      toolName: "preview_evaluate",
      args: { expression: "1" },
      environmentId,
      threadId: ThreadId.make("thread-1"),
    });
    const approvalId = asked.approvalId;
    if (approvalId === undefined) {
      assert.equal(asked.requiresApproval, true, "expected approval");
      return;
    }
    const current = yield* service.getApproval(approvalId);
    const nowIso = current._tag === "Some" ? current.value.createdAt : NOW;
    const [grantA, grantB] = yield* Effect.all(
      [
        service.respond({ approvalId, decision: "grant" }, nowIso).pipe(Effect.exit),
        service.respond({ approvalId, decision: "grant" }, nowIso).pipe(Effect.exit),
      ],
      { concurrency: 2 },
    );
    const grantSuccesses = [grantA, grantB].filter(Exit.isSuccess);
    assert.equal(grantSuccesses.length >= 1, true);
    const [consumeA, consumeB] = yield* Effect.all(
      [
        service.consume(approvalId, asked.fingerprint, nowIso).pipe(Effect.exit),
        service.consume(approvalId, asked.fingerprint, nowIso).pipe(Effect.exit),
      ],
      { concurrency: 2 },
    );
    assert.equal([consumeA, consumeB].filter(Exit.isSuccess).length, 1);
    assert.equal([consumeA, consumeB].filter(Exit.isFailure).length, 1);

    const raced = yield* service.authorizeTool({
      toolName: "preview_evaluate",
      args: { expression: "2" },
      environmentId,
      threadId: ThreadId.make("thread-1"),
    });
    const racedId = raced.approvalId;
    if (racedId === undefined) {
      assert.equal(raced.requiresApproval, true, "expected raced approval");
      return;
    }
    const racedRecord = yield* service.getApproval(racedId);
    const racedNow = racedRecord._tag === "Some" ? racedRecord.value.createdAt : NOW;
    const [grant, deny] = yield* Effect.all(
      [
        service.respond({ approvalId: racedId, decision: "grant" }, racedNow).pipe(Effect.exit),
        service.respond({ approvalId: racedId, decision: "deny" }, racedNow).pipe(Effect.exit),
      ],
      { concurrency: 2 },
    );
    const terminals = [grant, deny].filter(Exit.isSuccess);
    assert.equal(terminals.length, 1);
    const winner = terminals[0];
    if (winner === undefined || !Exit.isSuccess(winner)) {
      assert.equal(true, false, "expected one terminal decision");
      return;
    }
    if (winner.value.status === "granted") {
      const consumed = yield* service.consume(racedId, raced.fingerprint, racedNow);
      assert.equal(consumed.status, "consumed");
    } else {
      const blocked = yield* service
        .consume(racedId, raced.fingerprint, racedNow)
        .pipe(Effect.flip);
      assert.equal(isActionGateError(blocked), true);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("ASK blocks MCP tool execution until grant and redacts secrets", () =>
  Effect.gen(function* () {
    const service = yield* ActionGateService;
    let executions = 0;
    const run = Effect.gen(function* () {
      yield* requireAllowedMcpTool("preview_open", {
        url: "https://example.test",
        token: "sk-secret-material",
      });
      executions += 1;
      return "ran";
    });
    const asked = yield* service.authorizeTool({
      toolName: "preview_open",
      args: { url: "https://example.test", token: "sk-secret-material" },
      environmentId,
      threadId: ThreadId.make("thread-1"),
    });
    assert.equal(asked.decision, "ASK");
    const approvalId = asked.approvalId;
    if (approvalId === undefined) {
      assert.equal(asked.requiresApproval, true, "expected approval");
      return;
    }
    const snapshot = yield* service.governance(environmentId, {
      configuredSkillCount: 0,
      enabledSkillCount: 0,
      configuredMcpServerCount: 3,
      enabledMcpServerCount: 3,
      degradedMcpServerCount: 0,
    });
    const pending = snapshot.pending[0];
    assert.equal(pending !== undefined, true);
    assert.equal(pending?.argumentSummary?.includes("sk-secret"), false);
    assert.equal(pending?.askExplanation?.includes("sk-secret"), false);
    const waiter = run.pipe(Effect.exit);
    const [blocked, granted] = yield* Effect.all(
      [
        waiter,
        service
          .respond({ approvalId, decision: "grant" }, pending?.createdAt ?? NOW)
          .pipe(Effect.exit),
      ],
      { concurrency: 2 },
    );
    assert.equal(Exit.isSuccess(granted), true);
    assert.equal(Exit.isSuccess(blocked), true);
    assert.equal(executions, 1);
    const replay = yield* run.pipe(Effect.exit);
    assert.equal(Exit.isFailure(replay), true);
    if (Exit.isFailure(replay)) {
      const error = yield* Effect.failCause(replay.cause).pipe(Effect.flip);
      assert.equal(isBlocked(error), true);
    }
    assert.equal(executions, 1);
  }).pipe(Effect.provide(Layer.merge(layer, invocation))),
);
