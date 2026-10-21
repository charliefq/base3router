// @effect-diagnostics nodeBuiltinImport:off - process-death evidence is written synchronously before exit.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  type CollaborationCommandResult,
  CollaborationCommand,
  ProjectId,
  CommandId,
  ThreadId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as CollaborationThreads from "../CollaborationThreads.ts";
import { sealCollaborationCommand, collaborationExecutionGate } from "../admit.ts";
import { readCollaborationSnapshot, readCommands, submitCollaborationCommand } from "../store.ts";

import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as Etag from "effect/unstable/http/Etag";
import { collaborationHttpApiLayer } from "../http.ts";
import { environmentAuthenticatedAuthLayer } from "../../auth/http.ts";
import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";

const [directory, phase] = process.argv.slice(2) as [string, string];
const at = "2026-10-12T00:00:00.000Z";
const instanceId = ProviderInstanceId.make("fake-codex");
let starts = 0;
const provider = (id: ProviderInstanceId): ServerProvider => ({
  instanceId: id,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: at,
  models: [{ slug: "fake-model", name: "Fake", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});
const adapter = (id: ProviderInstanceId) =>
  ({
    instanceId: id,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () =>
      Effect.sync(() => {
        starts++;
      }).pipe(Effect.andThen(Effect.die("execution disabled"))),
  }) as ProviderAdapterV2Shape;
const database = makeSqlitePersistenceLive(NodePath.join(directory, "state.sqlite")).pipe(
  Layer.provide(NodeServices.layer),
);
const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "collaboration-open-recovery", runtimePolicyOverride: { cwd: directory } },
  ProviderAdapterRegistry.makeLayer([
    adapter(instanceId),
    adapter(ProviderInstanceId.make("fake-other")),
  ]),
  { databaseLayer: database, runEffectWorker: false },
);
const management = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
const dependencies = Layer.mergeAll(
  database,
  management,
  ProjectStore.layer.pipe(Layer.provide(database)),
  makeProviderRegistryLayer([
    provider(instanceId),
    provider(ProviderInstanceId.make("fake-other")),
  ]),
  Layer.mock(ServerEnvironment)({
    getEnvironmentId: Effect.succeed(
      EnvironmentId.make(phase === "environment" ? "environment-b" : "environment-a"),
    ),
  }),
);
const runtime = Layer.mergeAll(
  database,
  management,
  CollaborationThreads.layer.pipe(Layer.provide(dependencies)),
);
const input = { projectId: "project-a", providerId: instanceId };
class CollaborationTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.collaboration,
) {}
const fakeCredentials = Layer.mock(EnvironmentAuth)({
  authenticateHttpRequest: (request) =>
    Effect.succeed({
      sessionId: AuthSessionId.make("fake-session"),
      subject: request.headers.authorization === "Bearer fake-b" ? "principal-b" : "principal-a",
      method: "bearer-access-token" as const,
      scopes:
        request.headers.authorization === "Bearer fake-read"
          ? [AuthOrchestrationReadScope]
          : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    }),
});
const routes = HttpApiBuilder.layer(CollaborationTestApi).pipe(
  Layer.provide(collaborationHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer.pipe(Layer.provide(fakeCredentials))),
  Layer.provide(dependencies),
  Layer.provideMerge(HttpPlatform.layer),
  Layer.provideMerge(Etag.layerWeak),
  Layer.provide(NodeServices.layer),
);
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(CollaborationCommand));
const decodeTarget = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String));
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const service = yield* CollaborationThreads.CollaborationThreads;
  for (const projectId of ["project-a", "project-b"])
    yield* sql`INSERT OR IGNORE INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Recovery', ${directory}, '[]', ${at}, ${at})`;
  if (phase === "collision" || phase === "legacy-collision") {
    yield* service.open("principal-a", input);
    const target = decodeTarget(
      NodeFS.readFileSync(NodePath.join(directory, "collision-target.json"), "utf8"),
    );
    const sealed = sealCollaborationCommand(
      {
        type: "delegate",
        commandId: "preexisting-cross-project-task",
        projectId: "project-a",
        toAgentId: instanceId,
        correlationId: `thread:${target}`,
        title: "Occupied identity",
        body: "Existing blocked project A work",
        acceptance: "Explicit repair required",
      },
      {
        principalId: "principal-a",
        projectIds: ["project-a", "project-b"],
        providers: [
          { id: instanceId, displayName: "codex", capabilities: ["fake-model"], executable: true },
        ],
        threads: [],
        executionGate: collaborationExecutionGate,
      },
    );
    if (sealed.outcome !== "sealed") return yield* Effect.die("failed collision fixture admission");
    const saved = yield* submitCollaborationCommand(sql, sealed.command);
    if (saved.outcome !== "applied")
      return yield* Effect.die("failed collision fixture persistence");
    if (phase === "legacy-collision") {
      const managementService = yield* ThreadManagement.ThreadManagementService;
      yield* managementService.dispatch({
        type: "thread.create",
        commandId: CommandId.make("legacy-project-b-create"),
        threadId: ThreadId.make(target),
        projectId: ProjectId.make("project-b"),
        title: "Legacy",
        modelSelection: { instanceId, model: "fake-model" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "server",
      });
      const legacy = sealCollaborationCommand(
        {
          type: "thread.bind",
          commandId: "legacy-project-b-bind",
          projectId: "project-b",
          threadId: target,
          agentId: instanceId,
        },
        {
          principalId: "principal-a",
          projectIds: ["project-a", "project-b"],
          providers: [
            {
              id: instanceId,
              displayName: "codex",
              capabilities: ["fake-model"],
              executable: true,
            },
          ],
          threads: [{ id: target, projectId: "project-b" }],
          executionGate: collaborationExecutionGate,
        },
      );
      if (legacy.outcome !== "sealed") return yield* Effect.die("failed legacy fixture admission");
      // Preserve a row accepted by the old implementation, without using the repaired admission path.
      yield* sql`INSERT INTO collaboration_commands (command_id, sequence, payload_json, created_at)
        VALUES ('legacy-project-b-bind', 3, ${yield* encodeCommand(legacy.command)}, ${at})`;
    }
  }
  if (phase === "partial")
    yield* sql`CREATE TEMP TRIGGER fail_bind BEFORE INSERT ON collaboration_commands
      BEGIN SELECT RAISE(ABORT, 'injected-bind-failure'); END`;
  if (phase === "archive" || phase === "delete") {
    const managementService = yield* ThreadManagement.ThreadManagementService;
    const prior = (yield* readCommands(sql))[0]!;
    yield* managementService.dispatch({
      type: phase === "archive" ? "thread.archive" : "thread.delete",
      commandId: CommandId.make(`test:${phase}`),
      threadId: ThreadId.make(prior.threadId!),
    });
  }
  let http = null;
  const httpResults =
    phase === "http"
      ? yield* Effect.acquireUseRelease(
          Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
          (server) =>
            Effect.tryPromise(async () => {
              const post = (token: string) =>
                server.handler(
                  new Request("http://127.0.0.1/api/collaboration/thread/open", {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      authorization: `Bearer ${token}`,
                    },
                    body: json({ ...input, admittedBy: "principal-b", actor: "agent" }),
                  }),
                );
              const denied = await post("fake-read");
              const responses = await Promise.all([post("fake-a"), post("fake-a")]);
              const other = await server.handler(
                new Request("http://127.0.0.1/api/collaboration", {
                  headers: { authorization: "Bearer fake-b" },
                }),
              );
              http = {
                denied: denied.status,
                statuses: responses.map((response) => response.status),
                otherSnapshot: await other.json(),
              };
              return await Promise.all(
                responses.map((response) => response.json() as Promise<CollaborationCommandResult>),
              );
            }),
          (server) => Effect.promise(() => server.dispose()),
        )
      : null;
  const results =
    httpResults ??
    (phase === "partial"
      ? [yield* service.open("principal-a", input).pipe(Effect.result)]
      : phase === "concurrent"
        ? yield* Effect.all(
            [service.open("principal-a", input), service.open("principal-a", input)],
            { concurrency: "unbounded" },
          )
        : phase === "partitions"
          ? yield* Effect.all(
              [
                service.open("principal-b", input),
                service.open("principal-a", { ...input, projectId: "project-b" }),
                service.open("principal-a", { ...input, providerId: "fake-other" }),
              ],
              { concurrency: "unbounded" },
            )
          : phase === "collision" || phase === "legacy-collision"
            ? [
                yield* service.open("principal-a", { ...input, projectId: "project-b" }),
                yield* service.open("principal-a", { ...input, projectId: "project-b" }),
              ]
            : [
                yield* service.open(
                  "principal-a",
                  phase === "seed-b" ? { ...input, projectId: "project-b" } : input,
                ),
              ]);
  const commands = yield* readCommands(sql);
  let replays = null;
  if (phase === "replay") {
    const prior = commands[0]!;
    replays = [
      yield* submitCollaborationCommand(sql, { ...prior, admittedBy: "principal-b" }),
      yield* submitCollaborationCommand(sql, { ...prior, title: "changed semantics" }),
      yield* submitCollaborationCommand(sql, {
        ...prior,
        admissionSource: undefined,
        admittedBy: undefined,
      }),
    ];
  }
  const counts = yield* sql<{
    threads: number;
    runs: number;
    messages: number;
    bindings: number;
  }>`SELECT
    (SELECT count(*) FROM orchestration_v2_projection_threads) AS threads,
    (SELECT count(*) FROM orchestration_v2_projection_runs) AS runs,
    (SELECT count(*) FROM orchestration_v2_projection_messages) AS messages,
    (SELECT count(*) FROM collaboration_commands WHERE json_extract(payload_json, '$.type') = 'thread.bind') AS bindings`;
  const providerEffects = yield* sql<{ readonly count: number }>`SELECT count(*) AS count
    FROM orchestration_v2_effect_outbox
    WHERE json_extract(payload_json, '$.type') IN ('provider-turn.start', 'provider-turn.restart', 'provider-turn.steer', 'provider-runtime.continue')`;
  NodeFS.writeFileSync(
    NodePath.join(directory, `${phase}.json`),
    yield* encodeReport({
      pid: process.pid,
      results,
      replays,
      http,
      counts: counts[0],
      starts,
      providerStartEffects: providerEffects[0]?.count ?? 0,
      principalA: yield* readCollaborationSnapshot(sql, "principal-a"),
      principalB: yield* readCollaborationSnapshot(sql, "principal-b"),
    }),
  );
  // Lost response/process death occurs after durable writes; no graceful teardown evidence.
  process.exit(phase === "partial" || phase === "lost" ? 77 : 0);
});
Effect.runPromise(program.pipe(Effect.provide(runtime))).catch((error: unknown) => {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
