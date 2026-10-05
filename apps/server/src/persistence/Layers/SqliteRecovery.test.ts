// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ActionApprovalId,
  ActionGateError,
  ActionIdempotencyKey,
  DEFAULT_DREAM_MEMORY_SETTINGS,
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
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ActionGateService, layer as actionGateLayer } from "../../actionGate/ActionGateService.ts";
import {
  DreamMemoryService,
  layer as dreamMemoryLayer,
  viewerFromSubject,
} from "../../dreamMemory/DreamMemoryService.ts";
import { runMigrations } from "../Migrations.ts";
import { makeSqlitePersistenceLive } from "./Sqlite.ts";

const environmentId = EnvironmentId.make("lab-environment");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const NOW = "2026-10-03T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const alice = viewerFromSubject(environmentId, "alice@example.com", projectId);
const settings = DEFAULT_DREAM_MEMORY_SETTINGS;

const inspectRowsSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const rows = db.prepare("SELECT approval_id AS approvalId, status FROM action_gate_approvals").all();
process.stdout.write(JSON.stringify(rows));
db.close();
`;

const isActionGateError = Schema.is(ActionGateError);

const plannedAction = () => {
  const plan = buildExecutionPlan({
    turnId: TurnId.make("turn-1"),
    threadId,
    projectId,
    environmentId,
    nowIso: NOW,
    modelRoute: null,
    skillRoute: routeSkills({ mode: "auto", nowIso: NOW, catalog: [] }),
    mcpRoute: routeMcp({ mode: "auto", nowIso: NOW, catalog: firstPartyMcpCatalog(NOW) }),
    actions: [
      {
        serverId: "t3-preview",
        toolId: "t3-preview/preview_open",
        arguments: { url: "https://example.test/restart" },
        schemaDigest: "schema",
        riskClass: "network-access",
        sideEffectClass: "network",
      },
    ],
  });
  const action = plan.actions[0];
  if (action === undefined) throw new Error("expected planned action");
  return { plan, action };
};

const withTempDb = <A, E, R>(
  use: (
    dbPath: string,
    persistence: ReturnType<typeof makeSqlitePersistenceLive>,
  ) => Effect.Effect<A, E, R>,
) => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recovery-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
  return use(dbPath, persistence).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
};

it.effect("pending approvals survive process restart on a disposable file database", () =>
  withTempDb((dbPath, persistence) =>
    Effect.gen(function* () {
      const { plan, action } = plannedAction();
      const pending = createPendingApproval({
        approvalId: ActionApprovalId.make("apr-restart"),
        plan,
        action,
        nowIso: NOW,
        expiresAt: FUTURE,
        idempotencyKey: ActionIdempotencyKey.make("idem-restart"),
      });
      yield* ActionGateService.pipe(
        Effect.flatMap((service) => service.putApproval(pending)),
        Effect.provide(actionGateLayer.pipe(Layer.provideMerge(persistence))),
      );
      const child = NodeChildProcess.spawnSync(
        process.execPath,
        ["-e", inspectRowsSource, dbPath],
        {
          encoding: "utf8",
        },
      );
      assert.equal(child.status, 0);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const inspected = JSON.parse(child.stdout) as ReadonlyArray<{
        readonly approvalId: string;
        readonly status: string;
      }>;
      assert.equal(inspected[0]?.status, "pending");
      const restored = yield* ActionGateService.pipe(
        Effect.flatMap((service) => service.getApproval(pending.approvalId)),
        Effect.provide(actionGateLayer.pipe(Layer.provideMerge(persistence))),
      );
      assert.equal(restored._tag === "Some" && restored.value.status === "pending", true);
    }),
  ),
);

it.effect("does not auto-replay an ambiguous write after restart", () =>
  withTempDb((dbPath, persistence) =>
    Effect.gen(function* () {
      const markerPath = `${dbPath}.external-write`;
      const layer = actionGateLayer.pipe(Layer.provideMerge(persistence));
      yield* Effect.gen(function* () {
        const service = yield* ActionGateService;
        const asked = yield* service.authorizeTool({
          toolName: "preview_open",
          args: { url: "https://example.test/crash-write" },
          environmentId,
          threadId,
        });
        const approvalId = asked.approvalId;
        if (approvalId === undefined) return;
        const stored = yield* service.getApproval(approvalId);
        const nowIso = stored._tag === "Some" ? stored.value.createdAt : NOW;
        yield* service.respond({ approvalId, decision: "grant" }, nowIso);
        yield* service.waitForAuthorized(approvalId, asked.fingerprint, nowIso);
        NodeFS.writeFileSync(markerPath, "1");
      }).pipe(Effect.provide(layer));
      assert.equal(NodeFS.readFileSync(markerPath, "utf8"), "1");
      const replay = yield* Effect.gen(function* () {
        const service = yield* ActionGateService;
        return yield* service.authorizeTool({
          toolName: "preview_open",
          args: { url: "https://example.test/crash-write" },
          environmentId,
          threadId,
        });
      }).pipe(Effect.provide(layer), Effect.flip);
      assert.equal(isActionGateError(replay) && replay.reason === "conflict", true);
      assert.equal(NodeFS.readFileSync(markerPath, "utf8"), "1");
    }),
  ),
);

it.effect("memory deletion and source invalidation survive restart", () =>
  withTempDb((_dbPath, persistence) =>
    Effect.gen(function* () {
      const layer = dreamMemoryLayer.pipe(Layer.provideMerge(persistence));
      const memoryId = yield* Effect.gen(function* () {
        const service = yield* DreamMemoryService;
        const saved = yield* service.save(
          {
            content: "Prefer conventional commits.",
            kind: "workflow-convention",
            scopeKind: "project",
            projectId,
            threadId,
          },
          alice,
          NOW,
          settings,
        );
        yield* service.remove({ memoryId: saved.memory.memoryId }, alice, NOW);
        yield* service.invalidateSourceThread(environmentId, threadId, NOW);
        return saved.memory.memoryId;
      }).pipe(Effect.provide(layer));
      yield* Effect.gen(function* () {
        const service = yield* DreamMemoryService;
        const listed = yield* service.list({ projectId }, alice);
        assert.equal(
          listed.memories.some((memory) => memory.memoryId === memoryId && memory.contentPresent),
          false,
        );
        yield* service.enqueueEligibleTurn({
          viewer: alice,
          settings,
          turnSucceeded: true,
          turnText: "Prefer conventional commits.",
          nowIso: NOW,
          threadId,
        });
        const afterDream = yield* service.list({ projectId }, alice);
        assert.equal(
          afterDream.memories.some((memory) => memory.content === "Prefer conventional commits."),
          false,
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("upgrades an older file-backed schema and restores a compatible backup", () =>
  withTempDb((dbPath, persistence) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 61 });
        yield* runMigrations();
        const tables = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('action_gate_approvals', 'dream_memories')
        `;
        assert.equal(tables.length, 2);
        yield* sql`VACUUM INTO ${`${dbPath}.backup`}`;
      }).pipe(Effect.provide(persistence));
      const backupPath = `${dbPath}.backup`;
      assert.equal(NodeFS.existsSync(backupPath), true);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const integrity = yield* sql<{ readonly integrity_check: string }>`PRAGMA integrity_check`;
        assert.equal(integrity[0]?.integrity_check, "ok");
      }).pipe(
        Effect.provide(
          makeSqlitePersistenceLive(backupPath).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
    }),
  ),
);
