import {
  ActionApprovalId,
  ActionGateError,
  ActionIdempotencyKey,
  EnvironmentId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createPendingApproval } from "@t3tools/shared/actionGate";
import { buildExecutionPlan } from "@t3tools/shared/executionPlan";
import { firstPartyMcpCatalog } from "@t3tools/shared/mcpCatalog";
import { routeMcp } from "@t3tools/shared/mcpRouter";
import { routeSkills } from "@t3tools/shared/skillRouter";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ActionGateService, layer as actionGateLayer } from "./ActionGateService.ts";

const layer = actionGateLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const environmentId = EnvironmentId.make("lab-environment");
const NOW = "2026-10-03T00:00:00.000Z";

function plannedAction() {
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
        arguments: { expression: "1" },
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

it.effect("consumes a granted one-time approval once under concurrent callers", () =>
  Effect.gen(function* () {
    const service = yield* ActionGateService;
    const { plan, action } = plannedAction();
    const pending = createPendingApproval({
      approvalId: ActionApprovalId.make("apr-sql-1"),
      plan,
      action,
      nowIso: NOW,
      expiresAt: "2026-10-03T00:01:00.000Z",
      idempotencyKey: ActionIdempotencyKey.make("idem-sql-1"),
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
    assert.equal(Schema.is(ActionGateError)(replay) && replay.reason === "replay", true);
    const snapshot = yield* service.governance(environmentId, {
      configuredSkillCount: 0,
      enabledSkillCount: 0,
      configuredMcpServerCount: 3,
      enabledMcpServerCount: 3,
      degradedMcpServerCount: 0,
    });
    assert.equal(snapshot.pendingApprovalCount, 0);
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
